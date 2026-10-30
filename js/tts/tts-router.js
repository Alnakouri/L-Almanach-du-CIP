// js/tts/tts-router.js
// Facade : route les requêtes speakAs(text, role) vers le bon engine + voix.

import { WebSpeechEngine } from './engines/web-speech-engine.js';
import { PiperEngine } from './engines/piper-engine.js';
import { SupertonicEngine } from './engines/supertonic-engine.js';
import { parseVoiceId, defaultVoiceForRole } from './voice-catalog.js';
import { probe, scoreEngines } from './hardware-detector.js';

class TtsRouter {
    constructor() {
        this._engines = {
            webspeech: new WebSpeechEngine(),
            piper: new PiperEngine(),
            supertonic: new SupertonicEngine(),
        };
        this._availability = null;
        this._hw = null;
        this._scores = null;
        this._currentAudio = null;
        this._currentEngine = null;
        this._token = 0; // v6.9.4 : incrémenté à chaque stop()/speakAs() pour annuler les synth pendantes
        // v7.2.0 : audios pré-préparés (hot swap dual buffer).
        // Map: pendingKey → { audio, url, role }. Cap à 2 entrées (FIFO).
        this._pendingAudios = new Map();
        this._pendingAudiosMax = 2;
        this._activePreSynthesizes = new Map();
        this._noVoiceWarned = false; // v9.19.3 : évite de répéter le toast "aucune voix FR"
    }

    async init() {
        this._hw = await probe();
        this._scores = scoreEngines(this._hw);
        const checks = await Promise.all(Object.entries(this._engines).map(async ([k, e]) => [k, await e.isAvailable()]));
        this._availability = new Set(checks.filter(([_, ok]) => ok).map(([k]) => k));
    }

    get hardware() { return this._hw; }
    get scores() { return this._scores; }
    get availability() { return this._availability || new Set(); }

    async getOrInit() {
        if (!this._availability) await this.init();
        return this;
    }

    // Renvoie la liste agrégée des voix dispo : [{ fullId, label, engine, gender, lang, quality, sizeMB? }]
    async listAllVoices() {
        await this.getOrInit();
        const out = [];
        for (const [engId, eng] of Object.entries(this._engines)) {
            if (!this._availability.has(engId)) continue;
            const voices = await eng.listVoices();
            voices.forEach(v => out.push({
                ...v,
                engine: engId,
                fullId: `${engId}:${v.id}`,
            }));
        }
        return out;
    }

    async resolveVoiceForRole(role) {
        await this.getOrInit();
        // 1. Préférence utilisateur explicite ?
        const stored = localStorage.getItem(`almanach_tts_voice_${role}`);
        if (stored) {
            const parsed = parseVoiceId(stored);
            if (parsed && this._availability.has(parsed.engine)) return stored;
        }
        // 3. Détecteur recommande
        const webSpeechVoices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
        const def = defaultVoiceForRole(role, this._availability, this._scores, webSpeechVoices);
        return def;
    }

