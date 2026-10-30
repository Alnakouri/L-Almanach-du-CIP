#!/usr/bin/env node
/**
 * Pré-agrège les sources structurées de `js/data.js` (RNCP_REFERENTIEL + CIP_GLOSSAIRE)
 * en un seul `data/vault-index.json` ingéré par MiniSearch comme corpus "vault" prioritaire.
 *
 * v7.7.0 — création initiale. Résout la dette IA d'extrapolation Qwen en injectant
 * dans le contexte RAG des fiches synthèses fidèles au référentiel RNCP CIP officiel.
 *
 * Format de sortie : [{ id, title, content, category, source }, ...]
 *   - id       : identifiant kebab-case unique
 *   - title    : titre humain affiché dans les sources retenues
 *   - content  : texte de la fiche (paraphrase fidèle de la source)
 *   - category : 'synthese-rncp' | 'ccp-presentation' | 'competence' | 'glossaire'
 *   - source   : 'RNCP_REFERENTIEL' | 'CIP_GLOSSAIRE' (origine pour audit)
 *
 * Lancé manuellement via `npm run build-vault`. À re-exécuter après modif de
 * RNCP_REFERENTIEL ou CIP_GLOSSAIRE dans js/data.js.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA_JS = path.join(__dirname, '..', 'js', 'data.js');
const FAQ_JSON = path.join(__dirname, '..', 'data', 'faq-cip.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'vault-index.json');
const USER_VAULT_DIR = path.join(__dirname, '..', 'data', 'vault');

function loadDataJs() {
    const src = fs.readFileSync(DATA_JS, 'utf-8');
    // Sandbox : on mock window pour que les `window.X = X` finaux ne crashent pas.
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    try {
        vm.runInContext(src, sandbox, { filename: 'data.js' });
    } catch (e) {
        console.error('[build-vault] Erreur évaluation data.js :', e.message);
        process.exit(1);
    }
    return {
        rncp: sandbox.window.RNCP_REFERENTIEL,
        glossaire: sandbox.window.CIP_GLOSSAIRE,
    };
}

function slugify(s) {
    return String(s)
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

function extractFromRNCP(rncp) {
    const fiches = [];
    if (!rncp || typeof rncp !== 'object') {
        console.warn('[build-vault] RNCP_REFERENTIEL introuvable ou vide.');
        return fiches;
    }

    // 1) Fiche synthèse "Rôle du CIP" (combine toutes les sections du RNCP).
    const sections = Object.entries(rncp);
    if (sections.length > 0) {
        const lines = sections.map(([title, data]) => {
            const label = data.desc || data.short || title;
            return `- ${title} (${label})`;
        });
        fiches.push({
            id: 'vault-role-cip',
            title: 'Rôle du Conseiller en Insertion Professionnelle (CIP)',
            content:
                `Le métier de Conseiller en Insertion Professionnelle est structuré par le référentiel RNCP en blocs de compétences :\n\n` +
                lines.join('\n') +
                `\n\nLe CIP exerce ces missions de façon coordonnée pour faciliter l'insertion professionnelle des personnes accompagnées, dans une démarche éthique, partenariale et territoriale.`,
            category: 'synthese-rncp',
            source: 'RNCP_REFERENTIEL',
        });
    }

    // 2) Une fiche "Présentation" par section RNCP (CCP1, CCP2, CCP3, Transversal).
    for (const [sectionTitle, sectionData] of sections) {
        const competences = sectionData.competences || [];
        const competencesList = competences
            .map(c => `- ${c.code} — ${c.label}`)
            .join('\n');
        fiches.push({
            id: `vault-${slugify(sectionTitle)}`,
            title: sectionTitle,
            content:
                `${sectionData.short || sectionTitle}\n\n` +
                (competences.length > 0
                    ? `Compétences professionnelles incluses :\n${competencesList}`
                    : 'Aucune compétence détaillée.'),
            category: 'ccp-presentation',
            source: 'RNCP_REFERENTIEL',
        });

        // 3) Une fiche détaillée par compétence individuelle (CP1..CP19, CT1..CT2).
        for (const comp of competences) {
            const criteres = (comp.criteres || []).map(c => `- ${c}`).join('\n');
            fiches.push({
                id: `vault-${slugify(comp.code)}`,
                title: `${comp.code} — ${comp.label}`,
                content:
                    `Compétence du bloc « ${sectionTitle} » (${sectionData.short || sectionTitle}).\n\n` +
                    `Critères de performance officiels :\n${criteres || '- (aucun critère listé)'}`,
                category: 'competence',
                source: 'RNCP_REFERENTIEL',
            });
        }
    }

    return fiches;
}

function extractFromGlossaire(glossaire) {
    if (!Array.isArray(glossaire)) {
        console.warn('[build-vault] CIP_GLOSSAIRE introuvable ou non-tableau.');
        return [];
    }
    return glossaire
        .filter(g => g && g.terme && g.def)
        .map(g => ({
            id: `vault-glossaire-${slugify(g.terme)}`,
            title: `${g.terme} (glossaire)`,
            content:
                `**${g.terme}** : ${g.def}` +
                (g.cp ? `\n\nCompétence RNCP associée : ${g.cp}.` : ''),
            category: 'glossaire',
            source: 'CIP_GLOSSAIRE',
        }));
}

function extractFromFAQ() {
    if (!fs.existsSync(FAQ_JSON)) {
        console.warn('[build-vault] data/faq-cip.json introuvable — aucune fiche FAQ.');
        return [];
    }
    let faq;
    try {
        faq = JSON.parse(fs.readFileSync(FAQ_JSON, 'utf-8'));
    } catch (e) {
        console.error('[build-vault] faq-cip.json illisible :', e.message);
        return [];
    }
    if (!Array.isArray(faq)) {
        console.warn('[build-vault] faq-cip.json non-tableau.');
        return [];
    }
    return faq
        .filter(f => f && f.question && f.answer)
        .map(f => ({
            id: `vault-faq-${slugify(f.id || f.question)}`,
            title: f.question,
            content: f.answer,
            category: 'faq',
            source: 'FAQ_CURATED',
        }));
}

// --- v9.11.0 : sous-corpus utilisateur (data/vault/*.md) -----------------------

// Liste récursivement les .md de data/vault/, en ignorant les fichiers dont le nom
// commence par '_' (templates/brouillons) ou '.' (cachés). Dossier absent = vault vide.
function listMarkdownFiles(dir) {
    const out = [];
    let entries;
    // Tri obligatoire, meme raison que dans build-rag-index.js : l'ordre de readdirSync
    // depend du systeme de fichiers, ce qui rend l'index non reproductible entre le poste
    // Windows et le runner Ubuntu de la CI.
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
    catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { out.push(...listMarkdownFiles(full)); continue; }
        if (!e.name.toLowerCase().endsWith('.md')) continue;
        if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
        out.push(full);
    }
    return out;
}

// Sépare le frontmatter YAML simple (clé: valeur) du corps Markdown.
function parseFrontmatter(raw) {
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!m) return { meta: {}, body: raw };
    const meta = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (kv) meta[kv[1].trim().toLowerCase()] = kv[2].trim();
    }
    return { meta, body: raw.slice(m[0].length) };
}

// Nettoie le Markdown : strip wikilinks (garde le texte), liens/images, marqueurs.
function cleanMarkdown(text) {
    return String(text)
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')   // [[lien|alias]] -> alias
        .replace(/\[\[([^\]]+)\]\]/g, '$1')               // [[lien]] -> lien
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')             // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // [texte](url) -> texte
        .replace(/^#{1,6}\s+/gm, '')                       // titres #
        .replace(/[*_`>]/g, '')                            // emphase / inline code / quote
        .replace(/\r/g, '')
        .trim();
}

// Découpe sur les frontières de paragraphe, chunks ~maxLen caractères.
function chunkText(text, maxLen = 800) {
    const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let cur = '';
    for (const p of paras) {
        if (cur && (cur.length + p.length + 2) > maxLen) { chunks.push(cur); cur = ''; }
        cur = cur ? cur + '\n\n' + p : p;
        if (cur.length > maxLen) { chunks.push(cur); cur = ''; }
    }
    if (cur) chunks.push(cur);
    return chunks;
}

function extractFromUserVault() {
    const files = listMarkdownFiles(USER_VAULT_DIR);
    if (files.length === 0) {
        console.log('[build-vault] data/vault/ vide ou absent — aucune note user.');
        return [];
    }
    const fiches = [];
    for (const file of files) {
        let raw;
        try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        const { meta, body } = parseFrontmatter(raw);
        const base = path.basename(file, '.md');
        const title = meta.title || base.replace(/[-_]+/g, ' ');
        const clean = cleanMarkdown(body);
        if (!clean) continue;
        const chunks = chunkText(clean, 800);
        chunks.forEach((chunk, i) => {
            fiches.push({
                id: `vault-user-${slugify(base)}-${i}`,
                title: chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title,
                content: chunk,
                category: 'user-note',
                source: 'USER_VAULT',
            });
        });
    }
    return fiches;
}

function main() {
    const { rncp, glossaire } = loadDataJs();
    const fiches = [
        ...extractFromRNCP(rncp),
        ...extractFromGlossaire(glossaire),
        ...extractFromFAQ(),
        ...extractFromUserVault(),
    ];

    fs.writeFileSync(OUTPUT, JSON.stringify(fiches, null, 2), 'utf-8');

    const byCat = {};
    for (const f of fiches) byCat[f.category] = (byCat[f.category] || 0) + 1;

    console.log(`[build-vault] ${fiches.length} fiches générées → ${path.relative(process.cwd(), OUTPUT)}`);
    for (const [cat, n] of Object.entries(byCat)) {
        console.log(`  - ${cat} : ${n}`);
    }
}

main();
