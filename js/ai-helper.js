/**
 * AI Helper — L'Almanach du CIP
 * TTS phrase par phrase + Chat IA via Electron IPC (main process)
 * v6.9.2 : speakAs/stopSimSpeak délèguent au TTS Router via dynamic import.
 */

// ─── Helpers RAG (v7.5.0) ────────────────────────────────────────────
// Stopwords FR minimaux : mots vides interrogatifs + grammaticaux fréquents.
// Volontairement restreint — on garde tout ce qui pourrait porter du sens
// même partiellement (ex : « rôle », « projet », « accompagnement »).
const STOPWORDS_FR = new Set([
    'le','la','les','un','une','des','de','du','d','l','au','aux',
    'et','ou','mais','donc','car','ni','or',
    'que','qui','quoi','quel','quelle','quels','quelles','ou','où',
    'comment','pourquoi','quand','combien',
    'à','avec','sans','sur','sous','dans','par','pour','vers','chez','entre',
    'est','sont','etre','être','suis','es','sera','etait','était',
    'a','as','ont','avoir','avait',
    'ce','cet','cette','ces','ca','ça','cela',
    'mon','ma','mes','ton','ta','tes','son','sa','ses','notre','votre','leur','leurs',
    'je','tu','il','elle','nous','vous','ils','elles','on',
    'me','te','se','lui','en','y',
    'pas','plus','tres','très','aussi','tout','tous','toute','toutes',
    'autre','autres','meme','même','si','non','oui',
]);

function _extractQueryKeywords(query) {
    if (!query || typeof query !== 'string') return [];
    return query
        .toLowerCase()
        // Retire accents pour matching tolérant (̀-ͯ = combining diacriticals)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        // Tokenize : tout ce qui n'est pas lettre/chiffre devient séparateur
        .split(/[^a-z0-9]+/)
        .filter(w => w.length >= 3 && !STOPWORDS_FR.has(w));
}

// Extrait le titre "racine" d'un chapitre en strippant le suffixe numérique
// (ex : "Le métier 7" → "Le métier", "Du projet -2" → "Du projet").
// 517/596 chapitres ont un suffixe numérique → la dédup est indispensable.
function _chapterRoot(title) {
    if (!title || typeof title !== 'string') return '';
    return title
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        // Strip : espace + tiret optionnel + chiffres (+ lettre f optionnelle + chiffres) en fin
        .replace(/\s+-?\d+[a-z]?\d*\s*$/, '')
        .trim();
}

// v9.12.0 : routing souple par "room" thématique. _routeToRooms() repère les rooms pertinentes
// pour la requête (matching de vocabulaire, tokens accent-strippés alignés sur _extractQueryKeywords).
// Les docs de ces rooms reçoivent un BONUS de re-ranking (ROOM_BONUS) — jamais d'exclusion.
// 'notes-perso' est TOUJOURS routée : les notes de l'utilisateur sont candidates par défaut
// (sans jamais écraser une fiche officielle, cf USER_NOTE_BONUS + ROOM_BONUS = 90 < VAULT_BONUS 100).
const ROOM_KEYWORDS = {
    ccp1: ['accueil','accueillir','recevoir','premier','contact','diagnostic','demande','analyser','analyse','besoin','besoins','ecoute','posture','reformulation'],
    ccp2: ['accompagner','accompagnement','parcours','projet','professionnel','frein','freins','mobilisation','suivi','atelier','autonomie','plan','action','insertion'],
    ccp3: ['employeur','employeurs','entreprise','entreprises','prospection','prospecter','offre','recrutement','marche','travail','placement','relation','demarcher','partenaire'],
    transversal: ['gestion','organisation','planification','veille','numerique','outil','outils','reglementation','reseau','partenariat','administratif','juridique'],
};

function _routeToRooms(keywords) {
    const rooms = new Set(['notes-perso']); // les notes user sont toujours candidates
    const kw = new Set(keywords);
    for (const room in ROOM_KEYWORDS) {
        if (ROOM_KEYWORDS[room].some(v => kw.has(v))) rooms.add(room);
    }
    return rooms;
}

class AIHelper {
    constructor() {
        this.synth = window.speechSynthesis;
        this.synth.getVoices();
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = () => this.synth.getVoices();
        }
        this.isSpeaking = false;
        this.pipeline = null; // true quand l'IA est prête dans le main process
        this.isModelLoading = false;
        this.currentAudio = null;     // <audio> en cours de lecture
        this.piperSession = null;
        this.isPiperLoading = false;

        // Vérifier si l'IA est déjà chargée dans le main process
        if (window.electronAPI) {
            window.electronAPI.isAIReady().then(ready => {
                if (ready) this.pipeline = true;
            });
        }

