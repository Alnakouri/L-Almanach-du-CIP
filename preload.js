const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // v6.9.2-stats : flags runtime statiques pour le détecteur matériel.
    isElectron: true,
    platform: process.platform,            // 'win32' | 'darwin' | 'linux'
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,

    downloadAI: (onProgress, modelId) => {
        ipcRenderer.on('ai-download-progress', (event, data) => onProgress(data));
        return ipcRenderer.invoke('ai-download', modelId);
    },
    runAI: (text, context, stream) => ipcRenderer.invoke('ai-run', { text, context, stream: !!stream }),
    onAIChunk: (cb) => ipcRenderer.on('ai-chunk', (event, data) => cb(data)),
    clearAICache: () => ipcRenderer.invoke('ai-clear-cache'),
    isAIReady: () => ipcRenderer.invoke('ai-is-ready'),
    aiModelPresent: () => ipcRenderer.invoke('ai-model-present'),   // v9.28.1
    getHardwareInfo: () => ipcRenderer.invoke('ai-get-hardware'),
    speakPiper: (text, voiceId, onProgress) => {
        ipcRenderer.on('piper-progress', (event, data) => onProgress(data));
        return ipcRenderer.invoke('piper-speak', { text, voiceId });
    },
    // v7.1.0 : cache disque Supertonic.
    supertonicCacheGet: (hash) => ipcRenderer.invoke('supertonic-cache-get', { hash }),
    supertonicCacheSet: (hash, wavBytes) => ipcRenderer.invoke('supertonic-cache-set', { hash, wavBytes }),
    supertonicCacheInfo: () => ipcRenderer.invoke('supertonic-cache-info'),
    supertonicCacheClear: () => ipcRenderer.invoke('supertonic-cache-clear'),
    supertonicSynth: (payload) => ipcRenderer.invoke('supertonic-synth', payload),   // v9.22.0
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    saveReport: (report) => ipcRenderer.invoke('save-report', report),   // v9.21.0
    logEvent: (ev) => ipcRenderer.invoke('log-event', ev),   // v9.29.0
    removeListener: (channel) => ipcRenderer.removeAllListeners(channel)
});
