// js/tts/engine-interface.js
// Contrat commun pour les moteurs TTS.
//
// Chaque engine expose :
//   - id (string)
//   - displayName (string)
//   - isAvailable() : Promise<boolean>      // détection runtime
//   - listVoices() : Promise<Voice[]>       // { id, label, gender, lang, quality }
//   - prepareVoice(voiceId, onProgress) : Promise<void>   // download si besoin
//   - synthesize(text, voiceId) : Promise<{ blob: Blob, sampleRate: number }>
//   - stop() : void
//
// Engines implémentent ces méthodes via classes ES.

export class TtsEngine {
    constructor() {
        if (new.target === TtsEngine) {
            throw new Error('TtsEngine est une interface abstraite.');
        }
    }
    get id() { throw new Error('id must be overridden'); }
    get displayName() { throw new Error('displayName must be overridden'); }
    async isAvailable() { return false; }
    async listVoices() { return []; }
    async prepareVoice(_voiceId, _onProgress) { /* no-op par défaut */ }
    async synthesize(_text, _voiceId) { throw new Error('synthesize must be overridden'); }
    stop() { /* no-op par défaut */ }
}
