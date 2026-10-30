// js/tts/engines/web-speech-engine.js
import { TtsEngine } from '../engine-interface.js';

export class WebSpeechEngine extends TtsEngine {
    constructor() {
        super();
        this._synth = window.speechSynthesis || null;
        this._currentUtter = null;
    }
    get id() { return 'webspeech'; }
    get displayName() { return 'Voix système (Web Speech API)'; }

    async isAvailable() { return !!this._synth; }

    async listVoices() {
        if (!this._synth) return [];
        let voices = this._synth.getVoices();
        if (voices.length === 0) {
            await new Promise(resolve => {
                const handler = () => { this._synth.removeEventListener('voiceschanged', handler); resolve(); };
                this._synth.addEventListener('voiceschanged', handler);
                setTimeout(resolve, 1500);
            });
            voices = this._synth.getVoices();
        }
        return voices
            .filter(v => !v.name.toLowerCase().includes('espeak'))
            .map(v => ({
                id: v.name,
                label: `${v.name} (${v.lang})`,
                gender: /paul|claude|bruno|thomas|henri|pierre|daniel/i.test(v.name) ? 'male'
                      : /hortense|julie|denise|audrey|caroline/i.test(v.name) ? 'female' : 'unknown',
                lang: v.lang,
                quality: /(natural|online|enhanced|premium|neural)/i.test(v.name) ? 'neural' : 'legacy',
                _ref: v,
            }));
    }

    async prepareVoice(_voiceId) { /* no-op : voix système toujours prêtes */ }

    synthesize(text, voiceId, opts = {}) {
        return new Promise((resolve, reject) => {
            if (!this._synth) return reject(new Error('Web Speech non disponible'));
            const utter = new SpeechSynthesisUtterance(text);
            const voices = this._synth.getVoices();
            const voice = voices.find(v => v.name === voiceId);
            if (voice) utter.voice = voice;
            utter.lang = 'fr-FR';
            utter.rate = parseFloat(localStorage.getItem('almanach_tts_rate') || '1.0');
            utter.pitch = 1.0;
            utter.volume = 1.0;
            this._currentUtter = utter;
            // v7.0.9 : callback de sync highlight invoqué dès que la voix commence réellement.
            // Pour Web Speech la latence onstart est de ~50-100 ms (imperceptible) mais on
            // garde le câblage pour cohérence avec les engines audio (Supertonic/Piper).
            utter.onstart = () => {
                if (opts && typeof opts.onPlaybackStart === 'function') {
                    try { opts.onPlaybackStart(); } catch (e) { /* ignore */ }
                }
            };
            // v7.2.1 : event boundary (mot ou phrase) pour highlight karaoké mot-par-mot.
            // Uniquement Web Speech — les autres engines n'exposent pas ce timing.
            // e.charIndex et e.charLength sont relatifs au texte de l'utterance.
            if (opts && typeof opts.onBoundary === 'function') {
                utter.onboundary = (e) => {
                    if (e.name === 'word' || !e.name) {
                        try { opts.onBoundary({ charIndex: e.charIndex, charLength: e.charLength || 0 }); } catch (err) { /* ignore */ }
                    }
                };
            }
            // Web Speech ne nous donne pas le blob audio. On résout à la fin de la lecture.
            // On renvoie un Blob vide pour l'API, mais on joue directement via l'API native.
            utter.onend = () => { this._currentUtter = null; resolve({ blob: null, sampleRate: 0, native: true }); };
            utter.onerror = (e) => { this._currentUtter = null; reject(new Error('Web Speech error: ' + (e.error || 'unknown'))); };
            try { this._synth.cancel(); } catch (e) {}
            setTimeout(() => { if (utter === this._currentUtter) this._synth.speak(utter); }, 50);
        });
    }

    stop() {
        if (this._synth) { try { this._synth.cancel(); } catch (e) {} }
        this._currentUtter = null;
    }
}
