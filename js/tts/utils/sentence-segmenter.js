// js/tts/utils/sentence-segmenter.js
// v7.2.0 — Découpe phrase FR robuste, gère abréviations + décimales + ellipses.
// Remplace la regex naïve /[^.!?]+[.!?]+/g qui ratait :
//   - "M. Dupont"     → ["M", ". Dupont"]
//   - "3.14 mètres"   → ["3", ".14 mètres"]
//   - "etc. Voici..." → ["etc", ". Voici"]
//   - Phrases sans ponctuation finale → ignorées
//   - "..." (ellipsis) → découpé en 3

// Abréviations FR usuelles (le point fait partie de l'abréviation, pas une fin de phrase).
const ABBREVIATIONS_FR = [
    'M.', 'Mme.', 'Mlle.', 'MM.', 'Mr.', 'Dr.', 'Pr.', 'St.', 'Ste.',
    'etc.', 'cf.', 'vs.', 'p.', 'pp.', 'fig.', 'ex.', 'art.',
    'ch.', 'env.', 'av.', 'apr.', 'éd.', 'vol.', 'tél.', 'fax.',
    'n°', 'cm.', 'mm.', 'km.', 'kg.', 'min.', 'sec.', 'h.',
];

// Token de protection (caractère ininjectable dans du texte FR naturel).
const PROTECT_DOT = '';
const PROTECT_ELLIPSIS = '';

/**
 * Découpe un texte en phrases FR, en respectant les abréviations et décimales.
 * @param {string} text - Texte source.
 * @returns {string[]} - Tableau de phrases (déjà trimmées, vides filtrées).
 */
export function segmentFrenchSentences(text) {
    if (!text || typeof text !== 'string') return [];
    
    let work = text;
    
    // 1. Protéger les ellipses (… ou ...) — on ne veut pas que `...` soit considéré
    //    comme 3 fins de phrase successives.
    work = work.replace(/\.{3,}/g, PROTECT_ELLIPSIS);
    work = work.replace(/…/g, PROTECT_ELLIPSIS);
    
    // 2. Protéger les abréviations connues (matching mot+point en début/milieu de mot).
    for (const abbr of ABBREVIATIONS_FR) {
        const escaped = abbr.replace(/[.()\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}`, 'g');
        work = work.replace(re, abbr.replace(/\./g, PROTECT_DOT));
    }
    
    // 3. Protéger les décimales : 3.14 → 3§14, 3,14 OK (virgule = pas de découpe).
    work = work.replace(/(\d)\.(\d)/g, `$1${PROTECT_DOT}$2`);
    
    // 4. Découpe sur ponctuation forte (.?!) suivie d'espace ou fin.
    //    Capture la ponctuation pour la garder collée à la phrase.
    const parts = work.split(/([.!?]+[\s ]*)/g);
    const sentences = [];
    let buf = '';
    for (let i = 0; i < parts.length; i++) {
        buf += parts[i];
        if (/[.!?]+[\s ]*$/.test(parts[i])) {
            sentences.push(buf);
            buf = '';
        }
    }
    if (buf.trim()) sentences.push(buf);
    
    // 5. Restaurer les points protégés et ellipses.
    return sentences
        .map(s => s.replace(new RegExp(PROTECT_DOT, 'g'), '.'))
        .map(s => s.replace(new RegExp(PROTECT_ELLIPSIS, 'g'), '…'))
        .map(s => s.trim())
        .filter(s => s.length > 0)
        // 6. v9.17.0 : sous-découper les phrases longues. Chaque chunk = une synthèse
        //    Supertonic = un gel UI proportionnel à sa longueur (WASM mono-thread). Couper
        //    à une frontière de proposition rend les gels plus courts ET fait démarrer
        //    l'audio plus tôt sur la 1ʳᵉ phrase. Les chunks restent des sous-chaînes
        //    contiguës → le surlignage par-phrase continue de matcher.
        .flatMap(splitLongSentence);
}

// v9.17.0 : longueur max d'un chunk de synthèse.
// v9.19.2 : abaissé 140 → 80 pour réduire le gel du 1er ▶ (Supertonic WASM mono-thread).
// Une phrase longue se découpe en morceaux plus courts → 1er son ~2× plus tôt, les morceaux
// suivants sont pré-synthétisés pendant la lecture. Surlignage par-morceau inchangé.
const MAX_CHUNK = 80;

/**
 * Sous-découpe une phrase trop longue à la dernière frontière de proposition
 * (« , » « ; » « : » « — » suivie d'un espace) au plus près de MAX_CHUNK ; à défaut au
 * dernier espace ; jamais au milieu d'un mot (sauf mot interminable). Préserve la
 * contiguïté avec le texte source (surlignage intact).
 * @param {string} s
 * @returns {string[]}
 */
function splitLongSentence(s) {
    if (s.length <= MAX_CHUNK) return [s];
    const out = [];
    let rest = s.trim();
    const FLOOR = Math.round(MAX_CHUNK * 0.4);
    while (rest.length > MAX_CHUNK) {
        const win = rest.slice(0, MAX_CHUNK);
        let cut = -1;
        // dernière ponctuation de proposition + espace dans la fenêtre
        for (let i = win.length - 2; i >= 0; i--) {
            const c = win[i];
            if ((c === ',' || c === ';' || c === ':' || c === '—') && win[i + 1] === ' ') { cut = i + 1; break; }
        }
        if (cut < FLOOR) {
            const sp = win.lastIndexOf(' ');
            cut = (sp >= FLOOR) ? sp : MAX_CHUNK; // mot interminable → coupe brute
        }
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(c => c.length > 0);
}

// Export par défaut pour usage simple.
export default segmentFrenchSentences;
