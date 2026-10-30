// js/tts/hardware-detector.js
// Probe matériel + scoring par engine. Async, idempotent.

let _cache = null;

export async function probe() {
    if (_cache) return _cache;
    const ram = navigator.deviceMemory || null;          // GB approximatif (Chrome)
    const cores = navigator.hardwareConcurrency || null;
    // v6.9.2-stats : détection Electron via flag exposé par preload.js (contextIsolation: true le rend nécessaire).
    // Fallback sur window.process pour compat dev mode sans preload, et userAgent comme dernier recours.
    const electronApi = (typeof window !== 'undefined' && window.electronAPI) ? window.electronAPI : null;
    const isElectron = !!(
        (electronApi && electronApi.isElectron === true)
        || (window.process && window.process.versions && window.process.versions.electron)
        || (navigator.userAgent && /Electron/i.test(navigator.userAgent))
    );
    const electronPlatform = electronApi ? electronApi.platform : null;
    const electronVersion = electronApi ? electronApi.electronVersion : null;
    let webgpu = false;
    try {
        if (navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
            const adapter = await navigator.gpu.requestAdapter();
            webgpu = !!adapter;
        }
    } catch (e) { webgpu = false; }

    let diskGB = null;
    try {
        if (navigator.storage && navigator.storage.estimate) {
            const est = await navigator.storage.estimate();
            if (est.quota) diskGB = est.quota / (1024 * 1024 * 1024);
        }
    } catch (e) { /* ignore */ }

    const connection = navigator.connection || null;
    const downlinkMbps = connection ? connection.downlink || null : null;
    const effectiveType = connection ? connection.effectiveType || null : null;

    let gpuRenderer = null;
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (ext) gpuRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        }
    } catch (e) { /* ignore */ }

    _cache = {
        ram, cores, webgpu, isElectron, diskGB,
        downlinkMbps, effectiveType, gpuRenderer,
        platform: electronPlatform || navigator.platform || null,
        electronVersion: electronVersion || null,
        userAgent: navigator.userAgent,
    };
    return _cache;
}

// Score 0-5 par engine. 0 = pas viable. 5 = recommandé fort.
export function scoreEngines(hw) {
    if (!hw) return { webspeech: 5, piper: 0, supertonic: 0 };
    const scores = { webspeech: 5, piper: 0, supertonic: 0 };

    // Web Speech : toujours dispo (5 par défaut). Si pas de voix FR : 1.
    // (le scoring fin se fait via voice-catalog quand on connaît les voix.)

    // Piper : neural ONNX, ~64 MB par voix, CPU OK mais ≥4 cores idéal.
    if ((hw.ram === null || hw.ram >= 4) && (hw.cores === null || hw.cores >= 4) && (hw.diskGB === null || hw.diskGB >= 0.3)) {
        scores.piper = 5;
    } else if (hw.ram >= 2 && (hw.cores || 0) >= 2) {
        scores.piper = 3;
    } else {
        scores.piper = 1;
    }

    return scores;
}

// Résumé lisible pour UI (Réglages).
export function summarize(hw, scores) {
    if (!hw) return 'Détection matérielle non disponible.';
    const ramTxt = hw.ram ? `${hw.ram} GB` : 'inconnu';
    const coresTxt = hw.cores ? `${hw.cores} cœurs` : 'inconnu';
    const gpuTxt = hw.webgpu ? 'WebGPU OK' : 'WebGPU absent';
    const electronTxt = hw.electronVersion ? `Electron ${hw.electronVersion.split('.').slice(0,2).join('.')}` : 'Electron';
    const runtimeTxt = hw.isElectron ? electronTxt : 'Navigateur (PWA)';
    const renderer = hw.gpuRenderer ? ` · ${hw.gpuRenderer.substring(0, 40)}` : '';
    return `${runtimeTxt} · ${ramTxt} RAM · ${coresTxt} · ${gpuTxt}${renderer}`;
}

// v9.19.3 : évalue l'aptitude de l'appareil à Supertonic (WASM mono-thread, aucun GPU utilisé
// → coût per-phrase élevé sur petites machines). Sert d'AVERTISSEMENT avant l'activation opt-in.
// Ne modifie PAS scoreEngines : la voix système reste le défaut automatique sûr.
export function supertonicSuitability(hw) {
    if (!hw) {
        return { level: 'ok', message: "ℹ️ Matériel non détecté : Supertonic fonctionnera, mais la 1ʳᵉ phrase de chaque chapitre peut prendre quelques secondes." };
    }
    const cores = hw.cores;        // navigator.hardwareConcurrency (souvent dispo)
    const ram = hw.ram;            // GB, souvent null hors Chrome
    const weak = (cores !== null && cores <= 2) || (ram !== null && ram <= 2);
    if (weak) {
        return { level: 'weak', message: "⚠️ Appareil modeste détecté : Supertonic (voix HD) peut figer l'affichage plusieurs secondes à chaque nouvelle phrase. La voix système (instantanée) reste recommandée sur cet appareil." };
    }
    const good = (cores === null || cores >= 8) && (ram === null || ram >= 8);
    if (good) {
        return { level: 'good', message: "✅ Votre appareil est bien dimensionné pour Supertonic." };
    }
    return { level: 'ok', message: "ℹ️ Supertonic fonctionnera, mais la 1ʳᵉ phrase de chaque nouveau chapitre peut prendre quelques secondes à se préparer." };
}
