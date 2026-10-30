// js/modules/exam.js
// v6.9.10 — Extrait de app.js (refactor incrémental, étape 3/4 partielle).
// Dépend de :
//   - window.COURSE_DATA, window.RNCP_REFERENTIEL (data.js)
//   - window.getModuleTheme, window.getModuleKey, window.renderModuleContent, window.showSuccessToast (app.js, exposés par PATCH 5)
// Expose :
//   - window.MOCK_EXAM_CONFIG (lu par startMockExam/finishMockExam restés dans app.js)
//   - window.buildCpToCcpMap, window.inferCcpForQuestion, window.sampleN (utils purs, lus par startMockExam)
//   - window.renderExamMode (câblé sur btnExamMode dans app.js)
//   - window.renderExamLauncher (câblé sur btnExamMode dans app.js)
//   - window.showParcoursPrioritaire (banner boot + refresh sur clic étoile)
//   - window.filterByCP (bouton "Réviser ces modules" + bouton "Commencer" du banner prioritaire)
(function () {
    'use strict';

    const MOCK_EXAM_CONFIG = {
        targetCount: 45,
        durationSec: 60 * 60,
        passThreshold: 12,
        distribution: {
            "CCP 1 - Accueillir pour analyser la demande des personnes": 0.34,
            "CCP 2 - Accompagner les personnes dans leur parcours":     0.34,
            "CCP 3 - Mettre en œuvre une offre de services employeurs": 0.22,
            "Transversal":                                              0.10
        }
    };

    function buildCpToCcpMap() {
        const map = {};
        Object.entries(window.RNCP_REFERENTIEL).forEach(([ccpKey, ccp]) => {
            ccp.competences.forEach(cp => { map[cp.code] = ccpKey; });
        });
        return map;
    }

    function inferCcpForQuestion(moduleId, cpToCcp) {
        const mod = (window.COURSE_DATA.modules || []).find((_, i) => i === moduleId);
        if (!mod || !Array.isArray(mod.cp) || mod.cp.length === 0) return "Transversal";
        const counts = {};
        mod.cp.forEach(cpCode => {
            const ccp = cpToCcp[cpCode] || "Transversal";
            counts[ccp] = (counts[ccp] || 0) + 1;
        });
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }

    function sampleN(arr, n) {
        const copy = arr.slice();
        const result = [];
        const k = Math.min(n, copy.length);
        for (let i = 0; i < k; i++) {
            const j = i + Math.floor(Math.random() * (copy.length - i));
            [copy[i], copy[j]] = [copy[j], copy[i]];
            result.push(copy[i]);
        }
        return result;
    }

    function renderExamMode() {
        const container = document.getElementById('examContent');
        if (!container) return;
        const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
        container.innerHTML = '';

        Object.entries(window.RNCP_REFERENTIEL).forEach(([ccpKey, ccp]) => {
            const linkedModules = window.COURSE_DATA.modules.filter(mod =>
                (mod.cp || []).some(cp => ccp.competences.map(c => c.code).includes(cp))
            );

            let totalDocs = 0, doneDocs = 0;
            linkedModules.forEach(mod => {
                const files = [...(mod.files || []), ...(mod.sub_modules || []).flatMap(s => s.files || [])];
                totalDocs += files.length;
                doneDocs += files.filter(f => completed.includes(f)).length;
            });
            const pct = totalDocs > 0 ? Math.round((doneDocs / totalDocs) * 100) : 0;
            const status = pct >= 80 ? '✅' : pct >= 40 ? '⚠️' : '❌';

            const section = document.createElement('div');
            section.style.cssText = 'margin-bottom: 25px; padding: 20px; background: rgba(255,255,255,0.03); border-radius: 16px; border-left: 4px solid ' + ccp.color + ';';
            section.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <h3 style="color:${ccp.color};">${status} ${ccp.short}</h3>
                    <span style="font-size:1.2rem; font-weight:800; color:${ccp.color};">${pct}%</span>
                </div>
                <div style="height:6px; background:rgba(255,255,255,0.08); border-radius:3px; margin-bottom:15px; overflow:hidden;">
                    <div style="width:${pct}%; height:100%; background:${ccp.color}; border-radius:3px; transition:width 0.5s;"></div>
                </div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    ${ccp.competences.map(cp => {
                        const selfScore = parseInt(localStorage.getItem(`self_${cp.code}`) || '0');
                        return `
                        <div style="padding:10px 15px; background:rgba(255,255,255,0.03); border-radius:10px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                                <div style="font-size:0.75rem; opacity:0.5;">${cp.code}</div>
                                <div class="self-eval-stars" data-cp="${cp.code}" style="display:flex; gap:3px;">
                                    ${[1, 2, 3, 4, 5].map(s => `<span class="star ${s <= selfScore ? 'active' : ''}" data-val="${s}" style="cursor:pointer; font-size:0.8rem; color:${s <= selfScore ? '#f59e0b' : 'rgba(255,255,255,0.1)'};">★</span>`).join('')}
                                </div>
                            </div>
                            <div style="font-size:0.85rem; font-weight:600;">${cp.label}</div>
                            <div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:5px;">
                                ${cp.criteres.map(c => `<span style="font-size:0.65rem; padding:2px 8px; background:rgba(255,255,255,0.06); border-radius:20px; opacity:0.7;">${c}</span>`).join('')}
                            </div>
                        </div>`;
                    }).join('')}
                </div>
                <button id="btnFilterCP-${ccpKey.replace(/\s+/g, '')}"
                        style="margin-top:12px; padding:8px 15px; background:${ccp.color}22; color:${ccp.color}; border:1px solid ${ccp.color}44; border-radius:8px; cursor:pointer; font-size:0.8rem; width:100%;">
                    📚 Réviser ces modules
                </button>
            `;
            container.appendChild(section);
            document.getElementById(`btnFilterCP-${ccpKey.replace(/\s+/g, '')}`).onclick = () => filterByCP(ccp.competences.map(c => c.code));
        });

        container.querySelectorAll('.star').forEach(star => {
            star.onclick = (e) => {
                const val = parseInt(e.target.dataset.val);
                const cp = e.target.parentElement.dataset.cp;
                localStorage.setItem(`self_${cp}`, val);
                renderExamMode();
                showParcoursPrioritaire();
            };
        });
    }

    function renderExamLauncher() {
        const countSpan = document.getElementById('examLauncherCount');
        const lastScoreEl = document.getElementById('examLauncherLastScore');
        if (!countSpan || !lastScoreEl) return;

        fetch('./data/quizzes.json')
            .then(r => r.ok ? r.json() : [])
            .then(quizzes => {
                const total = (quizzes || []).reduce((s, q) => s + (q.questions || []).length, 0);
                const target = Math.min(MOCK_EXAM_CONFIG.targetCount, total);
                countSpan.textContent = `${target} questions`;
            })
            .catch(() => { countSpan.textContent = '~45 questions'; });

        const history = JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]');
        const lastMock = history.find(h => h.type === 'examBlanc');
        if (lastMock) {
            const note = lastMock.note != null ? `${lastMock.note}/20` : `${lastMock.score}/${lastMock.total}`;
            const verdict = lastMock.passed ? '✅ Admis' : '❌ Ajourné';
            lastScoreEl.innerHTML = `Dernière tentative : <strong>${note}</strong> ${verdict} <span style="opacity:0.6;">(${lastMock.date})</span>`;
        } else {
            lastScoreEl.textContent = 'Aucune tentative — démarre quand tu veux.';
        }
    }

    function showParcoursPrioritaire() {
        const hero = document.querySelector('.hero') || document.body;
        let banner = document.getElementById('priorityBanner');

        const lowCPs = [];
        Object.values(window.RNCP_REFERENTIEL).forEach(ccp => {
            ccp.competences.forEach(cp => {
                const score = parseInt(localStorage.getItem(`self_${cp.code}`) || '0');
                if (score > 0 && score <= 2) lowCPs.push(cp.code);
            });
        });

        if (lowCPs.length === 0) {
            if (banner) banner.remove();
            return;
        }

        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'priorityBanner';
            banner.className = 'priority-banner';
            banner.style.cssText = 'background: linear-gradient(90deg, #f43f5e, #fb7185); color: white; padding: 15px 25px; border-radius: 12px; margin-bottom: 25px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 10px 20px rgba(244,63,94,0.3); animation: slideIn 0.5s ease;';
            hero.insertBefore(banner, hero.firstChild);
        }

        const recommendedModules = window.COURSE_DATA.modules
            .filter(mod => (mod.cp || []).some(cp => lowCPs.includes(cp)))
            .slice(0, 3);

        banner.innerHTML = `
            <div>
                <div style="font-weight:bold; display:flex; align-items:center; gap:8px; font-size:1.1rem;">
                    🚀 Parcours Prioritaire : ${lowCPs.length} compétences à renforcer
                </div>
                <div style="font-size:0.85rem; opacity:0.9; margin-top:4px;">
                    Modules recommandés : ${recommendedModules.map(m => m.name.split('-')[1]?.trim() || m.name).join(', ')}
                </div>
            </div>
            <button id="btnPriorityStart" class="btn-primary" style="background:white; color:#f43f5e; border:none; padding:8px 16px; font-size:0.8rem;">
                Commencer
            </button>
        `;
        // v9.31.2 : ex-handler inline `onclick="filterByCP([...])"`, bloqué par la CSP.
        // La closure passe le tableau directement — plus d'interpolation de codes CP
        // dans un littéral de chaîne à l'intérieur d'un attribut HTML.
        const btnStart = document.getElementById('btnPriorityStart');
        if (btnStart) btnStart.onclick = () => filterByCP(lowCPs);
    }

    function filterByCP(cpCodes) {
        document.getElementById('examModal').classList.add('hidden');
        const contentGrid = document.getElementById('contentGrid');
        const currentModuleName = document.getElementById('currentModuleName');
        const currentModuleSubtitle = document.getElementById('currentModuleSubtitle');

        const filtered = window.COURSE_DATA.modules.filter(mod =>
            (mod.cp || []).some(cp => cpCodes.includes(cp))
        );

        if (contentGrid) contentGrid.innerHTML = '';
        if (currentModuleName) currentModuleName.innerText = `🎯 Modules liés à ${cpCodes.join(', ')}`;
        if (currentModuleSubtitle) currentModuleSubtitle.innerText = `${filtered.length} module(s) à réviser`;

        if (filtered.length === 0) {
            if (contentGrid) contentGrid.innerHTML = '<div class="welcome-message"><p>Aucun module n\'est lié à ces compétences.</p></div>';
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }

        filtered.forEach(mod => {
            const theme = (typeof window.getModuleTheme === 'function') ? window.getModuleTheme(mod.name) : 'default';
            const modKey = (typeof window.getModuleKey === 'function') ? window.getModuleKey(mod.name) : '';
            const subCount = (mod.sub_modules || []).length;
            const fileCount = (mod.files || []).length;

            const card = document.createElement('div');
            card.className = `lesson-card glass theme-${theme}`;
            card.style.cursor = 'pointer';
            card.innerHTML = `
                <div class="card-image" style="background-image: url('assets/modules/${modKey}.png'), url('assets/themes/${theme}.png')"></div>
                <div class="card-content">
                    <div class="card-type">MODULE</div>
                    <h4>${mod.name}</h4>
                    <div class="lesson-meta">
                        <span>📚 ${subCount} chapitre${subCount > 1 ? 's' : ''}</span>
                        <span>📄 ${fileCount} document${fileCount > 1 ? 's' : ''}</span>
                    </div>
                </div>
            `;
            card.onclick = () => {
                if (typeof window.renderModuleContent === 'function') window.renderModuleContent(mod);
            };
            if (contentGrid) contentGrid.appendChild(card);
        });

        window.scrollTo({ top: 0, behavior: 'smooth' });
        if (currentModuleName) {
            currentModuleName.style.transition = 'color 0.4s';
            const originalColor = currentModuleName.style.color;
            currentModuleName.style.color = '#10b981';
            setTimeout(() => { currentModuleName.style.color = originalColor; }, 800);
        }

        if (typeof window.showSuccessToast === 'function') {
            window.showSuccessToast(`✅ ${filtered.length} module${filtered.length > 1 ? 's' : ''} affiché${filtered.length > 1 ? 's' : ''} pour révision`);
        }
    }

    // Exposition globale (rétrocompat des call-sites dans app.js).
    window.MOCK_EXAM_CONFIG = MOCK_EXAM_CONFIG;
    window.buildCpToCcpMap = buildCpToCcpMap;
    window.inferCcpForQuestion = inferCcpForQuestion;
    window.sampleN = sampleN;
    window.renderExamMode = renderExamMode;
    window.renderExamLauncher = renderExamLauncher;
    window.showParcoursPrioritaire = showParcoursPrioritaire;
    window.filterByCP = filterByCP;

    // Namespace optionnel.
    window.Almanach = window.Almanach || {};
    window.Almanach.exam = {
        config: MOCK_EXAM_CONFIG,
        buildCpToCcpMap, inferCcpForQuestion, sampleN,
        renderMode: renderExamMode,
        renderLauncher: renderExamLauncher,
        showParcoursPrioritaire,
        filterByCP,
    };

    // Boot : banner parcours prioritaire après 1s (DOM prêt + autres modules init).
    setTimeout(showParcoursPrioritaire, 1000);
})();
