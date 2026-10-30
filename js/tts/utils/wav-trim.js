// js/tts/utils/wav-trim.js
// v7.2.0 — Trim du silence en fin de WAV (et en début, optionnel).
// Réduit le gap perçu entre phrases pour Supertonic/Voxtral/Piper qui émettent
// souvent 100-300 ms de silence en queue.
// Coût : ~10-50 ms par phrase (décode + encode), payé une seule fois (cache).

/**
 * Encode un Float32Array PCM (mono ou stéréo) en blob WAV 16-bit.
 * @param {Float32Array[]} channels - Tableau de canaux (1 = mono, 2 = stéréo).
 * @param {number} sampleRate
 * @returns {Blob} - audio/wav
 */
function encodeWavBlob(channels, sampleRate) {
    const numChannels = channels.length;
    const len = channels[0].length;
    const buffer = new ArrayBuffer(44 + len * numChannels * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + len * numChannels * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, len * numChannels * 2, true);
    let offset = 44;
    // Interleave channels
    for (let i = 0; i < len; i++) {
        for (let c = 0; c < numChannels; c++) {
            const s = Math.max(-1, Math.min(1, channels[c][i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            offset += 2;
        }
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Trim le silence en fin de blob WAV (et optionnellement en début).
 * Conserve `tailMs` de silence en queue pour ne pas couper abruptement.
 *
 * @param {Blob} blob - Le blob WAV source.
 * @param {object} [options]
 * @param {number} [options.threshold=0.005] - Amplitude RMS sous laquelle = silence.
 * @param {number} [options.tailMs=80] - Silence à conserver en queue (ms).
 * @param {boolean} [options.trimLeading=false] - Trim aussi le silence en début.
 * @returns {Promise<Blob>} - Blob trimé, ou le blob original si pas de gain significatif.
 */
export async function trimTrailingSilence(blob, options = {}) {
    const { threshold = 0.005, tailMs = 80, trimLeading = false } = options;
    if (!blob || blob.size < 200) return blob;
    
    let ac = null;
    try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        const ab = await blob.arrayBuffer();
        const buf = await ac.decodeAudioData(ab.slice(0));
        const sr = buf.sampleRate;
        const numChannels = buf.numberOfChannels;
        const channels = [];
        for (let c = 0; c < numChannels; c++) channels.push(buf.getChannelData(c));
        const len = channels[0].length;
        
        // Find last non-silent sample (max abs across channels).
        let lastNonSilent = -1;
        for (let i = len - 1; i >= 0; i--) {
            let maxAbs = 0;
            for (let c = 0; c < numChannels; c++) {
                const v = Math.abs(channels[c][i]);
                if (v > maxAbs) maxAbs = v;
            }
            if (maxAbs > threshold) { lastNonSilent = i; break; }
        }
        if (lastNonSilent < 0) return blob; // tout silence, anormal
        
        // Find first non-silent sample (si trimLeading).
        let firstNonSilent = 0;
        if (trimLeading) {
            for (let i = 0; i < len; i++) {
                let maxAbs = 0;
                for (let c = 0; c < numChannels; c++) {
                    const v = Math.abs(channels[c][i]);
                    if (v > maxAbs) maxAbs = v;
                }
                if (maxAbs > threshold) { firstNonSilent = i; break; }
            }
        }
        
        const tailSamples = Math.floor(sr * tailMs / 1000);
        const endSample = Math.min(len, lastNonSilent + 1 + tailSamples);
        
        // Gain minimal : si on ne trim que < 100 ms, on garde l'original (évite coût encode).
        const trimmedSamples = (len - endSample) + firstNonSilent;
        if (trimmedSamples < sr * 0.1) return blob; // < 100 ms gagnés
        
        const trimmedChannels = channels.map(c => c.slice(firstNonSilent, endSample));
        return encodeWavBlob(trimmedChannels, sr);
    } catch (e) {
        console.warn('[wav-trim] échec, retour blob original:', e?.message || e);
        return blob;
    } finally {
        try { if (ac && ac.state !== 'closed') ac.close(); } catch (_) {}
    }
}

export default trimTrailingSilence;
