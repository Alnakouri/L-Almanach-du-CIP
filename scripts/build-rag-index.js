#!/usr/bin/env node
/**
 * Pré-agrège tous les JSONs de data/content/*.json en un seul data/rag-index.json
 * format : [{ file, title, content_text }, ...]
 *
 * Lancé manuellement ou via `npm run build-rag` (cf PATCH 3 package.json).
 * Doit être ré-exécuté à chaque ajout/modification de chapitre.
 *
 * v7.4.3 — fix dette RAG : sans ce fichier, MiniSearch n'indexe que les titres,
 * jamais le contenu, donc SmolLM2 reçoit un contexte vide et hallucine.
 */

const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '..', 'data', 'content');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'rag-index.json');

function main() {
    if (!fs.existsSync(CONTENT_DIR)) {
        console.error('[build-rag] Dossier introuvable :', CONTENT_DIR);
        process.exit(1);
    }

    // .sort() OBLIGATOIRE : readdirSync suit l'ordre du systeme de fichiers — trie sur
    // NTFS, en ordre de hachage sur ext4. Sans tri, l'index genere sous Windows et
    // celui genere par la CI Ubuntu different par l'ordre du tableau a contenu egal,
    // et l'etape « Index RAG et vault a jour » echoue en boucle. Tri par unite de code
    // UTF-16 (pas localeCompare, qui depend de la locale du runner).
    const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.json')).sort();
    console.log(`[build-rag] ${files.length} fichiers JSON détectés.`);

    const index = [];
    let errors = 0;
    for (const file of files) {
        const fullPath = path.join(CONTENT_DIR, file);
        try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const data = JSON.parse(raw);
            const contentArr = Array.isArray(data.content) ? data.content : [];
            const content_text = contentArr
                .map(p => String(p).trim())
                .filter(p => p.length > 0)
                .join('\n\n');
            if (!content_text) {
                console.warn(`[build-rag] ${file} : content vide, skipped`);
                continue;
            }
            index.push({
                file,
                title: String(data.title || file).replace(/\.pdf$/i, ''),
                content_text
            });
        } catch (e) {
            errors++;
            console.warn(`[build-rag] ${file} : parse error — ${e.message}`);
        }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(index));
    const sizeKB = Math.round(fs.statSync(OUTPUT_FILE).size / 1024);
    console.log(`[build-rag] OK — ${index.length} chapitres indexés, ${sizeKB} KB, ${errors} erreurs.`);
    console.log(`[build-rag] Output : ${OUTPUT_FILE}`);
}

main();
