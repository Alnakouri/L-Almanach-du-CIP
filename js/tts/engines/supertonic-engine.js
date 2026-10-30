// js/tts/engines/supertonic-engine.js
import { TtsEngine } from '../engine-interface.js';
import { SUPERTONIC_VOICES } from '../voice-catalog.js';
import * as helper from './supertonic-helper.js';

// Supertonic 3 - On-device TTS via ONNX Runtime Web (99M params, 31 langues).
// RTF ~0.55x — pre-fetch phrase N+1 dans router.preSynthesize (cf. PATCH 1).

// v9.7.0 : facteur de vitesse de synthèse (prosodie), source unique de vérité.
// NB : la vitesse de lecture choisie par l'utilisateur s'applique séparément via
// audio.playbackRate (clé almanach_tts_rate, sélecteur du lecteur).
const SUPERTONIC_SYNTH_SPEED = 1.05;

// v9.23.0 : nombre de steps de débruitage du vector_estimator. 4 = rapide (défaut
// historique) ; 8 = qualité HD, rendu possible grâce à la marge de perf du worker
// ORT-node (RTF ~0,12 à 4 → ~0,25 à 8, toujours << temps réel, hors thread UI = zéro gel).
// Source UNIQUE de vérité : injectée dans les 2 chemins de synthèse (worker + WASM fallback)
// ET dans les 2 clés de cache (mémoire + disque) → changer cette valeur invalide
// automatiquement l'audio déjà caché synthétisé à un autre nombre de steps.
const SUPERTONIC_STEPS = 8;

export class SupertonicEngine extends TtsEngine {
    constructor() {
        super();
        this._textToSpeech = null;
        this._cfgs = null;
        this._styles = {};
        this._isInitializing = false;
        this._initPromise = null;
        // v7.0.3 : token d'abort de la synth utilisateur (cancelé par stop()).
        this._currentAbort = null;
        // v7.0.4 : tokens d'abort des pre-synths en background.
        // Volontairement PAS cancelés par stop() — la pre-synth continue
        // et stocke son WAV dans _wavCache pour servir la prochaine lecture.
        this._preFetchAborts = new Set();
        // v7.0.4 : cache LRU des WAV synthétisés (Map = ordre d'insertion).
        // v9.6.2 : 5 → 25 pour qu'une mise en situation entière (~21 répliques) tienne en cache,
        // condition de la voix "best-effort" sans figeage (cf router.speakAsIfReady / isCached).
        this._wavCache = new Map();
        this._wavCacheMax = 25;
    }

    // v9.22.0 : en Electron, la synthèse part dans l'utilityProcess (supertonic-worker.js)
    // → hors thread UI, ~10× plus rapide, zéro gel. En PWA (pas d'electronAPI), on garde
    // le flux WASM renderer ci-dessous (supertonic-helper.js) en fallback.
    _useWorker() {
        return typeof window !== 'undefined' && !!(window.electronAPI && typeof window.electronAPI.supertonicSynth === 'function');
    }

    get id() { return 'supertonic'; }
    get displayName() { return 'Supertonic 3 (neural multi, opt-in)'; }

    // v7.0.3 : accès aux tokens inline supportés (pour UI de test et future doc).
    get expressiveTags() {
        return ['<laugh>', '<breath>', '<sigh>'];
    }

    async isAvailable() {
        // v7.0.0-beta-2 : opt-in via flag (pattern Voxtral). Sans activation explicite,
        // l'engine n'apparaît pas dans les selectors et le router ne le route pas.
        try {
            if (typeof WebAssembly !== 'object') return false;
            if (localStorage.getItem('almanach_supertonic_enabled') !== '1') return false;
            return typeof helper?.loadTextToSpeech === 'function';
        } catch (e) {
            return false;
        }
    }

    async listVoices() {
        // v7.0.0-beta-fix1 : lecture depuis le catalog (10 voix M1-M5/F1-F5).
        return SUPERTONIC_VOICES.map(v => ({
            id: v.id, label: v.label, gender: v.gender, lang: v.lang,
            quality: v.quality,
        }));
    }

    async init() {
        if (this._useWorker()) return;   // v9.22.0 : le worker charge les modèles lazy, pas le renderer
        if (this._textToSpeech) return;
        if (this._isInitializing) return this._initPromise;

        this._isInitializing = true;
        this._initPromise = (async () => {
            try {
                // v7.0.3 : ORT chargé en lazy par le helper (ensureOrt). Plus de guard
                // window.ort ici — l'absence du fichier sera reportée par le helper.
                const basePath = 'assets/models/supertonic/onnx';
                const result = await helper.loadTextToSpeech(basePath, {
                    executionProviders: ['webgpu', 'wasm'],
                    graphOptimizationLevel: 'all'
                });

                this._textToSpeech = result.textToSpeech;
                this._cfgs = result.cfgs;
            } catch (err) {
                console.error('[Supertonic] Initialization failed:', err);
                throw err;
            } finally {
                this._isInitializing = false;
            }
        })();

        return this._initPromise;
    }

