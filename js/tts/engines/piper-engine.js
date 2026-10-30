// js/tts/engines/piper-engine.js
import { TtsEngine } from '../engine-interface.js';
import { PIPER_FR_VOICES } from '../voice-catalog.js';

let _piperLib = null;

async function loadPiperLib() {
    if (_piperLib) return _piperLib;
    // Import du bundle vendored.
    _piperLib = await import('../../lib/piper/piper-tts-web.js');
    return _piperLib;
}

export class PiperEngine extends TtsEngine {
    constructor() {
        super();
        this._loadedVoices = new Set();
    }
    get id() { return 'piper'; }
    get displayName() { return 'Piper FR (neural, local)'; }

    async isAvailable() {
        try {
            await loadPiperLib();
            return true;
        } catch (e) { return false; }
    }

    async listVoices() {
        return PIPER_FR_VOICES.map(v => ({
            id: v.id, label: v.label, gender: v.gender, lang: v.lang,
            quality: v.quality, sizeMB: v.sizeMB,
        }));
    }

    async prepareVoice(voiceId, onProgress) {
        if (this._loadedVoices.has(voiceId)) return;
        const tts = await loadPiperLib();
        await tts.download(voiceId, (p) => {
            if (typeof onProgress === 'function' && p && p.total) {
                onProgress({ loaded: p.loaded, total: p.total, percent: Math.round(p.loaded * 100 / p.total) });
            }
        });
        this._loadedVoices.add(voiceId);
    }

    async synthesize(text, voiceId) {
        const tts = await loadPiperLib();
        if (!this._loadedVoices.has(voiceId)) {
            await this.prepareVoice(voiceId, null);
        }
        const wav = await tts.predict({ text, voiceId });
        // wav peut être Blob or ArrayBuffer selon version — on normalise.
        let blob;
        if (wav instanceof Blob) blob = wav;
        else if (wav instanceof ArrayBuffer) blob = new Blob([wav], { type: 'audio/wav' });
        else blob = new Blob([wav], { type: 'audio/wav' });
        return { blob, sampleRate: 22050 };
    }

    stop() { /* Piper synthèse one-shot, rien à interrompre côté engine */ }
}
