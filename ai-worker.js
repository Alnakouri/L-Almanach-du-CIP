// ai-worker.js — utilityProcess dédié à l'IA (v8.9.0).
// Avant : le chargement du modèle (1,9 Go) et la génération tournaient dans le main
// process Electron, qui pompe la boucle d'événements des fenêtres → l'app entière
// gelait pendant le load et chaque génération. Ce worker isole transformers.js +
// onnxruntime-node dans un process Node séparé (chemin validé en Node pur, v8.2.0).
// Protocole : reçoit { type:'load'|'run', requestId, ... } via process.parentPort,
// répond { type:'result', requestId, result } et émet { type:'progress', data }.
const path = require('path');
const fs = require('fs');

const MODEL_CACHE = path.join(__dirname, 'models');
let aiPipeline = null;

const post = (msg) => process.parentPort.postMessage(msg);

async function handleLoad({ requestId, modelId }) {
    try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = MODEL_CACHE;
        env.localModelPath = MODEL_CACHE;

        const localModelDir = path.join(MODEL_CACHE, modelId);
        const isLocallyAvailable = fs.existsSync(localModelDir) &&
            fs.readdirSync(localModelDir).length > 0;

        if (isLocallyAvailable) {
            env.allowRemoteModels = false;
            env.allowLocalModels = true;
            post({ type: 'progress', data: { status: 'init', message: `Modèle local détecté dans ${localModelDir} — démarrage hors-ligne…` } });
        } else {
            env.allowRemoteModels = true;
            post({ type: 'progress', data: { status: 'downloading', message: 'Téléchargement du modèle (~900 Mo)…' } });
        }

        // v8.2.0 : tous les modèles sont en q4 (poids int4, activations fp32) — seul
        // format utilisable sur le CPU d'onnxruntime-node (q4f16 = GPU only).
        // v9.16.0 : mesure RSS autour du chargement — le modèle vit DANS ce worker
        // (utilityProcess), donc process.memoryUsage().rss capture son vrai coût RAM.
        const _rssBefore = process.memoryUsage().rss;
        aiPipeline = await pipeline('text-generation', modelId, {
            dtype: 'q4',
            progress_callback: (p) => {
                if (p.status === 'progress') {
                    post({ type: 'progress', data: {
                        status: 'progress', file: p.file || '', loaded: p.loaded || 0,
                        total: p.total || 0, progress: p.progress || 0
                    } });
                } else if (p.status === 'done') {
                    post({ type: 'progress', data: { status: 'done', message: 'Modèle prêt !' } });
                }
            }
        });
        const modelRamMB = Math.round((process.memoryUsage().rss - _rssBefore) / 1024 / 1024);
        console.log('[IA worker] RAM RSS modèle : +' + modelRamMB + ' Mo (RSS total worker : ' + Math.round(process.memoryUsage().rss / 1024 / 1024) + ' Mo)');

        post({ type: 'result', requestId, result: { success: true, offline: isLocallyAvailable, modelRamMB } });
    } catch (e) {
        post({ type: 'result', requestId, result: { success: false, error: e.message || String(e) } });
    }
}