    async prepareVoice(voiceId, onProgress) {
        if (this._useWorker()) return;   // v9.22.0 : le worker charge le style de voix lazy
        await this.init();
        if (this._styles[voiceId]) return;

        try {
            const stylePath = `assets/models/supertonic/voice_styles/${voiceId}.json`;
            this._styles[voiceId] = await helper.loadVoiceStyle([stylePath]);
        } catch (err) {
            console.error(`[Supertonic] Failed to load voice style ${voiceId}:`, err);
            throw err;
        }
    }

    // v7.0.4 : clé de cache déterministe (texte trimé + voix + langue).
    // v9.23.0 : le nombre de steps entre dans la clé → l'audio d'un autre réglage
    // de steps n'est jamais resservi (invalidation propre au passage HD).
    _wavCacheKey(text, voiceId, lang) {
        return `${voiceId}|${lang}|s${SUPERTONIC_STEPS}|${(text || '').trim()}`;
    }

    // v9.6.2 : la réplique est-elle déjà en cache mémoire ? → lecture sans synth à froid.
    // Utilisé par le router (speakAsIfReady) pour la voix "best-effort" des simulations.
    isCached(text, voiceId, lang = 'fr') {
        return this._wavCache.has(this._wavCacheKey(text, voiceId, lang));
    }

    // v7.1.0 : SHA-1 du tuple (text+voice+lang) pour la clé disque. main.js utilise ce hash
    // TEL QUEL comme nom de fichier `.wav` (il ne le recalcule pas) → aucun couplage à tenir.
    // v9.23.0 : le nombre de steps entre dans le hash → l'audio 4-steps déjà en cache disque
    // devient inatteignable (orphelin bénin, jamais resservi), le 8-steps est resynthétisé.
    // Renvoie un hex string 40 chars, ou null si Web Crypto indispo.
    async _diskHash(text, voiceId, lang) {
        try {
            const data = new TextEncoder().encode(`${(text || '').trim()}|${voiceId}|${lang}|s${SUPERTONIC_STEPS}`);
            const buf = await crypto.subtle.digest('SHA-1', data);
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            return null;
        }
    }

    // v7.0.4 : LRU bump (delete + re-set pour replacer en queue).
    _wavCacheBump(key, value) {
        if (this._wavCache.has(key)) this._wavCache.delete(key);
        this._wavCache.set(key, value);
        while (this._wavCache.size > this._wavCacheMax) {
            const oldest = this._wavCache.keys().next().value;
            this._wavCache.delete(oldest);
        }
    }