    async speakAs(text, role = 'persona', opts = {}) {
        if (!text || !text.trim()) return;
        if (localStorage.getItem('almanach_sim_voiceover') === 'off') return;
        await this.getOrInit();

        const voiceFullId = await this.resolveVoiceForRole(role);
        if (!voiceFullId) {
            console.warn('TTS Router: aucune voix résolue pour rôle', role);
            // v9.19.3 : cas zéro voix FR (aucune voix système FR + Piper/Supertonic indispo) →
            // avertir l'utilisateur UNE fois au lieu d'un silence inexpliqué.
            if (!this._noVoiceWarned) {
                this._noVoiceWarned = true;
                if (typeof window !== 'undefined' && typeof window.showErrorToast === 'function') {
                    window.showErrorToast("Aucune voix de synthèse française n'est disponible sur cet appareil. La lecture vocale est indisponible — vous pouvez installer une voix française dans les réglages de votre système d'exploitation.");
                }
            }
            return;
        }
        const parsed = parseVoiceId(voiceFullId);
        const eng = this._engines[parsed.engine];
        if (!eng) {
            console.warn('TTS Router: engine inconnu', parsed.engine);
            return;
        }

        // v7.2.0 : tentative hot swap — réutilise un <audio> pré-préparé par preSynthesize.
        // On extrait AVANT stop() (qui clear le map) et on l'utilise plus bas.
        const hotSwapKey = `${parsed.engine}:${parsed.nativeId}|${text.trim()}`;
        // v9.24.0 : si une pré-synthèse de CETTE phrase est en vol (typiquement la phrase 1
        // lancée à l'ouverture du chapitre) et que le hot-swap n'est pas encore prêt, l'attendre
        // AVANT de tenter le hot-swap → un clic ▶ précoce se greffe sur la synthèse en cours au
        // lieu d'en lancer une 2ᵉ redondante (le worker sérialise : sinon ~2× la latence).
        if (!this._pendingAudios.has(hotSwapKey) && this._activePreSynthesizes.has(hotSwapKey)) {
            try { await this._activePreSynthesizes.get(hotSwapKey); } catch (e) { /* opportuniste */ }
        }
        let hotSwap = this._pendingAudios.get(hotSwapKey) || null;
        if (hotSwap) {
            this._pendingAudios.delete(hotSwapKey);
            console.log(`[TTS Router] hot-swap hit pour "${text.trim().slice(0, 40)}..."`);
        }

        // Stop toute lecture en cours + invalide les synth pendantes.
        this.stop();
        const myToken = ++this._token;

        console.log(`[TTS Router] role=${role} → engine=${parsed.engine} voice=${parsed.nativeId} token=${myToken}`);
        // v6.9.6 : event global pour que l'UI puisse afficher l'engine actif.
        try {
            window.dispatchEvent(new CustomEvent('tts-engine-used', {
                detail: { role, engine: parsed.engine, voice: parsed.nativeId, status: 'start', token: myToken }
            }));
        } catch (e) { /* ignore */ }

        // v7.0.9 : callback de sync highlight, invoqué à l'instant où l'audio commence
        // réellement à jouer. Pour les engines audio (Supertonic/Voxtral/Piper) : via
        // audio.onplaying ci-dessous. Pour Web Speech : via utter.onstart côté engine.
        const onPlaybackStart = (opts && typeof opts.onPlaybackStart === 'function')
            ? opts.onPlaybackStart
            : null;

        try {
            // v7.0.3 : passe la langue à l'engine (lue depuis localStorage, défaut 'fr').
            // Les engines qui ignorent ce param (Web Speech, Piper, Voxtral) ne sont pas affectés.
            const ttsLang = (typeof localStorage !== 'undefined' && localStorage.getItem('almanach_tts_lang')) || 'fr';
            // v7.0.9 : on plumb aussi onPlaybackStart pour les engines qui ont leur propre
            // mécanique "playback started" (Web Speech via utter.onstart).
            // v7.2.1 : onBoundary plumbé à l'engine pour highlight karaoké (Web Speech only).
            const onBoundary = (opts && typeof opts.onBoundary === 'function') ? opts.onBoundary : null;
            const synthResult = await eng.synthesize(text.trim(), parsed.nativeId, { lang: ttsLang, onPlaybackStart, onBoundary });
            const { blob, native, durationMs, fromCache } = synthResult || {};
            // Si stop() a été appelé pendant la synth (nouveau clic, autre rôle), on annule.
            if (myToken !== this._token) {
                console.log(`[TTS Router] synth ${myToken} obsolète (current=${this._token}), abandon`);
                return;
            }
            // v6.9.12 : event "done" avec timing et flag cache.
            try {
                window.dispatchEvent(new CustomEvent('tts-engine-used', {
                    detail: { role, engine: parsed.engine, voice: parsed.nativeId, status: 'done', token: myToken, durationMs: durationMs || 0, fromCache: !!fromCache }
                }));
            } catch (ee) { /* ignore */ }
            if (native) return; // Web Speech joue déjà via l'API native
            if (!blob && !hotSwap) return;
            // v7.2.0 : hot swap — si un <audio> pré-préparé matche cette phrase,
            // on l'utilise directement (déjà préloaded, gap < 10 ms au play).
            let url, audio;
            if (hotSwap) {
                audio = hotSwap.audio;
                url = hotSwap.url;
            } else {
                // v7.2.0 : trim silence trailing pour réduire le gap inter-phrases.
                let playBlob = blob;
                if (!fromCache) {
                    try {
                        const { trimTrailingSilence } = await import('./utils/wav-trim.js');
                        playBlob = await trimTrailingSilence(blob);
                    } catch (e) { /* keep raw blob */ }
                }
                url = URL.createObjectURL(playBlob);
                audio = new Audio(url);
            }
            // v7.0.8 : applique la vitesse de lecture sauvegardée (clé partagée avec Web Speech).
            // Sans ça, Supertonic/Voxtral/Piper jouaient toujours à playbackRate=1.0 même
            // si l'utilisateur avait choisi 1.5× dans le sélecteur du lecteur.
            try {
                const savedRate = parseFloat(localStorage.getItem('almanach_tts_rate') || '1.0');
                if (savedRate > 0 && savedRate <= 4) audio.playbackRate = savedRate;
            } catch (e) { /* ignore */ }
            // v7.0.9 : fire onPlaybackStart au premier "playing" event de l'<audio> router-owned.
            // Cible Supertonic (1ʳᵉ phrase 1-3s) où la synth précède l'audio → highlight déphasé.
            // _firedPlayStart évite la double-exécution si onplaying fire plusieurs fois (rare).
            if (onPlaybackStart) {
                let _firedPlayStart = false;
                audio.onplaying = () => {
                    if (_firedPlayStart) return;
                    _firedPlayStart = true;
                    try { onPlaybackStart(); } catch (e) { /* ignore */ }
                };
            }
            // Double-check après création de l'Audio (au cas où stop() a été appelé entre-temps).
            if (myToken !== this._token) {
                this._releaseAudio(audio, url);
                return;
            }
            this._currentAudio = audio;
            this._currentEngine = eng;
            return new Promise((resolve) => {
                const cleanup = () => {
                    this._releaseAudio(audio, url);
                    if (this._currentAudio === audio) this._currentAudio = null;
                };
                audio.onended = () => { cleanup(); resolve(); };
                audio.onerror = () => { cleanup(); resolve(); };
                audio.play().catch((err) => {
                    // v9.6.6 : `AbortError` = interruption volontaire (stop() ou nouveau rôle a
                    // appelé pause()), pas une vraie panne. Idem si on a été supplanté (token
                    // périmé). Dans ces cas le teardown est déjà géré par stop()/cleanup → on
                    // résout silencieusement sans warn ni toast trompeur.
                    const interrupted = (err && err.name === 'AbortError') || myToken !== this._token;
                    if (!interrupted) {
                        console.warn('[TTS Router] audio.play() rejeté :', err);
                        if (typeof window.showErrorToast === 'function') {
                            window.showErrorToast('Audio bloqué : ' + (err?.message || 'autoplay refusé'));
                        }
                    }
                    resolve();
                });
            });
        } catch (e) {
            // Si on a été annulé entre-temps, ne pas crier (kill volontaire).
            if (myToken !== this._token) return;
            console.error(`[TTS Router] engine ${parsed.engine} a échoué — fallback Web Speech :`, e);
            if (typeof window.showErrorToast === 'function') {
                window.showErrorToast(`TTS ${parsed.engine} indisponible — voix système utilisée. ${e?.message || ''}`);
            }
            try {
                // v7.0.5-revert : reporte le nom de l'engine qui a échoué (ex: 'supertonic')
                // pour que l'UI affiche "(échec supertonic)" au lieu de "(échec webspeech)".
                window.dispatchEvent(new CustomEvent('tts-engine-used', {
                    detail: { role, engine: parsed.engine, voice: 'fallback', status: 'fallback', token: myToken, error: e?.message }
                }));
            } catch (ee) { /* ignore */ }
            // Fallback : Web Speech (uniquement si toujours le token courant)
            if (parsed.engine !== 'webspeech' && myToken === this._token) {
                try {
                    const wsVoices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('fr'));
                    if (wsVoices.length > 0) {
                        await this._engines.webspeech.synthesize(text.trim(), wsVoices[0].name);
                    }
                } catch (e2) { /* abandon silencieux */ }
            }
        }
    }

    stop() {
        // v6.9.4 : incrémente le token AVANT de stopper, pour annuler toute synth pendante.
        this._token = (this._token || 0) + 1;
        if (this._currentAudio) {
            const audio = this._currentAudio;
            try { audio.pause(); } catch (e) {}
            // v7.0.8 : `audio.pause()` ne déclenche ni `onended` ni `onerror` → la Promise
            // de speakAs() ne résout jamais et le blob URL fuit jusqu'au GC. On appelle
            // explicitement le handler `onended` (qui revoke l'URL et resolve la Promise),
            // après l'avoir détaché pour éviter une double-exécution si la lecture finissait
            // pile à ce moment.
            try {
                const handler = audio.onended;
                audio.onended = null;
                audio.onerror = null;
                if (typeof handler === 'function') handler();
            } catch (e) { /* ignore */ }
            this._currentAudio = null;
        }
        // Stop TOUS les engines qui ont une méthode stop (pas juste le courant) —
        // empêche un engine lent de remonter un blob après qu'on ait switché de rôle.
        Object.values(this._engines).forEach(e => {
            if (typeof e.stop === 'function') {
                try { e.stop(); } catch (err) { /* ignore */ }
            }
        });
        this._currentEngine = null;
        if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) {} }
        // v7.2.0 : cleanup audios pré-préparés (libère les blob URLs).
        this._clearPendingAudios();
    }

    // v9.6.6 : teardown propre d'un <audio> + son blob URL. On DÉTACHE le src et on
    // re-load() AVANT de révoquer l'URL : ça annule tout fetch encore en vol sur le blob
    // (audio en plein buffering qu'on met en pause, ou pre-fetch dont le load() n'est pas
    // fini) et évite le bruit console `blob: net::ERR_FILE_NOT_FOUND` qui survenait quand on
    // révoquait une URL encore référencée par l'élément.
    _releaseAudio(audio, url) {
        if (audio) {
            try { audio.pause(); } catch (e) {}
            try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
        }
        if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
    }

    _clearPendingAudios() {
        for (const [, p] of this._pendingAudios) {
            this._releaseAudio(p.audio, p.url);
        }
        this._pendingAudios.clear();
    }

    // v7.0.7 : équivalent de stop() mais demande aux engines de tuer aussi les
    // pre-synths en background (Supertonic._preFetchAborts). Utilisé à la navigation
    // pour libérer le main thread des synths du chapitre précédent.
    hardStop() {
        // v6.9.4 : incrémente le token AVANT, pour annuler synth pendantes via Promise reject.
        this._token = (this._token || 0) + 1;
        if (this._currentAudio) {
            const audio = this._currentAudio;
            try { audio.pause(); } catch (e) {}
            // v7.0.8 : force résolution Promise + revoke URL blob (cf. stop() PATCH 9).
            try {
                const handler = audio.onended;
                audio.onended = null;
                audio.onerror = null;
                if (typeof handler === 'function') handler();
            } catch (e) { /* ignore */ }
            this._currentAudio = null;
        }
        // v7.2.0 : cleanup audios pré-préparés.
        this._clearPendingAudios();
        this._activePreSynthesizes.clear();
        // Préférer eng.hardStop() si défini, sinon fallback eng.stop().
        Object.values(this._engines).forEach(e => {
            try {
                if (typeof e.hardStop === 'function') {
                    e.hardStop();
                } else if (typeof e.stop === 'function') {
                    e.stop();
                }
            } catch (err) { /* ignore */ }
        });
        this._currentEngine = null;
        if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    }

    // v7.0.8 : applique playbackRate à l'audio router-owned en cours.
    // Appelé par le sélecteur de vitesse du lecteur pour changer la vitesse SANS attendre
    // la phrase suivante. La nouvelle valeur est aussi persistée par le caller et lue par
    // speakAs() à la création de chaque Audio (PATCH 3).
    setPlaybackRate(rate) {
        const r = parseFloat(rate);
        if (!isFinite(r) || r <= 0 || r > 4) return;
        if (this._currentAudio) {
            try { this._currentAudio.playbackRate = r; } catch (e) { /* ignore */ }
        }
    }

    async prepareVoice(voiceFullId, onProgress) {
        const parsed = parseVoiceId(voiceFullId);
        if (!parsed) throw new Error('voiceId invalide');
        const eng = this._engines[parsed.engine];
        if (!eng) throw new Error('engine inconnu : ' + parsed.engine);
        await eng.prepareVoice(parsed.nativeId, onProgress);
    }

    // v6.9.12 : synthétise une phrase en tâche de fond pour remplir le cache, SANS jouer l'audio
    // et SANS toucher au token anti-superposition. Utilisé pour le pre-fetch phrase N+1.
    async preSynthesize(text, role = 'reader') {
        if (!text || !text.trim()) return;
        await this.getOrInit();
        const voiceFullId = await this.resolveVoiceForRole(role);
        if (!voiceFullId) return;
        const parsed = parseVoiceId(voiceFullId);
        if (parsed.engine !== 'supertonic') return;
        const eng = this._engines[parsed.engine];
        if (!eng) return;

        const key = `${parsed.engine}:${parsed.nativeId}|${text.trim()}`;
        if (this._activePreSynthesizes.has(key)) {
            return this._activePreSynthesizes.get(key);
        }

        const promise = (async () => {
            try {
                const ttsLang = (typeof localStorage !== 'undefined' && localStorage.getItem('almanach_tts_lang')) || 'fr';
                const synthResult = await eng.synthesize(text.trim(), parsed.nativeId, { lang: ttsLang, _preFetch: true });
                console.log(`[TTS Router] pre-fetch ${parsed.engine} OK pour "${text.slice(0, 40)}..."`);
                if (synthResult && synthResult.blob) {
                    try {
                        const { trimTrailingSilence } = await import('./utils/wav-trim.js');
                        const playBlob = synthResult.fromCache ? synthResult.blob : await trimTrailingSilence(synthResult.blob);
                        const url = URL.createObjectURL(playBlob);
                        const audio = new Audio(url);
                        audio.preload = 'auto';
                        audio.load();
                        while (this._pendingAudios.size >= this._pendingAudiosMax) {
                            const oldestKey = this._pendingAudios.keys().next().value;
                            const oldest = this._pendingAudios.get(oldestKey);
                            this._releaseAudio(oldest.audio, oldest.url);
                            this._pendingAudios.delete(oldestKey);
                        }
                        this._pendingAudios.set(key, { audio, url, role });
                    } catch (e) { /* hot swap est opportuniste */ }
                }
            } catch (e) {
                console.warn('[TTS Router] pre-fetch échec (silencieux):', e?.message || e);
            }
        })();

        this._activePreSynthesizes.set(key, promise);
        try {
            await promise;
        } finally {
            this._activePreSynthesizes.delete(key);
        }
    }

    // v9.6.1 : lit une réplique UNIQUEMENT si elle est jouable sans figer l'UI.
    //  - Supertonic (synth WASM lourde) : on ne joue que si un <audio> pré-préparé existe
    //    (hot-swap rempli par preSynthesize) → zéro cold-synth, zéro freeze ; sinon no-op.
    //  - Autres engines (Web Speech / Piper, rapides) : on joue normalement.
    // Renvoie true si la lecture a démarré, false si on a renoncé (réplique pas prête).
    async speakAsIfReady(text, role = 'persona', opts) {
        if (!text || !text.trim()) return false;
        try {
            await this.getOrInit();
            const voiceFullId = await this.resolveVoiceForRole(role);
            if (!voiceFullId) return false;
            const parsed = parseVoiceId(voiceFullId);
            if (parsed.engine === 'supertonic') {
                const key = `${parsed.engine}:${parsed.nativeId}|${text.trim()}`;
                const activePromise = this._activePreSynthesizes.get(key);
                if (activePromise) {
                    await activePromise;
                }
                const eng = this._engines[parsed.engine];
                const ttsLang = (typeof localStorage !== 'undefined' && localStorage.getItem('almanach_tts_lang')) || 'fr';
                const ready = !!(eng && typeof eng.isCached === 'function'
                    && eng.isCached(text.trim(), parsed.nativeId, ttsLang));
                if (!ready) return false;
            }
            await this.speakAs(text, role, opts);
            return true;
        } catch (e) {
            return false;
        }
    }

    // v7.0.4 : pré-chauffage d'un engine — init + prepareVoice de la voix résolue
    // pour un rôle. Fire-and-forget au boot, masque le cold start du 1er clic.
    // Utilisé par app.js si almanach_supertonic_enabled=='1' au boot.
    // v7.1.0 : le check engine résolu est désormais AVANT eng.init() — si la voix
    // résolue pour le rôle n'est pas de cet engine, on évite de charger inutilement
    // ORT + 4 modèles ONNX (~5-15 s sur main thread). Cas typique : l'utilisateur a
    // activé Supertonic mais préfère Voxtral/Piper pour la lecture.
    async warmEngine(engineId, role = 'reader') {
        try {
            await this.getOrInit();
            const eng = this._engines[engineId];
            if (!eng) return;
            if (!this._availability.has(engineId)) return;
            // 1. Check que la voix résolue pour le rôle appartient bien à l'engine ciblé.
            // Si non, on n'a aucune raison de charger le runtime de l'engine.
            const voiceFullId = await this.resolveVoiceForRole(role);
            if (!voiceFullId) return;
            const parsed = parseVoiceId(voiceFullId);
            if (parsed.engine !== engineId) {
                console.log(`[TTS Router] warmEngine ${engineId} skip (voix résolue=${parsed.engine}, role=${role})`);
                return;
            }
            // 2. Init du runtime (charge ORT + 4 modèles ONNX pour Supertonic).
            if (typeof eng.init === 'function') {
                await eng.init();
            }
            // 3. Pré-charger la voix native utilisée pour le rôle.
            if (typeof eng.prepareVoice === 'function') {
                await eng.prepareVoice(parsed.nativeId);
            }
            // 4. v9.14.5 : warmup RÉEL du graphe WASM — une inférence jetable qui bypass le
            // cache (_warm). Sans ça, le cache disque court-circuite l'inférence et le 1ᵉʳ vrai
            // synth de la session paie ~10 s (mesuré v9.14.4). Coût par-lancement, payé ici au
            // boot (arrière-plan) au lieu du 1ᵉʳ clic ▶.
            if (typeof eng.synthesize === 'function') {
                const _tWarm = (typeof performance !== 'undefined' ? performance : Date).now();
                const ttsLang = (typeof localStorage !== 'undefined' && localStorage.getItem('almanach_tts_lang')) || 'fr';
                try {
                    await eng.synthesize('Bonjour.', parsed.nativeId, { lang: ttsLang, _warm: true });
                    const _ms = Math.round((typeof performance !== 'undefined' ? performance : Date).now() - _tWarm);
                    console.log(`[TTS Router] warmEngine ${engineId} warmup inférence réelle : ${_ms} ms`);
                } catch (e) {
                    console.warn(`[TTS Router] warmEngine ${engineId} warmup échec (silencieux):`, e?.message || e);
                }
            }
            console.log(`[TTS Router] warmEngine ${engineId} (voix=${parsed.nativeId}) OK`);
        } catch (e) {
            console.warn(`[TTS Router] warmEngine ${engineId} échec (silencieux):`, e?.message || e);
        }
    }
}

// Singleton global
const router = new TtsRouter();
export default router;
