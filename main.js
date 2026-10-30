const { app, BrowserWindow, Menu, ipcMain, utilityProcess, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// v9.28.0 : mode portable — si l'app packagée peut écrire à côté de l'exe
// (clé USB, dossier extrait), les données utilisateur (profil Chromium,
// supertonic-cache, signalements) vivent dans AlmanachCIP-Data/ à côté de
// l'exe : zéro trace sur le PC hôte, les données suivent la clé.
// Repli silencieux vers AppData/Documents si l'emplacement est en lecture
// seule. Jamais actif en dev (`npm start` : app.isPackaged = false).
// IMPÉRATIF Electron : setPath('userData') doit être appelé AVANT app.ready.
let PORTABLE_DATA_DIR = null;
if (app.isPackaged) {
    try {
        const candidate = path.join(path.dirname(process.execPath), 'AlmanachCIP-Data');
        if (!fs.existsSync(candidate)) fs.mkdirSync(candidate);
        const probe = path.join(candidate, '.write-test');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        app.setPath('userData', candidate);
        PORTABLE_DATA_DIR = candidate;
        console.log('[Portable] données utilisateur → ' + candidate);
    } catch (e) {
        PORTABLE_DATA_DIR = null; // lecture seule → AppData/Documents par défaut
    }
}


let currentModelId = 'onnx-community/Qwen2.5-1.5B-Instruct-CIP';
const MODEL_CACHE = path.join(__dirname, 'models');

// v8.9.0 : l'IA (chargement + inférence) tourne dans un utilityProcess dédié
// (ai-worker.js). Le main process pompe la boucle d'événements des fenêtres :
// toute charge CPU ici gelait l'app entière (saisie bloquée pendant le load
// et chaque génération). Ici on ne garde que le relais de messages.
let aiProcess = null;
let aiReady = false;
let _aiRequestSeq = 0;
const _aiPending = new Map();      // requestId → resolve
let _aiProgressSender = null;      // webContents à notifier pendant le load
let _aiRunSender = null;           // webContents à notifier des fragments de streaming (v8.9.4)

function getAIProcess() {
    if (aiProcess) return aiProcess;
    aiProcess = utilityProcess.fork(path.join(__dirname, 'ai-worker.js'), [], { serviceName: 'almanach-ai' });
    aiProcess.on('message', (msg) => {
        if (msg.type === 'progress') {
            if (_aiProgressSender && !_aiProgressSender.isDestroyed()) {
                _aiProgressSender.send('ai-download-progress', msg.data);
            }
        } else if (msg.type === 'chunk') {
            // v8.9.4 : fragment de streaming → relayé tel quel au renderer.
            if (_aiRunSender && !_aiRunSender.isDestroyed()) {
                _aiRunSender.send('ai-chunk', { requestId: msg.requestId, text: msg.text });
            }
        } else if (msg.type === 'result') {
            const resolve = _aiPending.get(msg.requestId);
            if (resolve) { _aiPending.delete(msg.requestId); resolve(msg.result); }
        }
    });
    aiProcess.on('exit', (code) => {
        aiProcess = null;
        aiReady = false;
        for (const resolve of _aiPending.values()) {
            resolve({ success: false, error: 'Process IA arrêté (code ' + code + ')' });
        }
        _aiPending.clear();
    });
    return aiProcess;
}

function aiRequest(payload) {
    const requestId = ++_aiRequestSeq;
    return new Promise((resolve) => {
        _aiPending.set(requestId, resolve);
        getAIProcess().postMessage({ ...payload, requestId });
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        icon: path.join(__dirname, 'assets/icon-512.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            preload: path.join(__dirname, 'preload.js')
        },
        backgroundColor: '#0a0a12'
    });
    win.loadFile('index.html');

    // v9.19.0 : gardes de navigation (audit sécurité 02/07). L'app est 100 % locale
    // (file://). On refuse toute ouverture de nouvelle fenêtre (les liens externes légitimes
    // passent déjà par shell.openExternal via l'IPC 'open-external') et on bloque toute
    // navigation du webContents vers autre chose que le file:// de l'app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(mailto:|https?:)/i.test(url)) { shell.openExternal(url); }
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) event.preventDefault();
    });

    // v7.3.1 : Activation des raccourcis DevTools (Ctrl+Shift+I, F12) même si le menu est discret
    const template = [
        {
            label: 'Édition',
            submenu: [
                { role: 'undo', label: 'Annuler' },
                { role: 'redo', label: 'Rétablir' },
                { type: 'separator' },
                { role: 'cut', label: 'Couper' },
                { role: 'copy', label: 'Copier' },
                { role: 'paste', label: 'Coller' },
                { role: 'selectAll', label: 'Tout sélectionner' }
            ]
        },
        {
            label: 'Affichage',
            submenu: [
                { role: 'reload', label: 'Actualiser' },
                { role: 'forceReload', label: 'Actualiser (ignorer le cache)' },
                { 
                    label: 'Outils de développement',
                    accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
                    click: () => { win.webContents.toggleDevTools(); }
                },
                { type: 'separator' },
                { role: 'resetZoom', label: 'Zoom par défaut' },
                { role: 'zoomIn', label: 'Zoom avant' },
                { role: 'zoomOut', label: 'Zoom arrière' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: 'Plein écran' }
            ]
        }
    ];

    // Ajouter F12 comme raccourci alternatif pour les DevTools
    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            win.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// --- IA prête ? ---