    async synthesize(text, voiceId, opts = {}) {
        const lang = (opts && typeof opts.lang === 'string' && opts.lang.trim()) ? opts.lang.trim() : 'fr';
        const isPreFetch = !!(opts && opts._preFetch);
        const isWarm = !!(opts && opts._warm);

        // Cache LRU mémoire (audio instantané).
        const cacheKey = this._wavCacheKey(text, voiceId, lang);
        if (!isWarm && this._wavCache.has(cacheKey)) {
            const cached = this._wavCache.get(cacheKey);
            this._wavCacheBump(cacheKey, cached);
            return { blob: cached.blob, durationMs: 0, audioDuration: cached.audioDuration, sampleRate: cached.sampleRate, fromCache: true };
        }

        // Cache disque (persistant entre sessions), best-effort.
        let diskHash = null;
        const api = (typeof window !== 'undefined') ? window.electronAPI : null;
        if (!isWarm && api && typeof api.supertonicCacheGet === 'function') {
            diskHash = await this._diskHash(text, voiceId, lang);
            if (diskHash) {
                try {
                    const res = await api.supertonicCacheGet(diskHash);
                    if (res && res.ok && res.wavBytes) {
                        const u8 = res.wavBytes instanceof Uint8Array ? res.wavBytes : new Uint8Array(res.wavBytes);
                        const blob = new Blob([u8], { type: 'audio/wav' });
                        this._wavCacheBump(cacheKey, { blob, audioDuration: 0, sampleRate: 0 });
                        return { blob, durationMs: 0, audioDuration: 0, sampleRate: 0, fromCache: true, fromDisk: true };
                    }
                } catch (e) {
                    console.warn('[Supertonic] supertonicCacheGet échec (silencieux):', e?.message || e);
                }
            }
        }

        // Token d'abort (le pre-fetch n'est pas cancelable par stop()).
        const myAbort = { cancelled: false };
        if (isPreFetch) this._preFetchAborts.add(myAbort);
        else this._currentAbort = myAbort;

        try {
            let result;
            if (this._useWorker()) {
                // v9.22.0 : synthèse déportée dans l'utilityProcess (zéro gel UI).
                const res = await window.electronAPI.supertonicSynth({
                    text, voiceId, lang, totalStep: SUPERTONIC_STEPS, speed: SUPERTONIC_SYNTH_SPEED, warm: isWarm
                });
                // v9.31.0 : l’échec se teste AVANT le raccourci warmup. Sans ça un worker
                // mort renvoyait { ok:false } et le warmup retournait quand même un succès :
                // le routeur loggait « warmup inférence réelle : 192 ms » (l'aller-retour IPC
                // d'un échec) et la panne ne sortait qu'au premier vrai clic ▶.
                if (!res || !res.ok) {
                    throw new Error('worker Supertonic échec : ' + ((res && res.error) || 'inconnu'));
                }
                if (isWarm) return { blob: null, durationMs: 0, audioDuration: 0, warm: true };
                if (!res.wavBytes) {
                    throw new Error('worker Supertonic échec : réponse sans audio');
                }
                const u8 = res.wavBytes instanceof Uint8Array ? res.wavBytes : new Uint8Array(res.wavBytes);
                const blob = new Blob([u8], { type: 'audio/wav' });
                result = { blob, durationMs: 0, audioDuration: res.audioDuration || 0, sampleRate: res.sampleRate || 0 };
            } else {
                // Fallback PWA : flux WASM renderer (supertonic-helper.js), inchangé.
                await this.init();
                if (!this._styles[voiceId]) await this.prepareVoice(voiceId);
                const start = performance.now();
                const { wav, duration } = await this._textToSpeech.call(
                    text, lang, this._styles[voiceId], SUPERTONIC_STEPS, SUPERTONIC_SYNTH_SPEED, 0.3, null, myAbort
                );
                const durationMs = performance.now() - start;
                const wavBuffer = helper.writeWavFile(wav, this._textToSpeech.sampleRate);
                const blob = new Blob([wavBuffer], { type: 'audio/wav' });
                result = { blob, durationMs, audioDuration: duration[0], sampleRate: this._textToSpeech.sampleRate };
            }

            // Écriture cache (commune aux 2 chemins), si non aborté et non warmup.
            if (!myAbort.cancelled && !isWarm) {
                this._wavCacheBump(cacheKey, { blob: result.blob, audioDuration: result.audioDuration, sampleRate: result.sampleRate });
                if (diskHash && api && typeof api.supertonicCacheSet === 'function') {
                    result.blob.arrayBuffer().then(ab => api.supertonicCacheSet(diskHash, new Uint8Array(ab)))
                        .catch((e) => console.warn('[Supertonic] supertonicCacheSet échec (silencieux):', e?.message || e));
                }
            }
            return result;
        } catch (e) {
            if (e && (e.name === 'AbortError' || /AbortError/.test(e.message || ''))) {
                return { blob: null, durationMs: 0, audioDuration: 0, aborted: true };
            }
            throw e;
        } finally {
            if (isPreFetch) this._preFetchAborts.delete(myAbort);
            else if (this._currentAbort === myAbort) this._currentAbort = null;
        }
    }

    stop() {
        // v7.0.3 : interrompt la synth utilisateur en cours.
        // v7.0.4 : les pre-synths (Set _preFetchAborts) restent VIVANTES — elles
        // continuent en background et alimentent _wavCache pour la prochaine lecture.
        if (this._currentAbort) {
            this._currentAbort.cancelled = true;
        }
    }

    // v7.0.7 : kill TOUT, y compris les pre-synths en background.
    // Différent de stop() qui préserve volontairement _preFetchAborts (v7.0.4).
    // À utiliser uniquement à la navigation (changement de chapitre, quit reader).
    hardStop() {
        if (this._currentAbort) {
            this._currentAbort.cancelled = true;
        }
        if (this._preFetchAborts && this._preFetchAborts.size > 0) {
            for (const a of this._preFetchAborts) {
                a.cancelled = true;
            }
            this._preFetchAborts.clear();
        }
    }

    // v7.0.4 : utilitaire pour vidage manuel (changement de voix, debug). Pas appelé
    // automatiquement — le LRU plafonne déjà à 5 entrées (~1 MB).
    clearWavCache() {
        this._wavCache.clear();
    }
}
