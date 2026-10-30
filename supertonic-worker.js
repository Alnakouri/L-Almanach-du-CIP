// supertonic-worker.js — utilityProcess dédié à la synthèse Supertonic (v9.22.0).
// Avant : la synthèse tournait en WASM mono-thread DANS le renderer → gel de l'UI
// (~11 s pour une phrase à froid). Ce worker isole onnxruntime-node (CPU natif) dans un
// process Node séparé : ~10× plus rapide (RTF ~0,12) ET hors du thread UI → zéro gel.
// Port de la logique de js/tts/engines/supertonic-helper.js (validé par spike Node 07/07).
// Protocole : reçoit { type:'synth', requestId, text, voiceId, lang, totalStep, speed, warm }
// via process.parentPort ; répond { type:'result', requestId, result:{ ok, wavBytes?, sampleRate?, audioDuration?, error? } }.
const path = require('path');
const fs = require('fs');
const ort = require('onnxruntime-node');

const ONNX_DIR = path.join(__dirname, 'assets/models/supertonic/onnx');
const STYLES_DIR = path.join(__dirname, 'assets/models/supertonic/voice_styles');
const SPEED_DEFAULT = 1.05;

const post = (msg) => process.parentPort.postMessage(msg);

const AVAILABLE_LANGS = ['en','ko','ja','ar','bg','cs','da','de','el','es','et','fi','fr','hi','hr','hu','id','it','lt','lv','nl','pl','pt','ro','ru','sk','sl','sv','tr','uk','vi'];
const isValidLang = (l) => AVAILABLE_LANGS.includes(l);

let _sessions = null;   // { dpOrt, textEncOrt, vectorEstOrt, vocoderOrt }
let _cfgs = null;
let _indexer = null;
const _styles = new Map();   // voiceId → { ttl, dp }

function lengthToMask(lengths, maxLen = null) {
    const M = maxLen || Math.max(...lengths);
    return lengths.map(len => { const row = new Array(M).fill(0.0); for (let j = 0; j < Math.min(len, M); j++) row[j] = 1.0; return [row]; });
}

function preprocessText(text, lang) {
    text = text.normalize('NFKD');
    const emoji = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]+/gu;
    text = text.replace(emoji, '');
    const rep = { '–':'-','—':'-','_':' ','“':'"','”':'"','‘':"'",'’':"'",'[':' ',']':' ','|':' ','/':' ','#':' ' };
    for (const [k, v] of Object.entries(rep)) text = text.replaceAll(k, v);
    text = text.replace(/\s+/g, ' ').trim();
    if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(text)) text += '.';
    if (!isValidLang(lang)) throw new Error('Invalid language: ' + lang);
    return `<${lang}>${text}</${lang}>`;
}

function processText(textList, langList) {
    const processed = textList.map((t, i) => preprocessText(t, langList[i]));
    const lens = processed.map(t => t.length);
    const maxLen = Math.max(...lens);
    const textIds = processed.map(text => {
        const row = new Array(maxLen).fill(0);
        for (let j = 0; j < text.length; j++) { const cp = text.codePointAt(j); row[j] = (cp < _indexer.length) ? _indexer[cp] : -1; }
        return row;
    });
    return { textIds, textMask: lengthToMask(lens, maxLen) };
}

function sampleNoisyLatent(duration, sampleRate, baseChunkSize, chunkCompress, latentDim) {
    const bsz = duration.length;
    const wavLenMax = Math.floor(Math.max(...duration) * sampleRate);
    const wavLengths = duration.map(d => Math.floor(d * sampleRate));
    const chunkSize = baseChunkSize * chunkCompress;
    const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
    const latentDimVal = latentDim * chunkCompress;
    const xt = [];
    for (let b = 0; b < bsz; b++) { const batch = []; for (let d = 0; d < latentDimVal; d++) { const row = []; for (let t = 0; t < latentLen; t++) { const u1 = Math.max(0.0001, Math.random()); const u2 = Math.random(); row.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)); } batch.push(row); } xt.push(batch); }
    const latentLengths = wavLengths.map(len => Math.floor((len + chunkSize - 1) / chunkSize));
    const latentMask = lengthToMask(latentLengths, latentLen);
    for (let b = 0; b < bsz; b++) for (let d = 0; d < latentDimVal; d++) for (let t = 0; t < latentLen; t++) xt[b][d][t] *= latentMask[b][0][t];
    return { xt, latentMask };
}

