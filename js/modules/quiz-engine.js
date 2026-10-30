// js/modules/quiz-engine.js — v9.8.0
// Moteur quiz + examen blanc, extrait de app.js (le state window.QuizStore, exposé en v9.7.0,
// a levé le blocage du closure partagé). Pattern IIFE : expose sur window les points d'entrée
// (startQuiz, showQuestion, quizNextHandler, startMockExam, finishMockExam, runCoachQuiz,
// runGeneratedQuiz, runGlobalQuiz). Les appels internes restent directs (même scope).
// Dépendances globales : window.QuizStore, window.buildDeterministicQuiz / coachBuildGlobalQuiz /
// coachRecordResult (coach.js), MOCK_EXAM_CONFIG / buildCpToCcpMap / inferCcpForQuestion / sampleN
// (exam.js), RNCP_REFERENTIEL (data.js), checkAchievements (achievements.js),
// renderDashboardStats (stats-view.js), showErrorToast (app.js).
(function () {

    // State quiz partagé (ex-locaux du closure app.js, migré sur window en v9.7.0).
    window.QuizStore = { current: null, idx: 0, score: 0 };

    // --- Lanceurs -----------------------------------------------------------

    // v9.0.0 : lance un quiz préparé par le coach (js/modules/coach.js).
    window.runCoachQuiz = (item) => {
        window.QuizStore.current = { title: `🎯 Coach : ${item.chapter}`, questions: item.questions, coachCp: item.cp };
        window.QuizStore.idx = 0;
        window.QuizStore.score = 0;
        document.getElementById('quizModal').classList.remove('hidden');
        document.getElementById('quizTitle').innerText = window.QuizStore.current.title;
        showQuestion();
    };

    window.runGeneratedQuiz = (chapterTitle, content) => runGeneratedQuiz(chapterTitle, content);
    async function runGeneratedQuiz(chapterTitle, content) {
        // v9.2.0 : génération déterministe (templates glossaire + texte à trou,
        // window.buildDeterministicQuiz de coach.js). Marche offline. Titre « Quiz IA : »
        // conservé car coachRecordResult (coach.js) s'en sert pour rattacher le score aux CP.
        const btn = document.getElementById('btnQuizIA');
        const originalText = btn.innerText;
        btn.innerText = "⏳ Génération...";
        btn.disabled = true;
        try {
            const questions = (typeof window.buildDeterministicQuiz === 'function')
                ? window.buildDeterministicQuiz(String(content), { count: 5 })
                : [];
            if (!questions.length) {
                throw new Error("Pas assez de matière exploitable dans ce chapitre pour construire un quiz.");
            }
            window.QuizStore.current = { title: `Quiz IA : ${chapterTitle}`, questions };
            window.QuizStore.idx = 0;
            window.QuizStore.score = 0;
            document.getElementById('quizModal').classList.remove('hidden');
            document.getElementById('quizTitle').innerText = window.QuizStore.current.title;
            showQuestion();
        } catch (e) {
            console.error(e);
            alert("Erreur génération quiz : " + e.message);
        } finally {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    }

    // v9.3.0 : quiz général sur toute la matière (icône 🧠). Délègue la construction des QCM à
    // coach.js (coachBuildGlobalQuiz, déterministe). Titre sans coachCp → ne biaise aucun Elo.
    window.runGlobalQuiz = async () => {
        const btn = document.getElementById('btnQuizGlobal');
        const original = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '⏳<span class="btn-label">Quiz</span>'; }
        try {
            const questions = (typeof window.coachBuildGlobalQuiz === 'function')
                ? await window.coachBuildGlobalQuiz(10)
                : [];
            if (!questions.length) {
                alert("Pas assez de matière exploitable pour construire un quiz général.");
                return;
            }
            window.QuizStore.current = { title: '🧠 Quiz général', questions };
            window.QuizStore.idx = 0;
            window.QuizStore.score = 0;
            document.getElementById('quizModal').classList.remove('hidden');
            document.getElementById('quizTitle').innerText = window.QuizStore.current.title;
            showQuestion();
        } catch (e) {
            console.error(e);
            alert("Erreur génération quiz général : " + e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
        }
    };

    // --- Moteur quiz --------------------------------------------------------

    async function startQuiz(modNum) {
        try {
            const response = await fetch('./data/quizzes.json');
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const quizzes = await response.json();
            window.QuizStore.current = quizzes.find(q => q.moduleId === modNum);
            if (!window.QuizStore.current) {
                alert("Aucun quiz disponible pour ce module pour le moment.");
                return;
            }
            document.getElementById('quizModal').classList.remove('hidden');
            document.getElementById('quizTitle').innerText = window.QuizStore.current.title;
            window.QuizStore.idx = 0;
            window.QuizStore.score = 0;
            showQuestion();
        } catch (e) {
            alert("Quiz non disponible en mode hors-ligne.");
            console.warn('startQuiz:', e);
        }
    }
    window.startQuiz = startQuiz;

    function showQuestion() {
        const q = window.QuizStore.current.questions[window.QuizStore.idx];
        document.getElementById('quizQuestion').innerText = q.q;
        document.getElementById('quizResult').classList.add('hidden');
        const options = document.getElementById('quizOptions');
        options.innerHTML = '';

        q.options.forEach((opt, i) => {
            const btn = document.createElement('button');
            btn.className = 'btn-nav';
            btn.style.width = '100%';
            btn.style.textAlign = 'left';
            btn.style.background = 'rgba(255,255,255,0.05)';
            btn.innerText = opt;
            btn.onclick = () => checkAnswer(i);
            options.appendChild(btn);
        });
        if (window.QuizStore.current && window.QuizStore.current.mockExam) {
            const idxEl = document.getElementById('quizProgressIdx');
            if (idxEl) idxEl.textContent = (window.QuizStore.idx + 1);
        }
        startTimer();
    }
    window.showQuestion = showQuestion;

    let quizTimerInterval = null;

    function startTimer() {
        if (window.QuizStore.current && window.QuizStore.current.mockExam) {
            const perQ = document.getElementById('quizTimer');
            if (perQ) perQ.classList.add('hidden');
            return;
        }
        clearInterval(quizTimerInterval);
        let seconds = 60;
        const timerEl = document.getElementById('quizTimer');
        timerEl.classList.remove('hidden');
        timerEl.textContent = seconds;
        timerEl.style.color = 'var(--accent)';

        quizTimerInterval = setInterval(() => {
            seconds--;
            timerEl.textContent = seconds;
            if (seconds <= 10) timerEl.style.color = '#f43f5e';
            if (seconds <= 0) {
                clearInterval(quizTimerInterval);
                checkAnswer(-1); // -1 = temps écoulé, forcément faux
            }
        }, 1000);
    }

    function checkAnswer(idx) {
        clearInterval(quizTimerInterval);
        const q = window.QuizStore.current.questions[window.QuizStore.idx];
        const result = document.getElementById('quizResult');
        const feedback = document.getElementById('quizFeedback');

        // Mémoriser la réponse (utile pour finishMockExam)
        q._userAnswer = idx;

        if (idx === q.a) {
            window.QuizStore.score++;
        }

        if (window.QuizStore.current.mockExam) {
            // Mode examen blanc : pas de feedback immédiat — on enchaîne directement
            result.classList.add('hidden');
            const isLast = window.QuizStore.idx >= window.QuizStore.current.questions.length - 1;
            if (isLast) {
                finishMockExam(false);
                return;
            }
            window.QuizStore.idx++;
            showQuestion();
            return;
        }

        // Mode quiz module : feedback immédiat (comportement existant)
        result.classList.remove('hidden');
        if (idx === q.a) {
            feedback.innerText = "✅ Correct !";
            result.style.background = 'rgba(16, 185, 129, 0.2)';
        } else {
            feedback.innerText = `❌ Incorrect. La réponse était : ${q.options[q.a]}`;
            result.style.background = 'rgba(244, 63, 94, 0.2)';
        }

        document.getElementById('nextQuiz').classList.remove('hidden');
        document.getElementById('nextQuiz').innerText = window.QuizStore.idx < window.QuizStore.current.questions.length - 1 ? "Question Suivante" : "Terminer le Quiz";

        document.querySelectorAll('#quizOptions button').forEach(b => b.disabled = true);
    }

    // Handler du bouton « Question suivante / Terminer » (câblé dans app.js sur #nextQuiz).
    function quizNextHandler() {
        // Mode examen blanc : checkAnswer enchaîne déjà, ce handler ne doit rien faire
        if (window.QuizStore.current && window.QuizStore.current.mockExam) return;
        window.QuizStore.idx++;
        if (window.QuizStore.idx < window.QuizStore.current.questions.length) {
            showQuestion();
        } else {
            // Sauvegarder le score
            const quizTotal = window.QuizStore.current.questions.length;
            const quizNote = quizTotal > 0 ? Math.round((window.QuizStore.score / quizTotal) * 20 * 10) / 10 : 0;
            const quizMention =
                quizNote >= 16 ? '🏆 Excellent' :
                quizNote >= 14 ? '👏 Très bien' :
                quizNote >= 12 ? '✅ Bien' :
                quizNote >= 10 ? '🙂 Passable' :
                                 '📚 À retravailler';
            const quizHistory = JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]');
            quizHistory.unshift({
                module: window.QuizStore.current.title,
                score: window.QuizStore.score,
                total: quizTotal,
                note: quizNote,
                date: new Date().toLocaleDateString('fr-FR')
            });
            localStorage.setItem('almanach_quiz_history', JSON.stringify(quizHistory.slice(0, 20)));
            if (typeof checkAchievements === 'function') checkAchievements();
            if (typeof renderDashboardStats === 'function') renderDashboardStats();
            // v9.0.0 : nourrit le profil Elo du coach (js/modules/coach.js).
            if (typeof window.coachRecordResult === 'function') window.coachRecordResult(window.QuizStore.current, window.QuizStore.score, window.QuizStore.current.questions.length);

            const prevHistory = quizHistory.filter(h => h.module === window.QuizStore.current.title).slice(1, 4);
            const historyHtml = prevHistory.length > 0
                ? `<p style="font-size:0.75rem; opacity:0.5; margin-top:10px;">Tentatives précédentes : ${prevHistory.map(h => `${h.score}/${h.total} (${h.date})`).join(' | ')}</p>`
                : '';

            document.getElementById('quizQuestion').innerHTML = `
                <div style="text-align:center; padding: 20px;">
                    <div style="font-size: 3rem; margin-bottom: 15px;">${window.QuizStore.score === window.QuizStore.current.questions.length ? '🏆' : window.QuizStore.score > 0 ? '👏' : '📚'}</div>
                    <h3>Quiz terminé !</h3>
                    <p style="font-size: 2rem; margin: 12px 0 4px; color: var(--accent); font-weight:800;">${quizNote}/20</p>
                    <p style="font-size: 1rem; margin: 0 0 10px; font-weight:600;">${quizMention}</p>
                    <p style="color: var(--text-secondary); font-size:0.85rem;">${window.QuizStore.score} bonne(s) réponse(s) sur ${quizTotal}</p>
                    ${historyHtml}
                </div>`;
            document.getElementById('quizOptions').innerHTML = '';
            document.getElementById('quizTimer').classList.add('hidden');
            document.getElementById('nextQuiz').textContent = 'Fermer';
            document.getElementById('nextQuiz').onclick = () => document.getElementById('quizModal').classList.add('hidden');
        }
    }
    window.quizNextHandler = quizNextHandler;

    // --- Examen blanc -------------------------------------------------------

    async function startMockExam() {
        try {
            const response = await fetch('./data/quizzes.json');
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const quizzes = await response.json();
            const cpToCcp = buildCpToCcpMap();

            const flat = [];
            quizzes.forEach(qz => {
                const ccp = inferCcpForQuestion(qz.moduleId, cpToCcp);
                (qz.questions || []).forEach(q => {
                    flat.push({
                        q: q.q,
                        options: q.options,
                        a: q.a,
                        _ccp: ccp,
                        _moduleTitle: qz.title || `Module ${qz.moduleId}`,
                        _moduleId: qz.moduleId
                    });
                });
            });

            if (flat.length === 0) {
                alert("Aucune question disponible pour générer un examen blanc.");
                return;
            }

            const buckets = {};
            flat.forEach(q => { (buckets[q._ccp] = buckets[q._ccp] || []).push(q); });

            const target = Math.min(MOCK_EXAM_CONFIG.targetCount, flat.length);
            let selected = [];
            Object.entries(MOCK_EXAM_CONFIG.distribution).forEach(([ccpKey, ratio]) => {
                const want = Math.round(target * ratio);
                const pool = buckets[ccpKey] || [];
                selected = selected.concat(sampleN(pool, want));
            });

            if (selected.length < target) {
                const taken = new Set(selected);
                const remaining = flat.filter(q => !taken.has(q));
                selected = selected.concat(sampleN(remaining, target - selected.length));
            }
            selected = sampleN(selected, selected.length);

            window.QuizStore.current = {
                title: '🎓 Examen blanc CIP — TP-00403',
                questions: selected,
                mockExam: true,
                startedAt: Date.now()
            };
            window.QuizStore.idx = 0;
            window.QuizStore.score = 0;

            document.getElementById('examModal').classList.add('hidden');
            document.getElementById('quizModal').classList.remove('hidden');
            document.getElementById('quizTitle').innerText = window.QuizStore.current.title;
            document.getElementById('quizTimer').classList.add('hidden');
            document.getElementById('quizGlobalTimer').classList.remove('hidden');
            document.getElementById('quizProgressBadge').classList.remove('hidden');
            document.getElementById('quizProgressTotal').textContent = selected.length;
            document.getElementById('quizProgressIdx').textContent = '1';

            startGlobalExamTimer();
            showQuestion();
        } catch (e) {
            console.error('[startMockExam]', e);
            if (typeof showErrorToast === 'function') {
                showErrorToast("Impossible de lancer l'examen : " + e.message);
            } else {
                alert("Impossible de lancer l'examen : " + e.message);
            }
        }
    }
    window.startMockExam = startMockExam;

    let mockExamTimerInterval = null;

    function startGlobalExamTimer() {
        clearInterval(mockExamTimerInterval);
        const endAt = Date.now() + MOCK_EXAM_CONFIG.durationSec * 1000;
        const valueEl = document.getElementById('quizGlobalTimerValue');
        const tick = () => {
            const remaining = Math.max(0, Math.floor((endAt - Date.now()) / 1000));
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            valueEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            if (remaining <= 60) valueEl.parentElement.style.color = '#f43f5e';
            if (remaining <= 0) {
                clearInterval(mockExamTimerInterval);
                window.QuizStore.idx = window.QuizStore.current.questions.length;
                finishMockExam(true);
            }
        };
        tick();
        mockExamTimerInterval = setInterval(tick, 1000);
    }

    function stopGlobalExamTimer() {
        clearInterval(mockExamTimerInterval);
        mockExamTimerInterval = null;
        document.getElementById('quizGlobalTimer').classList.add('hidden');
        document.getElementById('quizProgressBadge').classList.add('hidden');
    }

    function finishMockExam(timeUp) {
        stopGlobalExamTimer();
        const total = window.QuizStore.current.questions.length;
        const score = window.QuizStore.score;
        const note = total > 0 ? Math.round((score / total) * 20 * 10) / 10 : 0;
        const passed = note >= MOCK_EXAM_CONFIG.passThreshold;

        const perCcp = {};
        window.QuizStore.current.questions.forEach((q) => {
            const ccp = q._ccp || 'Transversal';
            perCcp[ccp] = perCcp[ccp] || { ok: 0, total: 0 };
            perCcp[ccp].total++;
            if (q._userAnswer === q.a) perCcp[ccp].ok++;
        });

        const perCcpHtml = Object.entries(perCcp).map(([ccpKey, st]) => {
            const ccpInfo = RNCP_REFERENTIEL[ccpKey];
            const color = ccpInfo ? ccpInfo.color : '#94a3b8';
            const label = ccpInfo ? ccpInfo.short : ccpKey;
            const pct = st.total > 0 ? Math.round((st.ok / st.total) * 100) : 0;
            return `
                <div style="margin:6px 0;">
                    <div style="display:flex; justify-content:space-between; font-size:0.85rem; margin-bottom:4px;">
                        <span style="color:${color}; font-weight:600;">${label}</span>
                        <span>${st.ok}/${st.total} (${pct}%)</span>
                    </div>
                    <div style="height:6px; background:rgba(255,255,255,0.08); border-radius:3px; overflow:hidden;">
                        <div style="width:${pct}%; height:100%; background:${color};"></div>
                    </div>
                </div>`;
        }).join('');

        const wrong = window.QuizStore.current.questions
            .map((q, i) => ({ ...q, idx: i }))
            .filter(q => q._userAnswer !== q.a)
            .slice(0, 5);
        const wrongCount = window.QuizStore.current.questions.filter(q => q._userAnswer !== q.a).length;
        const wrongHtml = wrong.length === 0 ? '' : `
            <details style="margin-top:15px; text-align:left; background:rgba(244,63,94,0.08); padding:12px; border-radius:10px;">
                <summary style="cursor:pointer; font-weight:600; color:#f43f5e;">📝 ${wrongCount} question(s) à revoir (top 5)</summary>
                ${wrong.map(q => `
                    <div style="margin:10px 0; padding:10px; background:rgba(0,0,0,0.15); border-radius:8px;">
                        <div style="font-size:0.85rem; opacity:0.7; margin-bottom:4px;">${q._moduleTitle}</div>
                        <div style="font-weight:600; margin-bottom:6px;">Q. ${q.q}</div>
                        <div style="font-size:0.85rem; color:#10b981;">✅ ${q.options[q.a]}</div>
                    </div>`).join('')}
            </details>`;

        const quizHistory = JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]');
        quizHistory.unshift({
            module: window.QuizStore.current.title,
            type: 'examBlanc',
            score: score,
            total: total,
            note: note,
            passed: passed,
            date: new Date().toLocaleDateString('fr-FR')
        });
        localStorage.setItem('almanach_quiz_history', JSON.stringify(quizHistory.slice(0, 30)));
        if (typeof checkAchievements === 'function') checkAchievements();
        if (typeof renderDashboardStats === 'function') renderDashboardStats();

        const verdict = passed ? '🏆 ADMIS' : '📚 AJOURNÉ';
        const verdictColor = passed ? '#10b981' : '#f43f5e';
        const timeUpNote = timeUp ? '<p style="color:#f59e0b; font-size:0.85rem;">⏱ Temps écoulé — l\'examen a été clôturé automatiquement.</p>' : '';

        document.getElementById('quizQuestion').innerHTML = `
            <div style="text-align:center; padding:10px;">
                <div style="font-size:2.5rem; margin-bottom:10px; color:${verdictColor};">${verdict}</div>
                <p style="font-size:2rem; margin:10px 0; color:var(--accent); font-weight:800;">${note}/20</p>
                <p style="opacity:0.7; font-size:0.9rem;">${score} bonnes réponses sur ${total}</p>
                ${timeUpNote}
                <hr style="border:none; border-top:1px solid rgba(255,255,255,0.1); margin:15px 0;">
                <h4 style="text-align:left; margin:10px 0; font-size:0.95rem;">Détail par bloc de compétence</h4>
                ${perCcpHtml}
                ${wrongHtml}
            </div>`;
        document.getElementById('quizOptions').innerHTML = '';
        document.getElementById('quizResult').classList.add('hidden');

        const nextBtn = document.getElementById('nextQuiz');
        nextBtn.classList.remove('hidden');
        nextBtn.textContent = 'Fermer';
        nextBtn.onclick = () => {
            document.getElementById('quizModal').classList.add('hidden');
            window.QuizStore.current = null;
        };
    }
    window.finishMockExam = finishMockExam;

})();