        this.initChat();
    }

    initChat() {
        const fab = document.getElementById('fabChat');
        const chat = document.getElementById('aiChat');
        const close = document.getElementById('closeChat');
        const send = document.getElementById('sendMsg');
        const input = document.getElementById('chatInput');

        // Garde-fous : si un seul élément manque, ne pas crasher tout l'init. (v6.8.3)
        if (!fab || !chat || !close || !send || !input) {
            console.warn('[AIHelper] Éléments du chat manquants, init partielle :', {
                fab: !!fab, chat: !!chat, close: !!close, send: !!send, input: !!input
            });
            return;
        }

        fab.onclick = () => {
            chat.classList.toggle('hidden');
            if (!this.pipeline && !this.isModelLoading) this.loadModel();
        };
        close.onclick = () => chat.classList.add('hidden');
        send.onclick = () => this.handleMessage();
        input.onkeypress = (e) => { if (e.key === 'Enter') this.handleMessage(); };

        // v8.8.0→v9.16.0 : pré-warm automatique au boot RETIRÉ en v9.17.0.
        // Constat (logs user 22/06) : charger le modèle Qwen-CIP (~2,7 Go RSS mesurés
        // v9.16.0) 2 s après le boot rendait le démarrage poussif (DevTools lente, I/O
        // disque) et entrait en concurrence avec le warmup TTS + la 1ʳᵉ lecture. Le
        // modèle se charge désormais UNIQUEMENT à la 1ʳᵉ ouverture du chat (fab.onclick,
        // plus haut) → boot léger, au prix d'un cold-start ponctuel au premier message
        // (choix produit assumé). Le log [IA] RAM modèle chargé (v9.16.0) reste actif sur
        // ce chemin et sert toujours de baromètre RAM.
    }

    // v8.8.0 : silent=true (pre-warm au boot) supprime les messages préliminaires
    // dans le chat fermé ; le pulse du fab et les messages de fin restent.
    async loadModel(silent = false) {
        // v9.32.0 : le modèle ne tourne que dans l'application de bureau, rien à télécharger en web.
        if (!window.electronAPI) {
            if (!silent) this.addMessage("ℹ️ L'assistant IA tourne dans l'application de bureau : il n'est pas inclus dans la version web. Posez quand même votre question, la recherche locale vous orientera vers le bon module.", 'system');
            return;
        }
        if (localStorage.getItem('almanach_ai_installed') !== 'true') {
            if (!silent) this.addMessage("⚠️ L'IA n'est pas installée. Ouvrez 📊 État Système et cliquez sur \"Télécharger l'IA\" (~900 Mo pour Qwen 2.5).", 'system');
            return;
        }
        this.isModelLoading = true;
        const fab = document.getElementById('fabChat');
        fab.style.animation = 'pulse 1.5s infinite';
        fab.title = "Chargement de l'IA...";
        if (!silent) this.addMessage("Chargement de l'IA depuis le cache local...", 'system');

        try {
            const result = await window.electronAPI.downloadAI((p) => {
                if (p.status === 'progress' && p.total) {
                    const pct = Math.round((p.loaded / p.total) * 100);
                    fab.innerText = `${pct}%`;
                }
            });

            if (result.success) {
                this.pipeline = true;
                if (typeof result.modelRamMB === 'number') console.log('[IA] RAM modèle chargé : ~' + result.modelRamMB + ' Mo (process worker dédié)');
                fab.style.animation = 'none';
                fab.style.boxShadow = '0 0 15px var(--accent)';
                fab.innerText = '🤖';
                fab.title = "IA prête !";
                this.addMessage("✅ IA prête ! Posez vos questions sur le CIP.", 'system');
            } else {
                throw new Error(result.error);
            }
        } catch (e) {
            fab.style.animation = 'none';
            fab.innerText = '🤖';
            this.addMessage("❌ Erreur : " + (e?.message || String(e)), 'system');
        } finally {
            this.isModelLoading = false;
        }
    }

    // Appelé depuis app.js pour le bouton "Télécharger l'IA"
    // v7.4.4 : accepte un modelId optionnel pour permettre de basculer entre modèles
    // (Qwen 2.5 1.5B par défaut, SmolLM2 en fallback). Sans cet arg, le main process
    // utilise son currentModelId (initialement Qwen 2.5 1.5B depuis main.js:14).
    async loadModelWithProgress(onProgress, modelId) {
        if (!window.electronAPI) throw new Error("API Electron non disponible");
        const _t0 = performance.now();
        window.electronAPI.removeListener('ai-download-progress');
        const result = await window.electronAPI.downloadAI(onProgress, modelId);
        if (!result.success) throw new Error(result.error);
        this.pipeline = true;
        console.log(`[Chrono] chargement modèle IA : ${Math.round(performance.now() - _t0)} ms`);
        if (typeof result.modelRamMB === 'number') console.log('[IA] RAM modèle chargé : ~' + result.modelRamMB + ' Mo (process worker dédié)');
    }

    async buildRagContext(query) {
        // v8.7.0 : reset systématique du flag de réponse extractive (voir plus bas).
        // Doit être remis à null à CHAQUE appel, avant tout return anticipé.
        this._lastDirectAnswer = null;
        // v7.4.3 : attend l'enrichissement async de l'index (rag-index.json).
        // Sans cet await, l'appel arrivant avant la fin du fetch tombe sur un index
        // contenant seulement les titres → 0 match sur question sémantique.
        if (window.appRagIndexReady) {
            try { await window.appRagIndexReady; } catch (e) { /* swallow, on continue */ }
        }
        if (!window.appSearchIndex) {
            console.warn('[RAG] appSearchIndex indisponible — context vide');
            return "";
        }

        // v7.4.3 : MiniSearch.search() n'a pas d'option `limit`. On utilise prefix+fuzzy
        // (le boost et le fuzzy sont déjà dans les searchOptions globaux mais on les
        // ré-affirme par sécurité) puis slice(0, 5) pour garder les 5 meilleurs.
        // v7.5.0 : on ne slice PAS encore — le re-ranker (étape suivante)
        // a besoin de la liste complète des candidats pour appliquer ses scores.
        const rawResults = window.appSearchIndex.search(query, {
            prefix: true,
            fuzzy: 0.15
        });

        // v8.5.1 : RAG LEXICAL pur (rollback). Les étages sémantiques (e5 cosinus v8.4.0,
        // reranker bge v8.5.0) n'ont pas amélioré la qualité — 3 méthodes butent sur la même
        // limite : le corpus ne couvre pas certains thèmes (ex. « accueil »). Le reranker
        // chargeait en plus un 2ᵉ modèle qui faisait freezer l'app. Goulot = corpus, pas
        // retrieval. (IPC/modèles e5 + reranker supprimés en v8.8.0.)
        const keywords = _extractQueryKeywords(query);
        const routedRooms = _routeToRooms(keywords);
        const normTitle = (t) => (t || '').toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
        const VAULT_BONUS = 100;
        const USER_NOTE_BONUS = 50;  // v9.11.0 : notes user = complément, jamais > fiche officielle
        const ROOM_BONUS = 40;       // v9.12.0 : nudge souple pour un doc d'une room routée
        const SCORE_MIN_RATIO = 0.30;
        const FAQ_DOMINANCE_RATIO = 1.4;  // v8.7.0 : seuil de domination pour la réponse extractive

        const reranked = rawResults.map(r => {
            const titleN = normTitle(r.title);
            const keywordHits = keywords.filter(k => titleN.includes(k)).length;
            const isVault = r.type === 'VAULT';
            const isUserNote = isVault && r.module === 'user-note';
            const vaultBonus = isUserNote ? USER_NOTE_BONUS : (isVault ? VAULT_BONUS : 0);
            const roomBonus = routedRooms.has(r.room) ? ROOM_BONUS : 0;
            const bonus = keywordHits * 20 + vaultBonus + roomBonus;
            return { ...r, _adjScore: r.score + bonus, _keywordHits: keywordHits, _isVault: isVault };
        }).sort((a, b) => b._adjScore - a._adjScore);
        console.log('[RAG] LEXICAL | query =', JSON.stringify(query), '|', rawResults.length,
            'candidats →', reranked.slice(0, 5).map(r => `${r.title} (s=${r._adjScore.toFixed(1)})`));
        console.log('[RAG] rooms routées :', [...routedRooms].join(', '));

        const topScore = reranked.length > 0 ? reranked[0]._adjScore : 0;
        const filtered = reranked.filter(r => r._adjScore >= topScore * SCORE_MIN_RATIO);

        // v7.5.0 : dédup par "chapitre racine" — pour chaque cours (titre sans
        // suffixe numérique), on garde uniquement la sous-partie la mieux classée.
        // 517/596 titres ont un suffixe numérique → sans dédup, le top 3 peut
        // ramener 3 sous-parties du même cours et appauvrir le contexte injecté.
        const seenRoots = new Set();
        const deduped = [];
        for (const r of filtered) {
            const root = _chapterRoot(r.title);
            if (seenRoots.has(root)) continue;
            seenRoots.add(root);
            deduped.push(r);
        }

        const results = deduped.slice(0, 3);
        console.log('[RAG] après filtre score (≥', (topScore * SCORE_MIN_RATIO).toFixed(1),
            ') + dédup :', deduped.length, '| top 3 retenu :', results.length);

        // v7.5.0 : log des sources effectivement retenues (pour audit RAG)
        if (results.length > 0) {
            console.log('[RAG] sources retenues :', results.map(r =>
                `"${r.title}" (s=${r._adjScore.toFixed(1)})`
            ).join(' | '));
        }

        // v8.7.0 : réponse extractive. Une fiche FAQ curée EST déjà la réponse idéale ;
        // laisser le 1.5B la paraphraser ne fait que la dégrader (fautes, charabia,
        // invention — cf test accueil v8.6.0). Si une fiche FAQ domine nettement le top
        // (score ≥ FAQ_DOMINANCE_RATIO × #2) ET matche au moins 1 mot-clé de la query
        // (garde-fou anti-faux-positif sur le seul VAULT_BONUS), on stocke sa réponse
        // pour que handleMessage la serve verbatim et court-circuite le LLM.
        const _top = results[0];
        if (_top && _top.type === 'VAULT' && _top.module === 'faq' && _top.content
                && _top._keywordHits >= 1) {
            // v8.7.2 : on compare au score de la prochaine AUTRE fiche FAQ (pas à un chapitre
            // brut). Une fiche FAQ #1 sur un sujet est la réponse idéale même si un chapitre
            // topique la talonne (cf « comment bien écouter » : FAQ 326 vs chapitre 320, ratio
            // 1,02 → bloquait à tort). Le ratio ne sert qu'à écarter une ambiguïté FAQ↔FAQ.
            const _nextFaq = reranked.find((r, i) =>
                i > 0 && r.type === 'VAULT' && r.module === 'faq');
            const _nextFaqScore = _nextFaq ? _nextFaq._adjScore : 0;
            if (_top._adjScore >= _nextFaqScore * FAQ_DOMINANCE_RATIO) {
                this._lastDirectAnswer = { title: _top.title, answer: _top.content };
                console.log('[RAG] FAQ dominante → réponse extractive :', JSON.stringify(_top.title));
            }
        }

        if (results.length === 0) return "Aucun document trouvé.";

        const contextParts = [];
        for (const res of results) {
            // v7.7.0 : nouveau type VAULT — fiche pré-agrégée depuis RNCP + glossaire.
            // Le contenu est déjà en mémoire dans l'index, on l'injecte en priorité avec
            // un marqueur explicite « VAULT (référentiel officiel) » pour signaler à
            // Qwen que la source est canonique et qu'il ne doit pas extrapoler au-delà.
            if (res.type === 'VAULT' && res.content) {
                contextParts.push(`--- VAULT (référentiel officiel) : ${res.title} ---\n${res.content}`);
                continue;
            }
            // v7.4.3 : nouveau type CONTENT_CHUNK — contenu déjà en mémoire dans l'index.
            // Pas de refetch HTTP nécessaire, on lit directement res.content.
            if (res.type === 'CONTENT_CHUNK' && res.content) {
                contextParts.push(`--- SOURCE : ${res.title} ---\n${res.content}`);
                continue;
            }
            // Anciens types (DOCUMENT/CHAPITRE isFile=true) : refetch du JSON et lecture data.content.
            if (res.isFile) {
                try {
                    const fileName = (res.item || res.title + '.pdf').replace(/\.pdf$/i, '.json');
                    const resp = await fetch(`./data/content/${encodeURIComponent(fileName)}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        const sections = (data.content || [])
                            .map(p => String(p).trim())
                            .filter(p => p.length > 0)
                            .join('\n\n');
                        if (sections) contextParts.push(`--- SOURCE : ${res.title} ---\n${sections}`);
                    }
                } catch (e) {
                    console.error('[RAG] fetch error pour', res.title, ':', e);
                }
            } else if (res.isGlossaire) {
                contextParts.push(`--- GLOSSAIRE : ${res.title} ---\n${res.module}`);
            } else if (res.isNote) {
                contextParts.push(`--- MA NOTE : ${res.title} ---\n${(res.item && res.item.text) || ''}`);
            }
        }

        const ctx = contextParts.join('\n\n');
        // v7.4.3 : tronque à 8000 caractères pour éviter dépassement de contexte SmolLM2 (4096 tokens ~ 16000 chars max, on garde une marge).
        const MAX_CTX = 4000;
        const truncated = ctx.length > MAX_CTX ? ctx.substring(0, MAX_CTX) + '\n\n[... contexte tronqué ...]' : ctx;
        console.log('[RAG] context length =', truncated.length, 'chars');
        return truncated;
    }

    // v9.30.0 : détecte les saluts / formules de politesse courtes sans contenu
    // question. Volontairement conservateur : au moindre mot interrogatif on laisse
    // passer vers le RAG + modèle.
    _isSmalltalk(text) {
        const t = text.toLowerCase().replace(/[!?.,;:\s]+/g, ' ').trim();
        const greetings = ['bonjour', 'bonsoir', 'salut', 'hello', 'coucou', 'hey', 'yo',
            'merci', 'merci beaucoup', 'ok', 'ca va', 'ça va', 'au revoir',
            'a plus', 'à plus', 'bonne journée', 'bonne journee', 'bonne soirée', 'bonne soiree'];
        if (greetings.includes(t)) return true;
        const words = t.split(' ');
        if (words.length <= 3 && greetings.includes(words[0])
            && !/\b(qui|que|quoi|quel|quelle|quels|quelles|comment|pourquoi|combien|où|quand)\b/.test(t)) return true;
        return false;
    }

    async handleMessage() {
        // v8.9.0 : pas d'envoi concurrent — l'app ne gèle plus pendant la
        // génération (IA en utilityProcess), le bouton reste donc cliquable.
        if (this._isGenerating) return;
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text) return;

        this.addMessage(text, 'user');
        input.value = '';

        // v9.30.0 : garde smalltalk — un salut ne doit PAS déclencher le RAG
        // (MiniSearch matche les chapitres d'accueil de formation et le modèle,
        // fidèle au contexte, les récite). Réponse canée instantanée, zéro coût.
        if (this._isSmalltalk(text)) {
            const tLow = text.toLowerCase();
            const bye = tLow.startsWith('merci') || tLow.startsWith('au revoir')
                || tLow.startsWith('a plus') || tLow.startsWith('à plus') || tLow.startsWith('bonne ');
            this.addMessage(bye
                ? "Avec plaisir ! N'hésitez pas si vous avez d'autres questions sur le CIP. 👍"
                : "Bonjour ! 👋 Posez-moi une question sur la formation CIP — par exemple « quel est le rôle du CIP ? » ou « comment préparer un entretien ? ».", 'system');
            return;
        }

        // Fallback MiniSearch si l'IA n'est pas chargée
        if (!this.pipeline) {
            const aideIA = window.electronAPI
                ? "cliquez sur 🤖 pour charger l'IA complète"
                : "l'IA complète n'existe que dans l'application de bureau";
            if (window.appSearchIndex) {
                const results = window.appSearchIndex.search(text, { prefix: true, fuzzy: 0.3, limit: 5 });
                if (results.length > 0) {
                    const top = results[0];
                    const others = results.slice(1, 3).map(r => `**${r.title}**`).join(', ');
                    let answer = `📚 **${top.title}** (${top.module.split('-')[0].trim()}) correspond à votre question.\n\n`;
                    if (others) answer += `Voir aussi : ${others}.\n\n`;

                    answer += `💡 Naviguez dans la sidebar pour accéder directement aux modules concernés.`;
                    answer += `\n\n⚠️ *Mode recherche — ${aideIA}.*`;
                    this.addMessage(answer, 'system');
                } else {
                    this.addMessage(`Aucun résultat pour "${text}".\n\n⚠️ *Mode recherche — ${aideIA}.*`, 'system');
                }
            }
            return;
        }

        this._isGenerating = true;
        this.addMessage("Réflexion en cours...", 'system', 'thinking-msg');

        // Contexte RAG réel (Phase 2 v6.7)
        let context = "";
        try {
            context = await this.buildRagContext(text);
        } catch (e) {
            console.warn("RAG error:", e);
            context = "Erreur de récupération du contexte cours.";
        }

        // v8.7.0 : court-circuit extractif — si buildRagContext a détecté une fiche FAQ
        // dominante, on sert sa réponse curée telle quelle (zéro hallucination, instantané)
        // sans solliciter le 1.5B qui ne ferait que la dégrader.
        if (this._lastDirectAnswer) {
            this._isGenerating = false;
            this.removeMessage('thinking-msg');
            this.addMessage("D'après le référentiel officiel :\n\n" + this._lastDirectAnswer.answer, 'system');
            return;
        }

        try {
            const t0 = Date.now();
            // v8.9.4 : streaming — les fragments arrivent via 'ai-chunk' pendant la
            // génération et remplissent une bulle au fil de l'eau. Le résultat final
            // (texte complet nettoyé) remplace la bulle à la fin.
            let streamedText = '';
            if (window.electronAPI.onAIChunk) {
                window.electronAPI.onAIChunk(({ text: chunk }) => {
                    if (!streamedText) {
                        this.removeMessage('thinking-msg');
                        this.addMessage('', 'system', 'streaming-msg');
                    }
                    streamedText += chunk;
                    const bubble = document.getElementById('streaming-msg');
                    if (bubble) {
                        bubble.innerText = streamedText;
                        const container = document.getElementById('chatMessages');
                        if (container) container.scrollTop = container.scrollHeight;
                    }
                });
            }
            const result = await window.electronAPI.runAI(text, context, true);
            const totalMs = Date.now() - t0;
            if (window.electronAPI.removeListener) window.electronAPI.removeListener('ai-chunk');
            this.removeMessage('thinking-msg');
            this.removeMessage('streaming-msg');
            if (result.success) {
                // v8.9.3 : chrono diagnostic. total = temps perçu côté renderer ;
                // génération = temps mesuré dans le worker ; l'écart = IPC + file
                // d'attente + contention. À retirer une fois la lenteur élucidée.
                const genS = result.genMs != null ? (result.genMs / 1000).toFixed(1) : '?';
                console.log(`[AI] total ${(totalMs / 1000).toFixed(1)} s | génération ${genS} s | prompt ${result.promptChars || '?'} chars | réponse ${result.text.length} chars`);
                // v9.29.1 : la 1re réponse de la session (cold-start inclus) part dans la
                // boîte noire — compare le temps de réponse IA d'une machine testeur à
                // l'autre sans F12. Une seule écriture par session (plafond préservé).
                if (!this._chronoLogged && typeof window.logTechEvent === 'function') {
                    this._chronoLogged = true;
                    window.logTechEvent('chrono', `réponse IA : total ${(totalMs / 1000).toFixed(1)} s | génération ${genS} s | réponse ${result.text.length} chars`, 'chat');
                }
                this.addMessage(result.text, 'system');
            } else {
                this.addMessage("❌ " + result.error, 'system');
            }
        } catch (e) {
            if (window.electronAPI.removeListener) window.electronAPI.removeListener('ai-chunk');
            this.removeMessage('thinking-msg');
            this.removeMessage('streaming-msg');
            this.addMessage("❌ Erreur : " + (e?.message || String(e)), 'system');
        } finally {
            this._isGenerating = false;
        }
    }

    addMessage(text, side, id = null) {
        const container = document.getElementById('chatMessages');
        const msg = document.createElement('div');
        msg.className = `message ${side}`;
        if (id) msg.id = id;
        // Les réponses sont écrites en Markdown (**titre**, *mode recherche*) ; le texte saisi reste brut.
        if (side === 'system' && typeof window.safeMarkdownToHtml === 'function') {
            msg.innerHTML = window.safeMarkdownToHtml(text);
        } else {
            msg.innerText = text;
        }
        container.appendChild(msg);
        container.scrollTop = container.scrollHeight;
    }

    removeMessage(id) {
        const el = document.getElementById(id);
        if (el) el.remove();
    }

    // v7.0.7 : arrêt propre de la lecture en cours, idempotent (safe à appeler même
    // si rien ne joue). Contrairement à speak() qui toggle, stopReading() ne fait
    // QUE stopper. Appelée par reader.openSubModule pour cleanup à la navigation.
    stopReading() {
        this.isSpeaking = false;
        if (this.currentAudio) {
            try { this.currentAudio.pause(); } catch (e) {}
            this.currentAudio = null;
        }
        try { this.synth.cancel(); } catch (e) {}
        try { this.clearHighlights(); } catch (e) {}
        try { this.updateAudioButton(false); } catch (e) {}
    }

    // v9.18.0 : ANCIEN preWarmReader → resetReaderAudio. La pré-synthèse de la 1ʳᵉ phrase
    // à l'ouverture du chapitre est SUPPRIMÉE : sur WASM mono-thread (Supertonic) elle
    // figeait l'UI ~11 s à l'ouverture (coût fixe de compilation des kernels à la 1ʳᵉ vraie
    // synthèse de la session, mesuré v9.17.0 : [Chrono pré-warm lecture] 11720 ms).
    // Choix produit (user 22/06) : ce gel unique est désormais payé au 1er clic ▶ (speak →
    // setReaderPreparing « ⏳ Préparation de la voix… » visible), PAS à l'ouverture.
    // Appelée par reader.openSubModule : ne fait plus qu'initialiser le router et stopper
    // l'audio du chapitre précédent (aucune synthèse → aucun gel à l'ouverture).
    async resetReaderAudio() {
        try {
            const router = (await import('./tts/tts-router.js')).default;
            await router.getOrInit();
            if (typeof router.hardStop === 'function') {
                router.hardStop();
            } else if (typeof router.stop === 'function') {
                router.stop();
            }
        } catch (e) {
            // Silencieux — housekeeping opportuniste à l'ouverture du chapitre.
            console.warn('[Reader] resetReaderAudio échec (silencieux):', e?.message || e);
        }
    }

    speak(text) {
        // Toggle stop si déjà en lecture
        if (this.isSpeaking) {
            this.isSpeaking = false;
            if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
            this.synth.cancel();
            // v7.0.8 : propage au router (Supertonic/Voxtral/Piper jouent via router._currentAudio).
            // stop() ici, pas hardStop() : on veut préserver les pre-synths du chapitre courant
            // pour qu'une reprise immédiate (re-clic ▶) hit le cache LRU Supertonic v7.0.4.
            import('./tts/tts-router.js').then(m => {
                const r = m && m.default;
                if (r && typeof r.stop === 'function') r.stop();
            }).catch(() => {});
            this.clearHighlights();
            this.updateAudioButton(false);
            return;
        }
        // v7.2.0 : segmenter FR robuste. Le segmenter retourne
        // toujours un tableau (vide si rien à dire), pas besoin de fallback ` || [text]`.
        this._segmentSentencesAsync(text).then(sents => {
            this.sentences = sents.length > 0 ? sents : [text];
            this.currentSentenceIdx = 0;
            this.isSpeaking = true;
            // v9.17.0 : état « préparation voix » VISIBLE avant la synthèse bloquante de
            // la 1ʳᵉ phrase (WASM mono-thread fige l'UI plusieurs secondes). Double-rAF
            // pour forcer le paint AVANT le gel (cf double-rAF v9.10.0 test voix). L'état
            // « ⏹️ Stop » réel est rebasculé par le callback onPlaybackStart (PATCH 4).
            this.setReaderPreparing();
            requestAnimationFrame(() => requestAnimationFrame(() => this.speakNextSentence()));
        });
    }

    async _segmentSentencesAsync(text) {
        try {
            const { segmentFrenchSentences } = await import('./tts/utils/sentence-segmenter.js');
            return segmentFrenchSentences(text);
        } catch (e) {
            console.warn('[ai-helper] segmenter indispo, fallback regex:', e);
            return text.match(/[^.!?]+[.!?]+/g) || [text];
        }
    }

    async speakNextSentence() {
        if (this.currentSentenceIdx >= this.sentences.length || !this.isSpeaking) {
            this.isSpeaking = false;
            this.clearHighlights();
            this.updateAudioButton(false);
            return;
        }
        const sentence = this.sentences[this.currentSentenceIdx].trim();
        if (!sentence) { this.currentSentenceIdx++; this.speakNextSentence(); return; }

        // v7.0.9 : le highlight était fait ici avant l'await speakAs. Pour Supertonic
        // 1ʳᵉ phrase non cachée, la synth prend 1-3 s → le surlignage précédait l'audio.
        // Désormais on déclenche le highlight via le callback onPlaybackStart fourni
        // au router, qui le fire quand l'<audio> émet "playing" (engines audio) ou quand
        // utter.onstart fire (Web Speech). Décalage perçu ≈ 0 ms.

        // v7.0.4 : pre-fetch phrase N+1 réactivé. Safe grâce au dual abort token
        // dans SupertonicEngine (v7.0.4) : stop() interne du speakAs ne tue plus
        // la pre-synth. Le WAV de N+1 atterrit dans _wavCache → speakAs(N+1) instant.
        try {
            const router = (await import('./tts/tts-router.js')).default;
            await router.getOrInit();
            // Lance la pre-synth N+1 en background (fire-and-forget).
            const nextSentence = this.sentences[this.currentSentenceIdx + 1];
            if (nextSentence && nextSentence.trim()) {
                router.preSynthesize(nextSentence.trim(), 'reader');
            }
            // v9.14.2 : chrono de diagnostic — latence entre la requête de synthèse et le
            // début réel de l'audio (cold-start Supertonic visible sur la 1ʳᵉ phrase non cachée).
            const _tVoice = performance.now();
            await router.speakAs(sentence, 'reader', {
                onPlaybackStart: () => {
                    // v9.17.0 : l'audio démarre réellement → quitter l'état « préparation »
                    // pour « ⏹️ Stop » (idempotent sur les phrases suivantes).
                    if (this.isSpeaking) this.updateAudioButton(true);
                    console.log(`[Chrono voix lecture] phrase ${this.currentSentenceIdx + 1}/${this.sentences.length} — latence avant audio : ${Math.round(performance.now() - _tVoice)} ms (${sentence.length} car.)`);
                    // Garde-fou : si l'utilisateur a stoppé entre le clic et l'event playing,
                    // ne pas raviver de highlight orphelin.
                    if (this.isSpeaking) this.highlightSentence(sentence);
                },
                // v7.2.1 : highlight mot-par-mot pour Web Speech (autres engines : silencieux).
                onBoundary: ({ charIndex, charLength }) => {
                    if (!this.isSpeaking) return;
                    this._highlightWordInSentence(sentence, charIndex, charLength);
                }
            });
            if (!this.isSpeaking) return;
            this.currentSentenceIdx++;
            return this.speakNextSentence();
        } catch (e) {
            console.warn('[Reader] Router en échec, fallback Web Speech direct :', e);
            // v9.17.0 : quitter l'état « préparation » même sur le chemin fallback (pas de
            // callback onPlaybackStart plumbé pour Web Speech direct).
            this.updateAudioButton(true);
            // Le fallback joue via fallbackSpeak (utter directe sans router) — on highlight
            // de manière synchrone car aucun callback n'est plumbé.
            this.highlightSentence(sentence);
            this.fallbackSpeak(sentence);
        }
    }

    /** Encode un Float32Array PCM mono en blob WAV jouable par <audio>. */
    encodeWAV(samples, sampleRate) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);
        const writeStr = (offset, str) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };
        writeStr(0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true);     // PCM chunk size
        view.setUint16(20, 1, true);      // PCM format
        view.setUint16(22, 1, true);      // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeStr(36, 'data');
        view.setUint32(40, samples.length * 2, true);
        let offset = 44;
        for (let i = 0; i < samples.length; i++, offset += 2) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }

    fallbackSpeak(sentence) {
        if (!this.isSpeaking) return;
        const utterance = new SpeechSynthesisUtterance(sentence);
        const voices = this.synth.getVoices();
        const savedVoiceName = localStorage.getItem('almanach_tts_fallback_voice') || '';
        const bestVoice =
            (savedVoiceName && voices.find(v => v.name === savedVoiceName)) ||
            voices.find(v => v.lang === 'fr-FR' && v.name.includes('Google')) ||
            voices.find(v => v.lang === 'fr-FR' && (v.name.includes('Natural') || v.name.includes('Enhanced') || v.name.includes('Premium'))) ||
            voices.find(v => v.lang === 'fr-FR' && v.name.includes('Microsoft')) ||
            voices.find(v => v.lang === 'fr-FR' && !v.name.toLowerCase().includes('espeak')) ||
            voices.find(v => v.lang.startsWith('fr'));
        if (bestVoice) utterance.voice = bestVoice;
        utterance.lang = 'fr-FR';
        utterance.pitch = 1.0;
        utterance.rate = parseFloat(localStorage.getItem('almanach_tts_rate') || '1.0');
        utterance.volume = 1.0;
        utterance.onend = () => { this.currentSentenceIdx++; this.speakNextSentence(); };
        utterance.onerror = () => { this.currentSentenceIdx++; this.speakNextSentence(); };
        this.synth.cancel();
        setTimeout(() => { if (this.isSpeaking) this.synth.speak(utterance); }, 50);
    }

    // ===================== SPEAK AS (v6.9.2 : déléguée au TTS Router) =====================
    // Le router est chargé via dynamic import pour éviter de transformer ce fichier
    // en ES module (ce qui casserait l'ordre de chargement avec app.js).
    async speakAs(text, role = 'persona') {
        // v9.3.0 : chrono de latence voix (diagnostic simulations). t0 = instant de l'appel,
        // onPlaybackStart = 1er échantillon audio réellement joué (engines router-owned :
        // Supertonic/Piper). Log [Sim voix] dans la console DevTools.
        const t0 = performance.now();
        try {
            const router = (await import('./tts/tts-router.js')).default;
            return router.speakAs(text, role, {
                onPlaybackStart: () => {
                    console.log(`[Sim voix] role=${role} — latence avant audio : ${Math.round(performance.now() - t0)} ms (${String(text).length} car.)`);
                }
            });
        } catch (e) {
            console.warn('TTS Router indisponible, fallback Web Speech:', e);
            // Fallback : on retombe sur l'ancien chemin Web Speech basique.
            return this._legacyFallbackSpeak(text);
        }
    }

    // v9.6.1 : variante "best-effort" pour les simulations — ne joue la réplique que si elle
    // est déjà prête (cache hot-swap Supertonic / engine rapide) → jamais de figeage de l'UI.
    async speakAsIfReady(text, role = 'persona') {
        const t0 = performance.now();
        try {
            const router = (await import('./tts/tts-router.js')).default;
            return router.speakAsIfReady(text, role, {
                onPlaybackStart: () => {
                    console.log(`[Sim voix] role=${role} — lecture best-effort en ${Math.round(performance.now() - t0)} ms (${String(text).length} car.)`);
                }
            });
        } catch (e) {
            return false;
        }
    }

    // v9.4.0 : pré-synthèse en arrière-plan (remplit le cache, SANS jouer l'audio) pour masquer
    // la latence Supertonic à froid dans les simulations. Délègue à router.preSynthesize, qui
    // utilise le token _preFetch NON annulable par stop(). Best-effort : no-op si router KO.
    async preSynthesizeAs(text, role = 'persona') {
        try {
            const router = (await import('./tts/tts-router.js')).default;
            return router.preSynthesize(text, role);
        } catch (e) {
            /* pré-chauffage opportuniste : on ignore silencieusement */
        }
    }

    async stopSimSpeak() {
        try {
            const router = (await import('./tts/tts-router.js')).default;
            router.stop();
        } catch (e) { /* router pas chargé, rien à stopper */ }
        // Sécurité : on coupe aussi Web Speech au cas où.
        try { this.synth.cancel(); } catch (e) {}
    }

    // Fallback ultime si le router échoue à charger (ex. fichiers TTS supprimés).
    _legacyFallbackSpeak(sentence) {
        if (!sentence || !sentence.trim()) return;
        const utter = new SpeechSynthesisUtterance(sentence.trim());
        utter.lang = 'fr-FR';
        utter.rate = parseFloat(localStorage.getItem('almanach_tts_rate') || '1.0');
        const voices = this.synth.getVoices();
        const fr = voices.find(v => v.lang === 'fr-FR' && !v.name.toLowerCase().includes('espeak'));
        if (fr) utter.voice = fr;
        try { this.synth.cancel(); } catch (e) {}
        setTimeout(() => this.synth.speak(utter), 50);
    }

    // Helpers conservés pour compat / UI legacy. Listent voix FR Web Speech uniquement.
    getBestFrenchMaleVoice() {
        const voices = this.synth.getVoices();
        const fr = voices.filter(v => (v.lang === 'fr-FR' || v.lang.startsWith('fr')) && !v.name.toLowerCase().includes('espeak'));
        const prefs = ['Paul', 'Claude', 'Bruno', 'Thomas', 'Henri'];
        for (const n of prefs) { const m = fr.find(v => v.name.includes(n)); if (m) return m; }
        return fr[0] || null;
    }

    getBestFrenchFemaleVoice() {
        const voices = this.synth.getVoices();
        const fr = voices.filter(v => (v.lang === 'fr-FR' || v.lang.startsWith('fr')) && !v.name.toLowerCase().includes('espeak'));
        const prefs = ['Hortense', 'Julie', 'Denise', 'Audrey'];
        for (const n of prefs) { const m = fr.find(v => v.name.includes(n)); if (m) return m; }
        return fr[0] || null;
    }

    listAllFrenchVoices() {
        // API v6.9.1 conservée pour rétrocompat. v6.9.2 préfère ttsRouter.listAllVoices().
        const webVoices = this.synth.getVoices().filter(v => v.lang === 'fr-FR' || v.lang.startsWith('fr'));
        return { web: webVoices.map(v => ({ name: v.name, label: `${v.name} — ${v.lang}` })) };
    }

    highlightSentence(sentence) {
        this.clearHighlights();
        const readerContent = document.getElementById('readerContent');
        if (!readerContent) return;
        const paragraphs = readerContent.querySelectorAll('.reader-section-body p');
        // v7.2.0 : normalisation texte pour matching robuste (espaces, NBSP, etc).
        const target = this._normalizeText(sentence || '');
        if (!target) return;

        const containerRect = readerContent.getBoundingClientRect();
        for (const p of paragraphs) {
            const pText = p.textContent || '';
            const pNorm = this._normalizeText(pText);
            if (!pNorm.includes(target.substring(0, 40))) continue;

            p.classList.add('highlight-sentence');

            // v7.3.0 : wrap mot-par-mot — sauvegarde l'innerHTML original (restitué par
            // clearHighlights) puis reconstruit le paragraphe avec la phrase courante
            // découpée en <span class="word">. Les data-word-start / data-word-end sont
            // des offsets de caractère dans `sentence` (pas dans le paragraphe entier) →
            // alignés sur le charIndex que Web Speech émet via utter.onboundary.
            try {
                // v7.4.1 : wrap en place via DOM (TreeWalker) au lieu de manipuler
                // innerHTML — préserve <b>/<i>/<a> du paragraphe pendant la lecture.
                // _originalHTML reste utilisé par clearHighlights pour restaurer l'état.
                p._originalHTML = p.innerHTML;
                const rawSentence = sentence || '';
                const startInP = this._findSentenceStartInText(pText, rawSentence);
                if (startInP < 0) {
                    // Match phrase ↔ paragraphe trop fragile, on garde juste le highlight
                    // au niveau phrase (sans wrap mot). Comportement v7.2.1.
                } else {
                    const endInP = startInP + rawSentence.length;
                    this._wrapSentenceInPlace(p, startInP, endInP, rawSentence);
                }
            } catch (e) {
                // Si l'injection échoue (rare), on conserve le highlight phrase mais
                // sans wrap mot. Pas de blocage pour l'utilisateur.
                console.warn('[Reader] wrap mot échec, fallback highlight phrase :', e?.message || e);
            }

            // v7.2.1 : ne scroll que si le paragraphe est hors viewport — évite le
            // saut visuel agaçant quand 2 phrases consécutives sont dans le même <p>.
            const rect = p.getBoundingClientRect();
            const inViewport = rect.top >= containerRect.top + 20
                            && rect.bottom <= containerRect.bottom - 20;
            if (!inViewport) {
                p.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            break;
        }
    }

    // v7.3.0 : trouve le start d'une phrase dans un textContent de paragraphe.
    // Retourne -1 si non trouvé. Tente d'abord un indexOf direct (rapide), puis un
    // matching tolérant sur normalisation (espaces collapsés, lowercase) en mappant les
    // offsets back vers le texte brut.
    _findSentenceStartInText(paragraphText, sentence) {
        if (!paragraphText || !sentence) return -1;
        const direct = paragraphText.indexOf(sentence);
        if (direct >= 0) return direct;
        const probe = this._normalizeText(sentence).substring(0, 40);
        if (!probe) return -1;
        const normP = this._normalizeText(paragraphText);
        const normIdx = normP.indexOf(probe);
        if (normIdx < 0) return -1;
        // On n'a pas une map exacte normalisé→brut, mais la phrase est probablement
        // alignée au mot près. On cherche le premier mot non-vide dans le texte brut
        // à partir de l'offset estimé (estimation grossière : prend le ratio).
        // Approche pragmatique : indexOf du 1er mot de la phrase dans le texte brut.
        const firstWord = sentence.trim().split(/\s+/)[0];
        if (!firstWord) return -1;
        return paragraphText.indexOf(firstWord);
    }

    // v7.4.1 : wrap la phrase active dans le DOM en place, sans toucher au reste
    // du paragraphe. Parcourt les text nodes via TreeWalker, calcule leur position
    // cumulée dans p.textContent, et remplace uniquement les segments qui chevauchent
    // [startInP, endInP). Préserve <b>/<i>/<a> du paragraphe (fix dette v7.3.0).
    _wrapSentenceInPlace(p, startInP, endInP, sentence) {
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
        const textNodes = [];
        let n;
        while ((n = walker.nextNode())) textNodes.push(n);

        const tokens = this._tokenizeForKaraoke(sentence);

        // Calcule, pour chaque text node, son intersection avec [startInP, endInP).
        // On collecte d'abord, on remplace après (pour ne pas casser le walker).
        const replacements = [];
        let accumPos = 0;
        for (const textNode of textNodes) {
            const nodeText = textNode.nodeValue || '';
            const nodeStart = accumPos;
            const nodeEnd = accumPos + nodeText.length;
            accumPos = nodeEnd;

            const overlapStart = Math.max(startInP, nodeStart);
            const overlapEnd = Math.min(endInP, nodeEnd);
            if (overlapStart >= overlapEnd) continue;

            const localStart = overlapStart - nodeStart;
            const localEnd = overlapEnd - nodeStart;
            const beforeText = nodeText.substring(0, localStart);
            const segmentText = nodeText.substring(localStart, localEnd);
            const afterText = nodeText.substring(localEnd);
            const segStartInSentence = overlapStart - startInP;

            const fragment = this._buildWrappedFragment(segmentText, segStartInSentence, tokens);
            replacements.push({ textNode, beforeText, fragment, afterText });
        }

        for (const { textNode, beforeText, fragment, afterText } of replacements) {
            const parent = textNode.parentNode;
            if (!parent) continue;
            if (beforeText) parent.insertBefore(document.createTextNode(beforeText), textNode);
            parent.insertBefore(fragment, textNode);
            if (afterText) parent.insertBefore(document.createTextNode(afterText), textNode);
            parent.removeChild(textNode);
        }
    }

    // v7.4.1 : construit un DocumentFragment où les tokens (mots) intersectant
    // segmentText sont wrappés en <span class="word">. Un token peut être scindé
    // sur 2 fragments si la phrase traverse une frontière de nœud (ex : <b>fo</b>o
    // → 2 spans avec le même data-word-start). C'est OK : _highlightWordInSentence
    // (v7.4.1) active TOUS les spans partageant ce data-word-start.
    _buildWrappedFragment(segmentText, segmentStartInSentence, tokens) {
        const fragment = document.createDocumentFragment();
        const segmentEndInSentence = segmentStartInSentence + segmentText.length;
        let cursor = 0;

        for (const t of tokens) {
            const tokOverlapStart = Math.max(t.start, segmentStartInSentence);
            const tokOverlapEnd = Math.min(t.end, segmentEndInSentence);
            if (tokOverlapStart >= tokOverlapEnd) continue;

            const tokLocalStart = tokOverlapStart - segmentStartInSentence;
            const tokLocalEnd = tokOverlapEnd - segmentStartInSentence;

            if (tokLocalStart > cursor) {
                fragment.appendChild(document.createTextNode(segmentText.substring(cursor, tokLocalStart)));
            }

            const span = document.createElement('span');
            span.className = 'word';
            span.dataset.wordStart = String(t.start);
            span.dataset.wordEnd = String(t.end);
            span.textContent = segmentText.substring(tokLocalStart, tokLocalEnd);
            fragment.appendChild(span);

            cursor = tokLocalEnd;
        }

        if (cursor < segmentText.length) {
            fragment.appendChild(document.createTextNode(segmentText.substring(cursor)));
        }

        return fragment;
    }

    // v7.3.0 : highlight mot-par-mot dans la phrase en cours. Appelé par onBoundary
    // (Web Speech only). Trouve le <span.word> dont l'intervalle [start, end[ contient
    // `charIndex` (offset Web Speech, relatif à la phrase synthétisée). Retire .active
    // des autres mots et l'ajoute à celui en cours.
    _highlightWordInSentence(sentence, charIndex, charLength) {
        const highlighted = document.querySelector('.highlight-sentence');
        if (!highlighted) return;
        try {
            const words = highlighted.querySelectorAll('.word[data-word-start]');
            if (!words.length) return;

            // v7.4.1 : un mot peut être réparti sur plusieurs spans si la phrase
            // traverse une frontière de nœud (ex : <b>fo</b>o → 2 spans pour "foo"
            // partageant le même data-word-start). On identifie le data-word-start
            // du mot ciblé, puis on active TOUS les spans qui le partagent.
            let targetStart = null;
            for (const w of words) {
                const start = parseInt(w.dataset.wordStart, 10);
                const end = parseInt(w.dataset.wordEnd, 10);
                if (Number.isFinite(start) && Number.isFinite(end)
                    && charIndex >= start && charIndex < end) {
                    targetStart = start;
                    break;
                }
            }
            if (targetStart === null) return;

            const prevActive = highlighted.querySelectorAll('.word.active');
            prevActive.forEach(el => {
                const elStart = parseInt(el.dataset.wordStart, 10);
                if (elStart !== targetStart) el.classList.remove('active');
            });
            const sameWordSpans = highlighted.querySelectorAll(
                '.word[data-word-start="' + targetStart + '"]'
            );
            sameWordSpans.forEach(el => el.classList.add('active'));
        } catch (e) { /* ignore */ }
    }

    // v7.3.0 : tokenise une phrase en mots avec leurs offsets de char.
    // Retourne [{ word, start, end }, ...] où start/end sont relatifs au début de `sentence`.
    // Les séparateurs (espaces, ponctuation flottante) sont conservés en clair entre les tokens
    // par le code appelant qui réinsère sentence.substring(cursor, t.start).
    _tokenizeForKaraoke(sentence) {
        const tokens = [];
        if (!sentence) return tokens;
        const regex = /\S+/g;
        let m;
        while ((m = regex.exec(sentence)) !== null) {
            tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
        }
        return tokens;
    }


    // v7.2.0 : nettoie le texte pour comparaison (retire NBSP, multiples espaces, etc).
    _normalizeText(t) {
        return (t || '').replace(/[\s ]+/g, ' ').trim().toLowerCase();
    }

    clearHighlights() {
        document.querySelectorAll('.highlight-sentence').forEach(el => {
            // v7.3.0 : restaure l'innerHTML original (sauvé par highlightSentence avant
            // wrap mot). Sans ça, les <span class="word"> persisteraient dans le DOM
            // après le passage à la phrase suivante.
            try {
                if (typeof el._originalHTML === 'string') {
                    el.innerHTML = el._originalHTML;
                    delete el._originalHTML;
                }
            } catch (e) { /* ignore */ }
            el.classList.remove('highlight-sentence');
        });
    }

    // v9.17.0 : état transitoire affiché pendant la synthèse bloquante de la 1ʳᵉ phrase
    // (gel WASM mono-thread). Rebasculé en « ⏹️ Stop » par onPlaybackStart, ou en
    // « 🔊 Audio » par updateAudioButton(false) si l'utilisateur stoppe avant l'audio.
    setReaderPreparing() {
        const btn = document.getElementById('toggleAudio');
        if (btn) {
            btn.textContent = '⏳ Préparation de la voix…';
            btn.style.background = 'rgba(234,179,8,0.2)';
        }
    }

    updateAudioButton(isPlaying) {
        const btn = document.getElementById('toggleAudio');
        if (btn) {
            btn.textContent = isPlaying ? '⏹️ Stop' : '🔊 Audio';
            btn.style.background = isPlaying ? 'rgba(244,63,94,0.2)' : '';
        }
    }

    extractFlashcards(contentArray) {
        const flashcards = [];
        const text = contentArray.join('\n');
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);

        lines.forEach(line => {
            const match = line.match(/^([^:–\-]{5,60})\s*[:–]\s*(.{15,200})$/);
            if (match) {
                // v9.14.1 : retirer la puce/tiret de tête et reformuler avec une amorce
                // universelle (grammaticale pour un nom comme pour un verbe à l'infinitif).
                const term = match[1].trim().replace(/^[·•*▪◦‣\-–\s]+/, '').trim();
                if (term.length >= 5) flashcards.push({ q: 'En quoi consiste : ' + term + ' ?', a: match[2].trim() });
            }
        });

        for (let i = 0; i < lines.length - 1; i++) {
            const title = lines[i], next = lines[i + 1];
            if (title.length < 60 && title.length > 8 && next.length > 30 && !title.endsWith('.') && !/^\d/.test(title)) {
                flashcards.push({ q: "Qu'est-ce que : " + title + ' ?', a: next });
                i++;
            }
        }

        let lastTitle = null;
        const bulletItems = [];
        lines.forEach(line => {
            if (/^[-•*]\s/.test(line) || /^\d+\.\s/.test(line)) {
                bulletItems.push(line.replace(/^[-•*\d.]\s+/, '').trim());
            } else {
                if (bulletItems.length >= 2 && lastTitle) {
                    flashcards.push({ q: 'Citez les éléments de : ' + lastTitle, a: bulletItems.slice(0, 5).join(' | ') });
                    bulletItems.length = 0;
                }
                if (line.length < 80 && !line.endsWith('.')) lastTitle = line;
            }
        });

        const seen = new Set();
        const primary = flashcards.filter(f => {
            if (f.q.length < 10 || f.a.length < 10 || seen.has(f.q)) return false;
            seen.add(f.q);
            return true;
        });

        // v9.14.0 : filet de secours déterministe. Les 3 passes regex ci-dessus échouent sur
        // les chapitres rédigés en prose (0 carte → impasse « pas assez de définitions »).
        // Si < 5 cartes, on complète SANS LLM jusqu'à ~12 : (a) définitions du glossaire CIP
        // présentes dans le texte → « Que désigne X ? », (b) phrases à trou sur le mot porteur.
        if (primary.length < 5) {
            const FALLBACK_STOP = new Set(['attention', 'beaucoup', 'certaines', 'certains', 'comprendre', 'differents', 'differentes', 'egalement', 'ensemble', 'ensuite', 'exemples', 'important', 'importante', 'importants', 'lorsque', 'notamment', 'permettre', 'plusieurs', 'pourquoi', 'pouvoir', 'toujours', 'toutefois']);
            const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            const textNorm = norm(text);

            // (a) cartes glossaire — termes officiels CIP présents dans le chapitre
            const glossary = window.CIP_GLOSSAIRE || [];
            for (const g of glossary) {
                if (primary.length >= 12) break;
                if (!g || !g.terme || !g.def) continue;
                const q = `Que désigne « ${g.terme} » ?`;
                if (textNorm.includes(norm(g.terme)) && !seen.has(q)) {
                    seen.add(q);
                    primary.push({ q, a: g.def });
                }
            }

            // (b) cartes à trou (cloze) — phrase du chapitre, mot porteur masqué
            const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
                .map(s => s.trim())
                .filter(s => s.length >= 60 && s.length <= 240);
            for (const s of sentences) {
                if (primary.length >= 12) break;
                const words = (s.match(/[A-Za-zÀ-ÿ-]{8,}/g) || []).filter(w => !FALLBACK_STOP.has(norm(w)));
                if (!words.length) continue;
                const kw = words.sort((a, b) => b.length - a.length)[0];
                const key = 'cloze:' + norm(kw);
                if (seen.has(key)) continue;
                seen.add(key);
                primary.push({ q: `Complétez : « ${s.split(kw).join('______')} »`, a: kw });
            }
        }

        return primary.slice(0, 20);
    }
}

window.aiHelper = new AIHelper();