async function infer(textList, langList, style, totalStep, speed) {
    const bsz = textList.length;
    const { textIds, textMask } = processText(textList, langList);
    const textIdsTensor = new ort.Tensor('int64', new BigInt64Array(textIds.flat().map(x => BigInt(x))), [bsz, textIds[0].length]);
    const textMaskTensor = new ort.Tensor('float32', new Float32Array(textMask.flat(2)), [bsz, 1, textMask[0][0].length]);

    const dpOut = await _sessions.dpOrt.run({ text_ids: textIdsTensor, style_dp: style.dp, text_mask: textMaskTensor });
    const duration = Array.from(dpOut.duration.data);
    for (let i = 0; i < duration.length; i++) duration[i] /= speed;

    const textEncOut = await _sessions.textEncOrt.run({ text_ids: textIdsTensor, style_ttl: style.ttl, text_mask: textMaskTensor });
    const textEmb = textEncOut.text_emb;

    let { xt, latentMask } = sampleNoisyLatent(duration, _cfgs.ae.sample_rate, _cfgs.ae.base_chunk_size, _cfgs.ttl.chunk_compress_factor, _cfgs.ttl.latent_dim);
    const latentMaskTensor = new ort.Tensor('float32', new Float32Array(latentMask.flat(2)), [bsz, 1, latentMask[0][0].length]);
    const totalStepTensor = new ort.Tensor('float32', new Float32Array(bsz).fill(totalStep), [bsz]);

    for (let step = 0; step < totalStep; step++) {
        const currentStepTensor = new ort.Tensor('float32', new Float32Array(bsz).fill(step), [bsz]);
        const xtTensor = new ort.Tensor('float32', new Float32Array(xt.flat(2)), [bsz, xt[0].length, xt[0][0].length]);
        const veOut = await _sessions.vectorEstOrt.run({ noisy_latent: xtTensor, text_emb: textEmb, style_ttl: style.ttl, latent_mask: latentMaskTensor, text_mask: textMaskTensor, current_step: currentStepTensor, total_step: totalStepTensor });
        const denoised = Array.from(veOut.denoised_latent.data);
        const latentDim = xt[0].length, latentLen = xt[0][0].length;
        xt = []; let idx = 0;
        for (let b = 0; b < bsz; b++) { const batch = []; for (let d = 0; d < latentDim; d++) { const row = []; for (let t = 0; t < latentLen; t++) row.push(denoised[idx++]); batch.push(row); } xt.push(batch); }
    }
    const finalXtTensor = new ort.Tensor('float32', new Float32Array(xt.flat(2)), [bsz, xt[0].length, xt[0][0].length]);
    const vocOut = await _sessions.vocoderOrt.run({ latent: finalXtTensor });
    return { wav: Array.from(vocOut.wav_tts.data), duration };
}

function chunkText(text, maxLen) {
    const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim());
    const chunks = [];
    for (let paragraph of paragraphs) {
        paragraph = paragraph.trim(); if (!paragraph) continue;
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        let cur = '';
        for (const s of sentences) {
            if (cur.length + s.length + 1 <= maxLen) cur += (cur ? ' ' : '') + s;
            else { if (cur) chunks.push(cur.trim()); cur = s; }
        }
        if (cur) chunks.push(cur.trim());
    }
    return chunks.length ? chunks : [text.trim()];
}

