// js/tts/voice-catalog.js
// Registry central des voix TTS — toutes engines confondues.
// Format voiceId universel : "{engineId}:{nativeId}"

export const ROLES = Object.freeze({ PERSONA: 'persona', CIP: 'cip', READER: 'reader' });

// Voix Piper FR pré-cataloguées. Téléchargées à la demande.
// v9.20.0 : voix vendorées dans assets/models/piper/ (100 % local). Seules les voix
// réellement présentes sur disque sont cataloguées — ne pas rajouter d'entrée sans vendorer le .onnx.
export const PIPER_FR_VOICES = [
    { engine: 'piper', id: 'fr_FR-tom-medium', label: 'Piper · Tom (FR m, neural)', lang: 'fr-FR', gender: 'male', quality: 'medium', sizeMB: 64, roleHint: 'cip' },
    { engine: 'piper', id: 'fr_FR-siwis-medium', label: 'Piper · Siwis (FR f, neural)', lang: 'fr-FR', gender: 'female', quality: 'medium', sizeMB: 64, roleHint: 'persona' },
];

// v7.0.0-beta-2 : 10 voix Supertonic (M1-M5, F1-F5). Architecture style+content séparée
// → lang='multi' (le texte donne la langue, le style donne le timbre). Quality 'premium'
// (audit utilisateur 15 mai 2026 : non robotique, expressif via tags <laugh>/<breath>/<sigh>).
export const SUPERTONIC_VOICES = [
    { engine: 'supertonic', id: 'M1', label: 'Supertonic · M1 ♂ (multi)', lang: 'multi', gender: 'male', quality: 'premium', roleHint: 'cip' },
    { engine: 'supertonic', id: 'M2', label: 'Supertonic · M2 ♂ (multi)', lang: 'multi', gender: 'male', quality: 'premium', roleHint: null },
    { engine: 'supertonic', id: 'M3', label: 'Supertonic · M3 ♂ (multi)', lang: 'multi', gender: 'male', quality: 'premium', roleHint: null },
    { engine: 'supertonic', id: 'M4', label: 'Supertonic · M4 ♂ (multi)', lang: 'multi', gender: 'male', quality: 'premium', roleHint: null },
    { engine: 'supertonic', id: 'M5', label: 'Supertonic · M5 ♂ (multi)', lang: 'multi', gender: 'male', quality: 'premium', roleHint: null },
    { engine: 'supertonic', id: 'F1', label: 'Supertonic · F1 ♀ (multi)', lang: 'multi', gender: 'female', quality: 'premium', roleHint: 'persona' },
    { engine: 'supertonic', id: 'F2', label: 'Supertonic · F2 ♀ (multi)', lang: 'multi', gender: 'female', quality: 'premium', roleHint: null },
    { engine: 'supertonic', id: 'F3', label: 'Supertonic · F3 ♀ (multi)', lang: 'multi', gender: 'female', quality: 'premium', roleHint: null },
    { engine: 'supertonic', id: 'F4', label: 'Supertonic · F4 ♀ (multi)', lang: 'multi', gender: 'female', quality: 'premium', roleHint: null },
    { engine: 'supertonic', id: 'F5', label: 'Supertonic · F5 ♀ (multi)', lang: 'multi', gender: 'female', quality: 'premium', roleHint: null },
];

export function parseVoiceId(voiceId) {
    if (!voiceId || typeof voiceId !== 'string') return null;
    const idx = voiceId.indexOf(':');
    if (idx < 0) return null;
    return { engine: voiceId.substring(0, idx), nativeId: voiceId.substring(idx + 1) };
}

export function makeVoiceId(engine, nativeId) { return `${engine}:${nativeId}`; }

// Listage agrégé (Web Speech ajoute ses voix dynamiquement à l'exécution).
export function staticCatalog() {
    return [
        ...PIPER_FR_VOICES.map(v => ({ ...v, fullId: makeVoiceId(v.engine, v.id) })),
        ...SUPERTONIC_VOICES.map(v => ({ ...v, fullId: makeVoiceId(v.engine, v.id) })),
    ];
}

// Voix par défaut recommandée pour un rôle, selon les engines DISPONIBLES.
// engineScores : objet { piper: 0-5, supertonic: 0-5, webspeech: 0-5 }
// availableEngines : Set<string>
export function defaultVoiceForRole(role, availableEngines, engineScores = {}, webSpeechVoices = []) {
    // Priorité : score décroissant des engines disponibles
    // v7.4.0 : piper neural > supertonic neural > webspeech système (voxtral retiré).
    const ranked = ['piper', 'supertonic', 'webspeech']
        .filter(e => availableEngines.has(e))
        .sort((a, b) => (engineScores[b] || 0) - (engineScores[a] || 0));

    for (const eng of ranked) {
        if (eng === 'piper') {
            const lookupRole = role === 'reader' ? 'persona' : role;
            const v = PIPER_FR_VOICES.find(x => x.roleHint === lookupRole && x.quality === 'medium');
            if (v) return makeVoiceId('piper', v.id);
        } else if (eng === 'supertonic') {
            const lookupRole = role === 'reader' ? 'persona' : role;
            const v = SUPERTONIC_VOICES.find(x => x.roleHint === lookupRole);
            if (v) return makeVoiceId('supertonic', v.id);
        } else if (eng === 'webspeech') {
            const frVoices = webSpeechVoices.filter(v => (v.lang === 'fr-FR' || v.lang.startsWith('fr')) && !v.name.toLowerCase().includes('espeak'));
            if (frVoices.length === 0) continue;
            if (role === 'cip') {
                const malePrefs = ['Paul', 'Claude', 'Bruno', 'Thomas', 'Henri', 'Pierre', 'Daniel'];
                for (const name of malePrefs) {
                    const m = frVoices.find(x => x.name.includes(name));
                    if (m) return makeVoiceId('webspeech', m.name);
                }
            } else {
                // persona et reader → voix féminine
                const femalePrefs = ['Hortense', 'Julie', 'Denise', 'Audrey', 'Caroline'];
                for (const name of femalePrefs) {
                    const m = frVoices.find(x => x.name.includes(name));
                    if (m) return makeVoiceId('webspeech', m.name);
                }
            }
            // Fallback : 1ère voix FR dispo
            return makeVoiceId('webspeech', frVoices[0].name);
        }
    }
    return null;
}
