// js/modules/coach.js — v9.0.0
// Coach de révision adaptatif. Cerveau décisionnel 100 % déterministe :
//   - Elo par compétence CP (nourri par window.coachRecordResult, appelé depuis app.js)
//   - ciblage de la compétence la plus fragile
//   - génération de quiz ciblés 100 % déterministe (buildDeterministicQuiz : templates
//     glossaire + phrase à trou, offline, aucun appel LLM depuis v9.2.0).
// Pattern IIFE identique aux autres modules : expose window.coachRecordResult,
// window.coachRenderCard. Dépend de window.COURSE_DATA, window.RNCP_REFERENTIEL,
// window.runCoachQuiz (app.js), window.electronAPI (Electron uniquement).
(function () {
    const ELO_KEY = 'almanach_coach_elo';
    const QUEUE_KEY = 'almanach_coach_queue';
    const ELO_START = 1200;
    const Q_DIFFICULTY = 1200;

    function loadElo() { try { return JSON.parse(localStorage.getItem(ELO_KEY) || '{}'); } catch (e) { return {}; } }
    function saveElo(elo) { localStorage.setItem(ELO_KEY, JSON.stringify(elo)); }
    function loadQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; } }
    function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
    function getEntry(elo, cp) { return elo[cp] || { elo: ELO_START, n: 0 }; }

    // Libellé d'un code CP depuis le référentiel RNCP.
    function cpLabel(code) {
        const ref = window.RNCP_REFERENTIEL || {};
        for (const ccp of Object.values(ref)) {
            const found = (ccp.competences || []).find(c => c.code === code);
            if (found) return found.label;
        }
        return code;
    }

    // Tous les codes CP couverts par au moins un module du corpus.
    function allCps() {
        const set = new Set();
        (((window.COURSE_DATA || {}).modules) || []).forEach(m => (m.cp || []).forEach(c => set.add(c)));
        return [...set].sort();
    }

    // ===================== MISES EN SITUATION (v9.1.0) =====================
    // Mapping curé scénario → CP (data/scenarios.json n'a pas de champ cp).
    const SCENARIO_CP = {
        'scenario-1': 'CP2',
        'scenario-2': 'CP7',
        'scenario-3': 'CP12',
        'scenario-4': 'CP8',
        'scenario-5': 'CP10',
        'scenario-6': 'CP6',
        'scenario-7': 'CP4',
        'scenario-8': 'CP8'
    };

    // Une simulation terminée nourrit l'Elo du CP associé (appelée par simulation.js).
    window.coachRecordSimResult = function (scenarioId, ratio) {
        try {
            const cp = SCENARIO_CP[scenarioId];
            if (!cp || !isFinite(ratio)) return;
            const elo = loadElo();
            const e = getEntry(elo, cp);
            const expected = 1 / (1 + Math.pow(10, (Q_DIFFICULTY - e.elo) / 400));
            const K = e.n < 20 ? 32 : 16;
            e.elo = Math.round(e.elo + K * (Math.max(0, Math.min(1, ratio)) - expected));
            e.n += 1;
            elo[cp] = e;
            saveElo(elo);
            renderCard();
            if (typeof window.pedagoRenderDailyPlan === 'function') window.pedagoRenderDailyPlan();
        } catch (e) { console.warn('[Coach] recordSimResult:', e); }
    };

    // ===================== MISE À JOUR ELO =====================
    // Appelé par app.js à la fin de chaque quiz. Retrouve les CP concernés :
    // quiz coach (coachCp) > quiz module (moduleId) > quiz IA chapitre (titre).
    window.coachRecordResult = function (quiz, score, total) {
        try {
            if (!quiz || !total) return;
            let cps = [];
            if (quiz.coachCp) {
                cps = [quiz.coachCp];
            } else if (quiz.moduleId !== undefined) {
                const mod = (((window.COURSE_DATA || {}).modules) || [])[quiz.moduleId];
                cps = (mod && mod.cp) || [];
            } else if (typeof quiz.title === 'string' && quiz.title.startsWith('Quiz IA : ')) {
                const chapter = quiz.title.slice('Quiz IA : '.length);
                const mod = (((window.COURSE_DATA || {}).modules) || [])
                    .find(m => (m.sub_modules || []).some(s => s.name === chapter));
                cps = (mod && mod.cp) || [];
            }
            if (!cps.length) return;
            const elo = loadElo();
            const actual = score / total;
            cps.forEach(cp => {
                const e = getEntry(elo, cp);
                const expected = 1 / (1 + Math.pow(10, (Q_DIFFICULTY - e.elo) / 400));
                const K = e.n < 20 ? 32 : 16;
                e.elo = Math.round(e.elo + K * (actual - expected));
                e.n += 1;
                elo[cp] = e;
            });
            saveElo(elo);
            renderCard();
            // v9.25.1 : le plan de révision du jour reflète le même CP faible que la carte Coach.
            if (typeof window.pedagoRenderDailyPlan === 'function') window.pedagoRenderDailyPlan();
            // Préparer le prochain quiz ciblé (5 s de délai : laisser l'UI de fin de quiz respirer).
            setTimeout(refillQueue, 5000);
        } catch (e) { console.warn('[Coach] recordResult:', e); }
    };

    // ===================== CIBLAGE =====================
    function targetCp() {
        const elo = loadElo();
        const cps = allCps();
        if (!cps.length) return null;
        const fresh = cps.filter(c => getEntry(elo, c).n === 0);
        if (fresh.length) return fresh[0]; // démarrage à froid : CP jamais évalués d'abord
        return cps.slice().sort((a, b) => getEntry(elo, a).elo - getEntry(elo, b).elo)[0];
    }

    function pickChapter(cp) {
        const mods = (((window.COURSE_DATA || {}).modules) || []).filter(m => (m.cp || []).includes(cp));
        const subs = [];
        mods.forEach(m => {
            (m.sub_modules || []).forEach(s => {
                if ((s.files || []).length) subs.push({ module: m.name, name: s.name, files: s.files });
            });
            // Modules sans sous-modules mais avec fichiers à la racine (ex : module 1)
            if (!(m.sub_modules || []).length && (m.files || []).length) {
                subs.push({ module: m.name, name: m.name, files: m.files });
            }
        });
        if (!subs.length) return null;
        return subs[Math.floor(Math.random() * subs.length)];
    }

    async function fetchChapterText(sub) {
        const parts = [];
        for (const f of sub.files.slice(0, 6)) {
            try {
                const r = await fetch(`./data/content/${encodeURIComponent(f.replace('.pdf', '.json'))}`);
                if (!r.ok) continue;
                const j = await r.json();
                (j.content || []).forEach(c => { if (typeof c === 'string' && c.trim()) parts.push(c.trim()); });
            } catch (e) { /* fichier manquant : on continue */ }
        }
        // v9.32.0 : sans supports de cours (démo web, data/content n'est pas publié), le glossaire
        // officiel prend le relais : quiz et flashcards restent générables, justes par construction.
        if (!parts.length) parts.push(...shuffleArr(window.CIP_GLOSSAIRE || []).map(g => `${g.terme} : ${g.def}`));
        // 4000 chars : aligné sur le MAX_CTX du RAG (fenêtre 4096 tokens de Qwen).
        return parts.join('\n\n').slice(0, 4000);
    }

    // ===================== GÉNÉRATION DÉTERMINISTE (v9.2.0) =====================
    // Le 1.5B fine-tuné recopie verbatim les exemples JSON des prompts en greedy :
    // 3 itérations de prompt-engineering ont échoué (v9.0.2, v9.1.0, v9.1.1).
    // Les QCM sont désormais construits par templates depuis le texte du chapitre
    // et le glossaire officiel : justes par construction, instantanés, offline.
    function normalize(s) {
        return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    }

    // Mots longs mais non porteurs de sens métier (exclus des textes à trou).
    const QUIZ_STOPWORDS = new Set(['attention', 'beaucoup', 'certaines', 'certains', 'comprendre', 'différents', 'différentes', 'également', 'ensemble', 'ensuite', 'exemples', 'important', 'importante', 'importants', 'lorsque', 'notamment', 'permettre', 'plusieurs', 'pourquoi', 'pouvoir', 'toujours', 'toutefois']);

    function shuffleArr(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // Phrases exploitables pour un texte à trou : ni trop courtes, ni interminables.
    function splitSentences(text) {
        return String(text).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
            .map(s => s.trim())
            .filter(s => s.length >= 60 && s.length <= 240);
    }

    // Mot porteur d'une phrase : le plus long mot (≥ 8 lettres) hors stopwords.
    function pickKeyword(sentence) {
        const words = sentence.match(/[A-Za-zÀ-ÿ-]{8,}/g) || [];
        const cands = words.filter(w => !QUIZ_STOPWORDS.has(normalize(w)));
        if (!cands.length) return null;
        return cands.sort((a, b) => b.length - a.length)[0];
    }

    // Construit jusqu'à `count` QCM au format { q, options[4], a } :
    //   Template 1 (glossaire) : termes de CIP_GLOSSAIRE présents dans le texte (ou
    //   rattachés au CP ciblé) → « Que désigne … ? », options = définitions officielles.
    //   Template 2 (texte à trou) : phrase du chapitre avec mot porteur masqué,
    //   distracteurs = mots porteurs d'autres phrases du même texte.
    function buildDeterministicQuiz(text, opts) {
        const { cp = null, count = 5 } = opts || {};
        const glossary = window.CIP_GLOSSAIRE || [];
        const srcNorm = normalize(text);
        const questions = [];

        const inText = glossary.filter(g => srcNorm.includes(normalize(g.terme)));
        const byCp = cp ? glossary.filter(g => g.cp === cp && !inText.includes(g)) : [];
        const pool = shuffleArr(inText).concat(shuffleArr(byCp));
        for (const g of pool) {
            if (questions.length >= Math.ceil(count / 2)) break;
            const distractors = shuffleArr(glossary.filter(o => o !== g)).slice(0, 3).map(o => o.def);
            if (distractors.length < 3) break;
            const options = shuffleArr([g.def].concat(distractors));
            questions.push({ q: `Que désigne « ${g.terme} » ?`, options, a: options.indexOf(g.def) });
        }

        const sentences = shuffleArr(splitSentences(text));
        const allKeywords = [...new Set(sentences.map(pickKeyword).filter(Boolean))];
        const used = new Set();
        for (const s of sentences) {
            if (questions.length >= count) break;
            const kw = pickKeyword(s);
            if (!kw || used.has(normalize(kw))) continue;
            const distractors = shuffleArr(allKeywords.filter(k => normalize(k) !== normalize(kw))).slice(0, 3);
            if (distractors.length < 3) continue;
            used.add(normalize(kw));
            const options = shuffleArr([kw].concat(distractors));
            questions.push({ q: `Complétez : « ${s.split(kw).join('______')} »`, options, a: options.indexOf(kw) });
        }
        return shuffleArr(questions).slice(0, count);
    }
    // Réutilisé par runGeneratedQuiz (app.js) — même générateur pour le Quiz IA du lecteur.
    window.buildDeterministicQuiz = buildDeterministicQuiz;

    // ===================== QUIZ GÉNÉRAL (v9.3.0) =====================
    // Quiz transversal sur toute la matière : agrège le texte de plusieurs chapitres
    // tirés au hasard dans l'ensemble des modules, puis construit des QCM déterministes
    // (mêmes templates glossaire + texte à trou que le Coach). Le glossaire couvrant déjà
    // toute la matière, les termes présents dans le texte agrégé donnent la moitié
    // « définitions », l'autre moitié étant des phrases à trou tirées des chapitres.
    function allChapters() {
        const subs = [];
        (((window.COURSE_DATA || {}).modules) || []).forEach(m => {
            (m.sub_modules || []).forEach(s => {
                if ((s.files || []).length) subs.push({ module: m.name, name: s.name, files: s.files });
            });
            // Modules sans sous-modules mais avec fichiers à la racine (ex : module 1)
            if (!(m.sub_modules || []).length && (m.files || []).length) {
                subs.push({ module: m.name, name: m.name, files: m.files });
            }
        });
        return subs;
    }

    // Construit un quiz général (par défaut 10 QCM) à partir de ~6 chapitres tirés au
    // hasard dans tout le corpus. Async : fetch des contenus de chapitres. Renvoie []
    // si la matière agrégée est insuffisante.
    window.coachBuildGlobalQuiz = async function (count = 10) {
        const _t0 = performance.now();
        const subs = shuffleArr(allChapters()).slice(0, 6);
        const parts = [];
        for (const sub of subs) {
            try {
                const t = await fetchChapterText(sub);
                if (t && t.length > 200) parts.push(t);
            } catch (e) { /* chapitre manquant : on continue */ }
        }
        const text = parts.join('\n\n');
        if (text.length < 600) return [];
        const quiz = buildDeterministicQuiz(text, { count });
        console.log(`[Chrono] quiz général (${quiz.length} Q) : ${Math.round(performance.now() - _t0)} ms`);
        return quiz;
    };

    // ===================== GÉNÉRATION EN ARRIÈRE-PLAN =====================
    let generating = false;
    async function refillQueue() {
        if (generating) return;
        const queue = loadQueue();
        const cp = targetCp();
        if (!cp) return;
        if (queue.some(item => item.cp === cp)) { renderCard(); return; }
        const sub = pickChapter(cp);
        if (!sub) return;
        generating = true;
        const _t0 = performance.now();
        try {
            const text = await fetchChapterText(sub);
            if (text.length < 300) return; // pas assez de matière pour un quiz fiable
            const questions = buildDeterministicQuiz(text, { cp, count: 5 });
            if (questions.length < 3) {
                console.warn(`[Coach] chapitre « ${sub.name} » trop pauvre (${questions.length} question(s) construites), abandon`);
                return;
            }
            queue.push({ cp, chapter: sub.name, module: sub.module, questions, det: true, createdAt: Date.now() });
            saveQueue(queue.slice(-2)); // max 2 quiz en cache
            console.log(`[Coach] quiz prêt pour ${cp} (${questions.length} questions, chapitre « ${sub.name} ») — ${Math.round(performance.now() - _t0)} ms`);
        } catch (e) {
            console.warn('[Coach] génération échouée:', e);
        } finally {
            generating = false;
            renderCard();
        }
    }

    // ===================== CARTE DASHBOARD =====================
    // Elo 800-1600 → maîtrise 0-100 % (1200 = 50 %).
    function masteryPercent(eloValue) {
        return Math.max(0, Math.min(100, Math.round((eloValue - 800) / 8)));
    }

    function renderCard() {
        const card = document.getElementById('coachCard');
        if (!card) return;
        const cp = targetCp();
        if (!cp) { card.classList.add('hidden'); return; }
        const elo = loadElo();
        const entry = getEntry(elo, cp);
        const queue = loadQueue();
        const ready = queue.find(item => item.cp === cp);
        const statusHtml = ready
            ? `<button id="coachStartBtn" class="btn-primary">▶ Session ciblée (${ready.questions.length} questions)</button>`
            : (entry.n === 0
                ? `<span class="coach-status">Réponds à un premier quiz pour calibrer ton profil.</span>`
                : `<span class="coach-status">⏳ Préparation d'une session ciblée en arrière-plan…</span>`);
        const scenarioId = Object.keys(SCENARIO_CP).find(id => SCENARIO_CP[id] === cp);
        card.innerHTML = `
            <div class="coach-card-title">🎯 Coach</div>
            <p class="coach-card-text">Compétence à travailler : <strong>${cp} — ${cpLabel(cp)}</strong>
            ${entry.n > 0 ? `<span class="coach-mastery">(maîtrise estimée : ${masteryPercent(entry.elo)} %)</span>` : ''}</p>
            ${statusHtml}
            <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
                <button id="coachFlashBtn" class="btn-nav">🃏 Flashcards ciblées</button>
                ${scenarioId ? `<button id="coachSimBtn" class="btn-nav">🎭 Mise en situation</button>` : ''}
            </div>`;
        card.classList.remove('hidden');
        const btn = document.getElementById('coachStartBtn');
        if (btn) btn.onclick = () => {
            const q = loadQueue();
            const idx = q.findIndex(item => item.cp === cp);
            if (idx === -1 || typeof window.runCoachQuiz !== 'function') return;
            const item = q.splice(idx, 1)[0];
            saveQueue(q);
            window.runCoachQuiz(item);
            renderCard();
        };
        // v9.2.0 : flashcards extraites d'un chapitre du CP ciblé par l'extracteur
        // regex déterministe (le chemin IA recopiait l'exemple du prompt).
        const flashBtn = document.getElementById('coachFlashBtn');
        if (flashBtn) flashBtn.onclick = async () => {
            const sub = pickChapter(cp);
            if (!sub || !window.aiHelper || typeof window.showFlashcards !== 'function') return;
            flashBtn.disabled = true;
            flashBtn.textContent = '⏳ Préparation…';
            const _t0 = performance.now();
            try {
                const text = await fetchChapterText(sub);
                if (text.length < 300) return;
                const cards = window.aiHelper.extractFlashcards(text.split('\n\n'));
                console.log(`[Chrono] flashcards ciblées (${(cards || []).length}) : ${Math.round(performance.now() - _t0)} ms`);
                if (Array.isArray(cards) && cards.length) window.showFlashcards(cards);
            } catch (e) {
                console.warn('[Coach] flashcards:', e);
            } finally {
                flashBtn.disabled = false;
                flashBtn.textContent = '🃏 Flashcards ciblées';
            }
        };
        // v9.1.0 : ouvre la mise en situation mappée sur le CP ciblé (labModal + openScenario).
        const simBtn = document.getElementById('coachSimBtn');
        if (simBtn) simBtn.onclick = async () => {
            try {
                const r = await fetch('./data/scenarios.json');
                const scenarios = await r.json();
                const s = scenarios.find(x => x.id === scenarioId);
                if (!s || typeof window.openScenario !== 'function') return;
                const modal = document.getElementById('labModal');
                if (modal) modal.classList.remove('hidden');
                window.openScenario(s);
            } catch (e) { console.warn('[Coach] simulation:', e); }
        };
    }

    // ===================== ACCESSEURS PÉDAGOGIE ADAPTATIVE (v9.25.0) =====================
    // Lecture seule, consommés par js/modules/pedago.js. Toute la logique Elo reste ici.

    // Snapshot Elo de tous les CP couverts par le corpus : { CPx: { elo, n, mastery } }.
    window.coachEloSnapshot = function () {
        const elo = loadElo();
        const out = {};
        allCps().forEach(cp => {
            const e = getEntry(elo, cp);
            out[cp] = { elo: e.elo, n: e.n, mastery: masteryPercent(e.elo) };
        });
        return out;
    };

    // Compétence CP la plus fragile à travailler (même ciblage que la carte Coach), ou null.
    window.coachTargetInfo = function () {
        const cp = targetCp();
        if (!cp) return null;
        const e = getEntry(loadElo(), cp);
        return { cp, label: cpLabel(cp), mastery: masteryPercent(e.elo), evaluated: e.n > 0 };
    };

    // Lance une session de quiz ciblée sur le CP faible : réutilise un quiz en file, sinon en
    // construit un à la volée (déterministe, offline). Renvoie true si une session a démarré.
    window.coachStartTargetedQuiz = async function () {
        const cp = targetCp();
        if (!cp || typeof window.runCoachQuiz !== 'function') return false;
        const q = loadQueue();
        const idx = q.findIndex(item => item.cp === cp);
        if (idx !== -1) {
            const item = q.splice(idx, 1)[0];
            saveQueue(q);
            window.runCoachQuiz(item);
            renderCard();
            return true;
        }
        const sub = pickChapter(cp);
        if (!sub) return false;
        const text = await fetchChapterText(sub);
        if (text.length < 300) return false;
        const questions = buildDeterministicQuiz(text, { cp, count: 5 });
        if (questions.length < 3) return false;
        window.runCoachQuiz({ cp, chapter: sub.name, module: sub.module, questions, det: true });
        return true;
    };

    // Génère et affiche une séance de flashcards ciblée sur le CP faible (extracteur
    // déterministe de ai-helper). Renvoie true si des cartes ont été affichées.
    window.coachStartTargetedFlash = async function () {
        const cp = targetCp();
        if (!cp || !window.aiHelper || typeof window.aiHelper.extractFlashcards !== 'function'
            || typeof window.showFlashcards !== 'function') return false;
        const sub = pickChapter(cp);
        if (!sub) return false;
        const text = await fetchChapterText(sub);
        if (text.length < 300) return false;
        const cards = window.aiHelper.extractFlashcards(text.split('\n\n'));
        if (!Array.isArray(cards) || !cards.length) return false;
        window.showFlashcards(cards);
        return true;
    };

    window.coachRenderCard = renderCard;

    // ===================== INIT =====================
    document.addEventListener('DOMContentLoaded', () => {
        // v9.2.0 : purge des quiz générés par l'IA avant le pivot déterministe
        // (seuls les items marqués det:true sont construits par templates).
        const queue = loadQueue();
        const sane = queue.filter(item => item.det === true);
        if (sane.length !== queue.length) {
            console.warn(`[Coach] ${queue.length - sane.length} quiz IA legacy purgé(s) de la file`);
            saveQueue(sane);
        }
        renderCard();
        // Génération déterministe instantanée et sans IA : 2 s suffisent (laisser
        // COURSE_DATA et le DOM se poser), plus besoin d'attendre l'utilityProcess.
        setTimeout(refillQueue, 2000);
    });
})();