async function synthesizeFull(text, lang, style, totalStep, speed, silenceDuration = 0.3) {
    const maxLen = (lang === 'ko' || lang === 'ja') ? 120 : 300;
    const textList = chunkText(text, maxLen);
    let wavCat = [], durCat = 0;
    for (let i = 0; i < textList.length; i++) {
        const { wav, duration } = await infer([textList[i]], [lang], style, totalStep, speed);
        if (wavCat.length === 0) { wavCat = wav; durCat = duration[0]; }
        else { const silence = new Array(Math.floor(silenceDuration * _cfgs.ae.sample_rate)).fill(0); wavCat = [...wavCat, ...silence, ...wav]; durCat += duration[0] + silenceDuration; }
    }
    return { wav: wavCat, duration: durCat };
}

function writeWavFile(audioData, sampleRate) {
    const dataSize = audioData.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ws(36, 'data'); view.setUint32(40, dataSize, true);
    const int16 = new Int16Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) { const c = Math.max(-1, Math.min(1, audioData[i])); int16[i] = Math.floor(c * 32767); }
    new Uint8Array(buffer, 44).set(new Uint8Array(int16.buffer));
    return Buffer.from(buffer);
}

async function ensureLoaded() {
    if (_sessions) return;
    _cfgs = JSON.parse(fs.readFileSync(path.join(ONNX_DIR, 'tts.json'), 'utf8'));
    _indexer = JSON.parse(fs.readFileSync(path.join(ONNX_DIR, 'unicode_indexer.json'), 'utf8'));
    const opts = { graphOptimizationLevel: 'all' };
    _sessions = {
        dpOrt: await ort.InferenceSession.create(path.join(ONNX_DIR, 'duration_predictor.onnx'), opts),
        textEncOrt: await ort.InferenceSession.create(path.join(ONNX_DIR, 'text_encoder.onnx'), opts),
        vectorEstOrt: await ort.InferenceSession.create(path.join(ONNX_DIR, 'vector_estimator.onnx'), opts),
        vocoderOrt: await ort.InferenceSession.create(path.join(ONNX_DIR, 'vocoder.onnx'), opts),
    };
}

function getStyle(voiceId) {
    if (_styles.has(voiceId)) return _styles.get(voiceId);
    const vs = JSON.parse(fs.readFileSync(path.join(STYLES_DIR, voiceId + '.json'), 'utf8'));
    const style = {
        ttl: new ort.Tensor('float32', new Float32Array(vs.style_ttl.data.flat(Infinity)), [1, vs.style_ttl.dims[1], vs.style_ttl.dims[2]]),
        dp: new ort.Tensor('float32', new Float32Array(vs.style_dp.data.flat(Infinity)), [1, vs.style_dp.dims[1], vs.style_dp.dims[2]]),
    };
    _styles.set(voiceId, style);
    return style;
}

async function handleSynth(msg) {
    const { requestId } = msg;
    try {
        await ensureLoaded();
        const lang = (typeof msg.lang === 'string' && msg.lang.trim()) ? msg.lang.trim() : 'fr';
        const totalStep = msg.totalStep || 8;   // v9.23.0 : défaut aligné sur SUPERTONIC_STEPS (engine)
        const speed = msg.speed || SPEED_DEFAULT;
        const style = getStyle(msg.voiceId);
        // Warmup : on synthétise 'Bonjour.' pour compiler/charger, sans renvoyer d'audio.
        const text = msg.warm ? 'Bonjour.' : String(msg.text || '');
        const { wav, duration } = await synthesizeFull(text, lang, style, totalStep, speed);
        if (msg.warm) { post({ type: 'result', requestId, result: { ok: true, warm: true } }); return; }
        const wavBytes = writeWavFile(wav, _cfgs.ae.sample_rate);
        post({ type: 'result', requestId, result: { ok: true, wavBytes, sampleRate: _cfgs.ae.sample_rate, audioDuration: duration } });
    } catch (e) {
        post({ type: 'result', requestId, result: { ok: false, error: e.message } });
    }
}

process.parentPort.on('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'synth') handleSynth(msg);
});