async function handleRun({ requestId, text, context, stream }) {
    if (!aiPipeline) {
        post({ type: 'result', requestId, result: { success: false, error: 'IA non chargée' } });
        return;
    }
    try {
        // v7.7.2 : préfixe assistant conditionnel — quand le contexte contient une fiche VAULT
        // (référentiel officiel), on amorce la génération pour forcer l'exploitation du contenu
        // canonique au lieu de paraphraser génériquement.
        const hasVault = (context || '').includes('--- VAULT (référentiel officiel)');
        const assistantPrefix = hasVault ? "D'après le référentiel officiel :\n\n" : "";
        const prompt = `<|im_start|>system\nTu es un assistant pédagogique expert pour les Conseillers en Insertion Professionnelle (CIP). Règles strictes : (1) Réponds TOUJOURS en français. (2) Sois CONCIS : 3 à 5 phrases courtes maximum, ou 3 à 5 points si liste. EXCEPTION : si le contexte contient une liste officielle (CCP, compétences, blocs, dispositifs nommés), reproduis-la intégralement — elle ne compte pas dans la limite. (3) Base ta réponse UNIQUEMENT sur le CONTEXTE fourni. (4) Si le contexte ne couvre PAS exactement la question (ex : question générale mais contexte spécifique), réponds quand même en te basant sur ce qui est disponible, mais signale-le. (5) Si le contexte est totalement hors-sujet, dis "Je n'ai pas cette information dans les cours" sans inventer. (6) Si le contexte NE CONTIENT PAS de définition littérale de ce qui est demandé (ex : on demande "rôle du CIP" mais le contexte ne parle que d'examen oral ou de procédures), DIS-LE EXPLICITEMENT en première phrase ("Le contexte ne donne pas de définition littérale de X, mais voici ce qui s'en rapproche : ...") puis paraphrase UNIQUEMENT ce qui est présent dans le contexte. INTERDICTION ABSOLUE d'ajouter des éléments non présents (formations, dispositifs, structures, missions, etc.) — même s'ils paraissent évidents ou de bon sens.<|im_end|>\n<|im_start|>user\nCONTEXTE :\n${context || 'Aucun contexte disponible.'}\n\nQUESTION : ${text}<|im_end|>\n<|im_start|>assistant\n${assistantPrefix}`;

        // v8.9.4 : streaming — pour le chat (stream=true), chaque fragment décodé est
        // posté immédiatement vers main.js qui le relaie au renderer (canal 'ai-chunk').
        // Le message 'result' final reste la source de vérité (texte complet nettoyé).
        let streamer;
        if (stream) {
            const { TextStreamer } = await import('@huggingface/transformers');
            let firstChunk = true;
            streamer = new TextStreamer(aiPipeline.tokenizer, {
                skip_prompt: true,
                skip_special_tokens: true,
                callback_function: (t) => {
                    if (t) {
                        if (firstChunk) {
                            firstChunk = false;
                            post({ type: 'chunk', requestId, text: assistantPrefix + t });
                        } else {
                            post({ type: 'chunk', requestId, text: t });
                        }
                    }
                }
            });
        }

        const t0 = Date.now();
        const output = await aiPipeline(prompt, {
            // v8.1.0 : décodage GREEDY pour reproduire exactement les conditions du
            // banc d'éval du modèle fine-tuné CIP (do_sample=False, 77,1 %).
            // v8.9.2 : retour à repetition_penalty 1.1 (valeur du banc d'éval) et
            // suppression de no_repeat_ngram_size — ces pénalités s'appliquent au
            // contexte RAG inclus dans le prompt et empêchaient le modèle de
            // recopier verbatim les termes officiels (fautes « insersion »,
            // « Conciliateur », codes CCP inventés).
            max_new_tokens: 350,
            do_sample: false,
            repetition_penalty: 1.1,
            return_full_text: false,
            streamer,
        });

        // v8.2.1 : return_full_text:false → output ne contient que la continuation générée.
        let response = (output[0]?.generated_text || '')
            .replace(/<\|im_end\|>[\s\S]*$/, '')
            .trim();
        // Le préfixe VAULT faisait partie du prompt → absent de la continuation,
        // on le ré-ajoute pour conserver l'amorce « D'après le référentiel officiel ».
        if (assistantPrefix) response = assistantPrefix + response;

        // v8.9.3 : genMs = durée de la génération seule (sans IPC ni file d'attente),
        // promptChars = taille du prompt envoyé au modèle. Lus par ai-helper.js pour
        // le chrono console de diagnostic.
        post({ type: 'result', requestId, result: { success: true, text: response || 'Aucune réponse générée.', genMs: Date.now() - t0, promptChars: prompt.length } });
    } catch (e) {
        post({ type: 'result', requestId, result: { success: false, error: e.message || String(e) } });
    }
}

process.parentPort.on('message', (e) => {
    const msg = (e && e.data) || {};
    if (msg.type === 'load') handleLoad(msg);
    else if (msg.type === 'run') handleRun(msg);
});