ipcMain.handle('ai-is-ready', () => aiReady);

// v9.15.0 : ouverture d'un lien externe (mailto: pour le signalement de souci).
ipcMain.handle('open-external', async (event, url) => {
    if (typeof url !== 'string') return false;
    if (!/^(mailto:|https?:)/i.test(url)) return false;   // garde-fou : seulement mailto/http(s)
    await shell.openExternal(url);
    return true;
});

// v9.21.0 : signalement de souci enregistré sur disque (append JSONL).
// v9.28.0 : en mode portable → AlmanachCIP-Data/ à côté de l'exe ; sinon
// Documents/Almanach-CIP/ (comportement historique). Modèle : supertonic-cache-set
// (best-effort, validation d'entrée, retour { ok, path }). Le renderer fournit
// ver/platform/ua ; on horodate ici, et l'alert affiche le `path` retourné.
ipcMain.handle('save-report', (event, report) => {
    try {
        if (!report || typeof report !== 'object') return { ok: false, error: 'report invalide' };
        const desc = typeof report.desc === 'string' ? report.desc.trim() : '';
        if (!desc) return { ok: false, error: 'description vide' };
        const dir = PORTABLE_DATA_DIR || path.join(app.getPath('documents'), 'Almanach-CIP');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'signalements.jsonl');
        const entry = {
            date: new Date().toISOString(),
            ver: typeof report.ver === 'string' ? report.ver : '?',
            platform: typeof report.platform === 'string' ? report.platform : '?',
            ua: typeof report.ua === 'string' ? report.ua : '?',
            subject: typeof report.subject === 'string' ? report.subject.trim() : '',
            desc,
            diag: typeof report.diag === 'string' ? report.diag.slice(0, 4000) : ''
        };
        fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
        return { ok: true, path: filePath };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// v9.28.1 : le renderer demande si le poids du modèle IA existe réellement sur
// disque (bundle portable → profil vierge → le flag localStorage ne suffit plus).
// On teste le .onnx lui-même, pas le dossier (un dossier résiduel vide = faux positif).
ipcMain.handle('ai-model-present', () => {
    try {
        return fs.existsSync(path.join(MODEL_CACHE, currentModelId, 'onnx', 'model_q4.onnx'));
    } catch (e) {
        return false;
    }
});

// v9.29.0 : boîte noire locale — le renderer pousse ses événements techniques
// (erreurs captées + sonde de boot) ; append JSONL best-effort dans le même
// dossier que les signalements (mode portable → suit la clé USB). Rotation à
// ~1 Mo (bascule en .old.jsonl, un seul historique) pour ne jamais gonfler la clé.
ipcMain.handle('log-event', (event, ev) => {
    try {
        if (!ev || typeof ev !== 'object') return { ok: false };
        const dir = PORTABLE_DATA_DIR || path.join(app.getPath('documents'), 'Almanach-CIP');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'journal-technique.jsonl');
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1024 * 1024) {
            fs.renameSync(filePath, path.join(dir, 'journal-technique.old.jsonl'));
        }
        const entry = {
            date: new Date().toISOString(),
            local: new Date().toLocaleString('fr-FR'),
            portable: !!PORTABLE_DATA_DIR,
            build: typeof ev.build === 'string' ? ev.build : '?',
            type: typeof ev.type === 'string' ? ev.type.slice(0, 20) : '?',
            msg: typeof ev.msg === 'string' ? ev.msg.slice(0, 500) : '',
            src: typeof ev.src === 'string' ? ev.src.slice(0, 200) : ''
        };
        fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});




// --- Détection Matérielle ---
ipcMain.handle('ai-get-hardware', () => {
    const os = require('os');
    // v7.4.5 : alignement avec le schéma attendu par app.js:updateSystemInfo
    // (lit info.os et info.arch — étaient undefined avant ce fix).
    const platformMap = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
    const memFreeGB = Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10;
    const memTotalGB = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
    return {
        os: platformMap[process.platform] || process.platform,
        arch: process.arch,
        gpu: null,
        cpus: os.cpus().length,
        mem: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' Go',
        memTotalGB,                 // v9.16.0 : numérique, pour la garde RAM du pré-warm IA
        memFreeGB,                  // v9.16.0 : RAM libre instantanée (os.freemem)
        platform: process.platform
    };
});

// --- Téléchargement + initialisation (relayé au utilityProcess, v8.9.0) ---
ipcMain.handle('ai-download', async (event, modelId) => {
    if (modelId) currentModelId = modelId;
    _aiProgressSender = event.sender;
    const send = (data) => { if (!event.sender.isDestroyed()) event.sender.send('ai-download-progress', data); };
    send({ status: 'init', message: `Initialisation de ${currentModelId}...` });

    const result = await aiRequest({ type: 'load', modelId: currentModelId });
    if (result.success) aiReady = true;
    else console.error('AI error:', result.error);
    return result;
});

// --- Inférence (relayée au utilityProcess, v8.9.0 — prompt et décodage dans ai-worker.js) ---
ipcMain.handle('ai-run', (event, { text, context, stream }) => {
    if (!aiReady) return { success: false, error: 'IA non chargée' };
    _aiRunSender = event.sender;
    return aiRequest({ type: 'run', text, context, stream: !!stream });
});

// --- Vider le cache ---
ipcMain.handle('ai-clear-cache', async () => {
    try {
        // v8.9.0 : arrêter le worker d'abord (modèle en RAM + handles fichiers).
        if (aiProcess) { aiProcess.kill(); aiProcess = null; }
        aiReady = false;
        if (fs.existsSync(MODEL_CACHE)) {
            fs.readdirSync(MODEL_CACHE).forEach(f => {
                const p = path.join(MODEL_CACHE, f);
                if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
                else fs.unlinkSync(p);
            });
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================================
// CACHE DISQUE SUPERTONIC 3
// ============================================================================
const crypto = require('crypto');

// v7.1.0 : cache disque Supertonic — persiste les WAV synthétisés entre sessions.
// La synth Supertonic tourne en renderer (WASM via ORT), donc le renderer envoie
// le WAV brut au main process pour persistance disque. Clé : SHA-1 de
// (texte trimé + voiceId + lang).
let _supertonicCacheDir = null;
function getSupertonicCacheDir() {
    if (_supertonicCacheDir) return _supertonicCacheDir;
    _supertonicCacheDir = path.join(app.getPath('userData'), 'supertonic-cache');
    try { if (!fs.existsSync(_supertonicCacheDir)) fs.mkdirSync(_supertonicCacheDir, { recursive: true }); } catch (e) {}
    return _supertonicCacheDir;
}

// v7.1.0 : récupère un WAV mis en cache disque. Renderer fournit le hash déjà calculé
// (text+voice+lang). Renvoie { ok, wavBytes? } — Buffer si hit, sinon ok:false.
ipcMain.handle('supertonic-cache-get', (event, { hash }) => {
    try {
        if (!hash || typeof hash !== 'string' || !/^[a-f0-9]{40}$/.test(hash)) {
            return { ok: false, error: 'hash invalide' };
        }
        const dir = getSupertonicCacheDir();
        const cachePath = path.join(dir, hash + '.wav');
        if (!fs.existsSync(cachePath)) return { ok: false };
        const wavBytes = fs.readFileSync(cachePath);
        return { ok: true, wavBytes };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// v7.1.0 : persiste un WAV synthétisé sur disque. Best-effort — si l'écriture échoue
// (disque plein, permission), on log mais on n'interrompt pas le flux renderer (qui a
// déjà le WAV en mémoire et peut le jouer).
ipcMain.handle('supertonic-cache-set', (event, { hash, wavBytes }) => {
    try {
        if (!hash || typeof hash !== 'string' || !/^[a-f0-9]{40}$/.test(hash)) {
            return { ok: false, error: 'hash invalide' };
        }
        if (!wavBytes || !wavBytes.length) return { ok: false, error: 'wavBytes vide' };
        const dir = getSupertonicCacheDir();
        const cachePath = path.join(dir, hash + '.wav');
        fs.writeFileSync(cachePath, Buffer.from(wavBytes));
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// v7.1.0 : info cache Supertonic (count + sizeBytes).
ipcMain.handle('supertonic-cache-info', () => {
    try {
        const dir = getSupertonicCacheDir();
        if (!fs.existsSync(dir)) return { count: 0, sizeBytes: 0 };
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav'));
        let sizeBytes = 0;
        for (const f of files) {
            try { sizeBytes += fs.statSync(path.join(dir, f)).size; } catch (e) {}
        }
        return { count: files.length, sizeBytes };
    } catch (e) {
        return { count: 0, sizeBytes: 0, error: e.message };
    }
});

// v7.1.0 : vide le cache Supertonic.
ipcMain.handle('supertonic-cache-clear', () => {
    try {
        const dir = getSupertonicCacheDir();
        if (!fs.existsSync(dir)) return { ok: true, removed: 0 };
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav'));
        let removed = 0;
        for (const f of files) {
            try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (e) {}
        }
        return { ok: true, removed };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ============================================================================
// v9.22.0 : SYNTHÈSE SUPERTONIC dans un utilityProcess dédié (fin du gel UI).
// Avant : la synth WASM tournait dans le renderer (thread UI) → gel ~11 s. Ce worker
// (supertonic-worker.js, onnxruntime-node natif) sort le calcul du thread UI. Modèle
// identique à getAIProcess/aiRequest (l.27-62).
// ============================================================================
let stProcess = null;
let _stRequestSeq = 0;
const _stPending = new Map();

function getSupertonicProcess() {
    if (stProcess) return stProcess;
    stProcess = utilityProcess.fork(path.join(__dirname, 'supertonic-worker.js'), [], { serviceName: 'almanach-supertonic' });
    stProcess.on('message', (msg) => {
        if (msg.type === 'result') {
            const resolve = _stPending.get(msg.requestId);
            if (resolve) { _stPending.delete(msg.requestId); resolve(msg.result); }
        }
    });
    // v9.31.0 : le code de sortie était jeté. Un worker qui meurt au `require` (module
    // absent, binding natif incompatible) sortait en silence et le renderer ne voyait
    // qu'un « Process Supertonic arrêté » sans cause — 1 h de diagnostic le 02/09.
    stProcess.on('exit', (code) => {
        console.error('[Supertonic] worker terminé (code ' + code + ')');
        stProcess = null;
        const motif = 'Process Supertonic arrêté (code ' + code + ')';
        for (const resolve of _stPending.values()) resolve({ ok: false, error: motif });
        _stPending.clear();
    });
    return stProcess;
}

ipcMain.handle('supertonic-synth', (event, payload) => {
    const requestId = ++_stRequestSeq;
    return new Promise((resolve) => {
        _stPending.set(requestId, resolve);
        getSupertonicProcess().postMessage({ type: 'synth', requestId, ...payload });
    });
});

app.whenReady().then(() => {
    if (!fs.existsSync(MODEL_CACHE)) fs.mkdirSync(MODEL_CACHE, { recursive: true });
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
