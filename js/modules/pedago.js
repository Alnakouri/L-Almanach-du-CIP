// js/modules/pedago.js — v9.25.0
// Pédagogie adaptative, 100 % déterministe (aucun appel LLM).
//   1. Score de préparation à l'examen par CCP (carte de la vue « Mes statistiques ») :
//      croise la couverture des chapitres (completed_docs) et la maîtrise Elo par CP
//      (window.coachEloSnapshot, coach.js) → indicateur Prêt / Presque / À travailler,
//      + les 3 chapitres à travailler en priorité (cliquables).
//   2. Plan de révision du jour (carte d'accueil, sous le Coach) : séance de flashcards
//      ciblée, quiz ciblé, chapitre jamais ouvert. Chaque ligne est actionnable.
// Pattern IIFE. Expose window.pedagoRenderReadiness, window.pedagoRenderDailyPlan.
// Dépend de : window.COURSE_DATA (data.js) ; window.coachEloSnapshot / coachTargetInfo /
// coachStartTargetedQuiz / coachStartTargetedFlash (coach.js) ; window.openSubModule (reader.js).
(function () {
    'use strict';

    function completedDocs() {
        try { return JSON.parse(localStorage.getItem('completed_docs') || '[]'); } catch (e) { return []; }
    }

    // Chapitres (sous-modules avec fichiers) d'un module, + fallback fichiers racine (module 1).
    function chaptersOf(mod) {
        const subs = (mod.sub_modules || []).filter(s => (s.files || []).length)
            .map(s => ({ name: s.name, files: s.files, parentName: mod.name }));
        if (!subs.length && (mod.files || []).length) {
            subs.push({ name: mod.name, files: mod.files, parentName: mod.name });
        }
        return subs;
    }

    // CCP réels du corpus (ordre de première apparition) avec leurs CP et chapitres.
    function ccpBreakdown() {
        const mods = (window.COURSE_DATA || {}).modules || [];
        const order = [];
        const map = {};
        mods.forEach(mod => {
            const ccp = mod.ccp || 'Autre';
            if (!map[ccp]) { map[ccp] = { cps: new Set(), chapters: [] }; order.push(ccp); }
            (mod.cp || []).forEach(c => map[ccp].cps.add(c));
            chaptersOf(mod).forEach(ch => map[ccp].chapters.push(ch));
        });
        return order.map(ccp => ({ ccp, cps: [...map[ccp].cps], chapters: map[ccp].chapters }));
    }

    // "CCP 1 - Accueillir…" → "CCP 1".
    function shortCcp(ccp) {
        const m = /CCP\s*\d+/i.exec(ccp);
        return m ? m[0].toUpperCase().replace(/\s+/g, ' ') : ccp;
    }

    // v9.25.1 : chapitre "fait" = marqué par son nom (lecteur) OU par un de ses fichiers
    // (modules documentaires). Aligné sur isChapterDone d'app.js.
    function chapDone(ch, completed) {
        return completed.includes(ch.name) || (ch.files || []).some(f => completed.includes(f));
    }
    function ccpNum(ccp) {
        const m = /CCP\s*(\d+)/i.exec(ccp);
        return m ? parseInt(m[1], 10) : 99;
    }

    function readinessLabel(pct) {
        if (pct >= 75) return { txt: 'Prêt', cls: 'ready-ok', icon: '✅' };
        if (pct >= 50) return { txt: 'Presque', cls: 'ready-mid', icon: '⚠️' };
        return { txt: 'À travailler', cls: 'ready-low', icon: '❌' };
    }

    // Score par CCP = 50 % couverture chapitres + 50 % maîtrise Elo moyenne des CP.
    // Un CP jamais évalué compte 0 en maîtrise (honnête pour un indicateur d'examen).
    function computeReadiness() {
        const completed = completedDocs();
        const elo = (typeof window.coachEloSnapshot === 'function') ? window.coachEloSnapshot() : {};
        return ccpBreakdown()
            .filter(b => /CCP\s*\d/i.test(b.ccp)) // ignore Transversal / Autre
            .map(b => {
                const totalCh = b.chapters.length;
                const doneCh = b.chapters.filter(ch => chapDone(ch, completed)).length;
                const coverage = totalCh ? doneCh / totalCh : 0;
                const masteries = b.cps.map(cp => (elo[cp] && elo[cp].n > 0) ? elo[cp].mastery : 0);
                const mastery = masteries.length ? masteries.reduce((a, x) => a + x, 0) / masteries.length : 0;
                const readiness = Math.round(100 * (0.5 * coverage + 0.5 * (mastery / 100)));
                return { ccp: b.ccp, readiness, doneCh, totalCh, chapters: b.chapters };
            })
            .sort((a, b) => ccpNum(a.ccp) - ccpNum(b.ccp)); // barres affichées CCP 1/2/3
    }

    // Jusqu'à 3 chapitres prioritaires : non lus, CCP le moins prêt d'abord.
    function priorityChapters(readinessRows) {
        const completed = completedDocs();
        const rows = readinessRows.slice().sort((a, b) => a.readiness - b.readiness);
        const out = [];
        for (const r of rows) {
            for (const ch of r.chapters) {
                if (out.length >= 3) break;
                if (!chapDone(ch, completed) && !out.some(o => o.name === ch.name)) {
                    out.push({ name: ch.name, files: ch.files, parentName: ch.parentName, ccp: shortCcp(r.ccp) });
                }
            }
            if (out.length >= 3) break;
        }
        return out;
    }

    // v9.26.0 : deck réel des cartes dues (SM2 par question, cf reader.js getDueCards).
    function dueCards() {
        return (typeof window.getDueCards === 'function') ? window.getDueCards() : [];
    }

    // ===================== SCORE DE PRÉPARATION (vue Stats) =====================
    function renderReadiness() {
        const target = document.getElementById('statsReadiness');
        if (!target) return;
        const rows = computeReadiness();
        if (!rows.length) {
            target.innerHTML = '<div style="opacity:0.5; font-size:0.8rem;">Données insuffisantes pour le moment.</div>';
            return;
        }
        const barsHtml = rows.map(r => {
            const lab = readinessLabel(r.readiness);
            return `
                <div class="readiness-item">
                    <div class="readiness-head">
                        <span class="readiness-name">${shortCcp(r.ccp)}</span>
                        <span class="readiness-badge ${lab.cls}">${lab.icon} ${lab.txt} · ${r.readiness}%</span>
                    </div>
                    <div class="progress-bar-bg" style="height:6px; border-radius:3px;">
                        <div class="progress-bar-fill ${lab.cls}" style="width:${r.readiness}%; height:100%; border-radius:3px;"></div>
                    </div>
                    <div class="readiness-sub">${r.doneCh}/${r.totalCh} chapitres lus</div>
                </div>`;
        }).join('');
        const prio = priorityChapters(rows);
        const prioHtml = prio.length
            ? `<div class="readiness-prio-title">📌 À travailler en priorité</div>` +
              prio.map((c, i) => `<button class="readiness-prio-item" data-prio="${i}" type="button">
                    <span class="readiness-prio-ccp">${c.ccp}</span>
                    <span class="readiness-prio-name">${c.name}</span></button>`).join('')
            : '';
        target.innerHTML = barsHtml + prioHtml;
        prio.forEach((c, i) => {
            const btn = target.querySelector(`[data-prio="${i}"]`);
            if (btn) btn.onclick = () => {
                if (typeof window.openSubModule === 'function') {
                    window.openSubModule({ name: c.name, files: c.files, parentName: c.parentName });
                }
            };
        });
    }

    // ===================== PLAN DE RÉVISION DU JOUR (accueil) =====================
    function renderDailyPlan() {
        const card = document.getElementById('dailyPlanCard');
        if (!card) return;
        const due = dueCards();
        const dueN = due.length;
        const target = (typeof window.coachTargetInfo === 'function') ? window.coachTargetInfo() : null;
        const chapter = priorityChapters(computeReadiness())[0] || null;

        const flashRow = dueN > 0
            ? `<button class="dp-row dp-action" id="dpFlashBtn" type="button">
                    <span class="dp-icon">🃏</span>
                    <span class="dp-text"><strong>${dueN} carte${dueN > 1 ? 's' : ''}</strong> à réviser aujourd'hui</span>
                    <span class="dp-go">Réviser →</span></button>`
            : `<button class="dp-row dp-action" id="dpFlashBtn" type="button">
                    <span class="dp-icon">🃏</span>
                    <span class="dp-text">Séance de flashcards ciblée</span>
                    <span class="dp-go">Réviser →</span></button>`;

        const quizRow = target
            ? `<button class="dp-row dp-action" id="dpQuizBtn" type="button">
                    <span class="dp-icon">🎯</span>
                    <span class="dp-text">Quiz ciblé : <strong>${target.cp} — ${target.label}</strong>${target.evaluated ? ` <span class="dp-dim">(maîtrise ${target.mastery} %)</span>` : ''}</span>
                    <span class="dp-go">Lancer →</span></button>`
            : `<div class="dp-row dp-done"><span class="dp-icon">🎯</span><span class="dp-text">Fais un premier quiz pour calibrer ton profil.</span></div>`;

        const chapRow = chapter
            ? `<button class="dp-row dp-action" id="dpChapterBtn" type="button">
                    <span class="dp-icon">📖</span>
                    <span class="dp-text">Chapitre à découvrir : <strong>${chapter.name}</strong> <span class="dp-dim">(${chapter.ccp})</span></span>
                    <span class="dp-go">Ouvrir →</span></button>`
            : `<div class="dp-row dp-done"><span class="dp-icon">📖</span><span class="dp-text">Tous les chapitres ont été ouverts.</span><span class="dp-check">🏆</span></div>`;

        card.innerHTML = `
            <div class="dp-title">🗓️ Ton plan de révision du jour</div>
            <div class="dp-list">${flashRow}${quizRow}${chapRow}</div>`;
        card.classList.remove('hidden');

        const fb = document.getElementById('dpFlashBtn');
        if (fb) fb.onclick = async () => {
            // v9.26.0 : si des cartes sont dues, on rejoue le deck réel ; sinon on génère une
            // séance ciblée sur le CP faible (extracteur déterministe).
            if (dueN > 0) { if (typeof window.showFlashcards === 'function') window.showFlashcards(due); return; }
            fb.disabled = true;
            const ok = (typeof window.coachStartTargetedFlash === 'function') && await window.coachStartTargetedFlash();
            if (!ok) { fb.disabled = false; if (typeof window.showErrorToast === 'function') window.showErrorToast('Aucune flashcard générable pour le moment.'); }
        };
        const qb = document.getElementById('dpQuizBtn');
        if (qb) qb.onclick = async () => {
            qb.disabled = true;
            const ok = (typeof window.coachStartTargetedQuiz === 'function') && await window.coachStartTargetedQuiz();
            if (!ok) { qb.disabled = false; if (typeof window.showErrorToast === 'function') window.showErrorToast('Session ciblée indisponible pour le moment.'); }
        };
        const cb = document.getElementById('dpChapterBtn');
        if (cb) cb.onclick = () => {
            if (typeof window.openSubModule === 'function') {
                window.openSubModule({ name: chapter.name, files: chapter.files, parentName: chapter.parentName });
            }
        };
    }

    window.pedagoRenderReadiness = renderReadiness;
    window.pedagoRenderDailyPlan = renderDailyPlan;

    // Init : le plan du jour est rendu à l'accueil (le score de préparation est rendu à
    // l'ouverture de la vue Stats via showStatsView). Délai aligné sur coach.js (2 s) : laisser
    // COURSE_DATA et le DOM se poser avant le premier rendu.
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(renderDailyPlan, 2200);
    });
})();
