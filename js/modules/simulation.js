// js/modules/simulation.js
// v6.9.9 — Extrait de app.js (refactor incrémental, étape 2/4).
// Dépend de :
//   - window.aiHelper.speakAs / stopSimSpeak (ai-helper.js, chargé APRÈS — appelé seulement au clic user, donc OK).
//   - window.checkAchievements (modules/achievements.js, déblocage badge `simulator`).
// Expose :
//   - window.loadScenarios (appelée depuis le câblage `btnLab` dans app.js)
//   - window.openScenario (appelée en interne mais exposée pour debug / extension)
//   - window.startSimulation (déjà exposée historiquement, appelée depuis bouton inline dans openScenario)
(function () {
    'use strict';

    // State interne du moteur de simulation.
    let currentSimScore = 0;
    let currentSimTurn = 0;
    let simData = null;
    let simDecisions = 0;   // nb de choix faits (score max = decisions × 10, chemins de longueur variable)
    let simTurnDisplay = 0; // compteur d'affichage « Étape N »

    // v9.7.0 : file séquentielle des lectures TTS de la simulation.
    // Évite la collision feedback-CIP / réplique-persona (la 2ᵉ lecture appelait router.stop()
    // et coupait la 1ʳᵉ → feedback CIP jamais entendu).
    // Une génération (`simSpeakGen`) annule la file en cours quand l'utilisateur enchaîne.
    let simSpeakChain = Promise.resolve();
    let simSpeakGen = 0;

    // Coupe l'audio en cours, vide la file et invalide la génération courante.
    function flushSimSpeak() {
        simSpeakGen += 1;
        simSpeakChain = Promise.resolve();
        if (window.aiHelper && typeof window.aiHelper.stopSimSpeak === 'function') {
            window.aiHelper.stopSimSpeak();
        }
    }

    // Empile une lecture derrière la précédente (best-effort, no-op si voix-off ou helper absent).
    function queueSimSpeak(text, role) {
        if (!text) return;
        if (localStorage.getItem('almanach_sim_voiceover') === 'off') return;
        if (!window.aiHelper || typeof window.aiHelper.speakAsIfReady !== 'function') return;
        const myGen = simSpeakGen;
        simSpeakChain = simSpeakChain
            .catch(() => {})
            .then(() => {
                if (myGen !== simSpeakGen) return; // génération annulée par un nouveau clic
                return window.aiHelper.speakAsIfReady(text, role);
            });
    }

    async function loadScenarios() {
        const scenarioList = document.getElementById('scenarioList');
        if (!scenarioList) return;
        try {
            const response = await fetch('./data/scenarios.json');
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const scenarios = await response.json();
            scenarioList.innerHTML = '';
            scenarios.forEach(s => {
                const card = document.createElement('div');
                card.className = 'lesson-card glass';
                const imgStyle = s.image
                    ? `background-image: url('${s.image}'); background-color: #1a1a2e;`
                    : `background: linear-gradient(135deg, rgba(99,102,241,0.3), rgba(139,92,246,0.1));`;
                card.innerHTML = `
                    <div class="card-image" style="${imgStyle}"></div>
                    <div class="card-content">
                        <div class="card-type">SIMULATION · ${s.steps ? s.steps.length + ' étapes' : (s.nodes ? 'Parcours interactif' : 'Étude de cas')}</div>
                        <h4>${s.title}</h4>
                        <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:5px; line-height:1.5;">${s.situation.substring(0, 90)}…</p>
                    </div>`;
                card.onclick = () => openScenario(s);
                scenarioList.appendChild(card);
            });
        } catch (e) {
            scenarioList.innerHTML = '<p style="color:var(--text-secondary);">Scénarios non disponibles en mode hors-ligne.</p>';
            console.warn('loadScenarios:', e);
        }
    }

    // Mélange un tableau (variété : ordre des choix différent à chaque affichage).
    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // v9.6.0 : supporte les deux formats — linéaire (`steps[]`) et embranchements (`nodes{}` + `start`).
    // Pré-synthèse de toutes les répliques pour masquer la latence Supertonic à froid. Séquentiel.
    async function prewarmScenarioVoices(sim) {
        if (!sim) return;
        if (localStorage.getItem('almanach_sim_voiceover') === 'off') return;
        const helper = window.aiHelper;
        if (!helper || typeof helper.preSynthesizeAs !== 'function') return;
        let turns = [];
        if (sim.nodes) {
            const startNode = sim.nodes[sim.start];
            const otherNodes = Object.entries(sim.nodes)
                .filter(([id]) => id !== sim.start)
                .map(([, node]) => node);
            if (startNode) turns.push(startNode);
            turns.push(...otherNodes);
        } else {
            turns = sim.steps || [];
        }
        for (const step of turns) {
            if (!step) continue;
            if (step.text) {
                await helper.preSynthesizeAs(step.text, step.speaker || 'persona');
            }
            for (const choice of (step.choices || [])) {
                if (choice && choice.feedback) {
                    await helper.preSynthesizeAs(choice.feedback, choice.speakerOverride || 'cip');
                }
            }
        }
    }

    // v9.31.2 : sortie de simulation centralisée. Le bouton « Terminer » du débriefing
    // simulait un clic sur #backToLab via un attribut onclick inline — bloqué par la CSP
    // (script-src 'self'), il ne faisait donc rien depuis la v9.20.0.
    function returnToLab() {
        flushSimSpeak();
        document.getElementById('scenarioView').classList.add('hidden');
        document.getElementById('labWelcome').classList.remove('hidden');
        loadScenarios();
    }

    // Construit l'ossature de la vue simulation (titre + score + voix-off + journal + choix).
    // Appelée une seule fois au démarrage (remplace la vue d'intro d'openScenario).
    function buildScaffold() {
        const voTitle = localStorage.getItem('almanach_sim_voiceover') === 'off' ? '🔇' : '🔊';
        document.getElementById('scenarioView').innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 id="scenarioTitle">${simData.title}</h2>
                <div style="display:flex; gap:10px; align-items:center;">
                    <button id="simVoiceoverToggle" class="btn-icon" title="Couper / activer la voix-off" style="background:rgba(255,255,255,0.1);">${voTitle}</button>
                    <div id="simScore" style="font-weight:bold; color:var(--accent);">Score: 0</div>
                </div>
            </div>
            <div class="glass" style="padding:20px; border-radius:15px; margin-bottom:20px;">
                <div id="simProfile" style="margin-bottom:15px; padding-bottom:15px; border-bottom:1px solid rgba(255,255,255,0.1);">
                    <strong>👤 Candidat :</strong> ${simData.candidate || 'Anonyme'}
                </div>
                <div id="simLog" style="max-height:300px; overflow-y:auto; margin-bottom:20px; font-size:0.95rem; line-height:1.6;"></div>
                <div id="simChoices" style="display:flex; flex-direction:column; gap:10px;"></div>
            </div>
            <button id="backToLab" class="btn-nav">⬅ Retour</button>
        `;
        document.getElementById('backToLab').onclick = returnToLab;
        const voBtn = document.getElementById('simVoiceoverToggle');
        if (voBtn) {
            voBtn.onclick = () => {
                const cur = localStorage.getItem('almanach_sim_voiceover') || 'on';
                const next = cur === 'on' ? 'off' : 'on';
                localStorage.setItem('almanach_sim_voiceover', next);
                voBtn.textContent = next === 'off' ? '🔇' : '🔊';
                if (next === 'off') flushSimSpeak();
            };
        }
    }

    // Affiche un « tour » (un nœud OU une étape) : bulle du locuteur + boutons de choix.
    // Le passage au tour suivant est délégué à advance(choice) (linéaire vs embranchement).
    function renderTurn(node) {
        const simLog = document.getElementById('simLog');
        const simChoices = document.getElementById('simChoices');
        const simScore = document.getElementById('simScore');

        const speaker = node.speaker || 'persona';
        const personaName = simData.personaName || simData.candidate || 'Candidat';
        const speakerLabel = speaker === 'cip' ? '🎓 CIP' : `👤 ${personaName}`;
        const bubbleClass = speaker === 'cip' ? 'sim-bubble sim-bubble-cip' : 'sim-bubble sim-bubble-persona';
        simTurnDisplay += 1;
        const message = document.createElement('div');
        message.className = bubbleClass;
        message.innerHTML = `<div class="sim-speaker">${speakerLabel} · Étape ${simTurnDisplay}</div><div class="sim-text">${node.text}</div>`;
        simLog.appendChild(message);
        simLog.scrollTop = simLog.scrollHeight;
        queueSimSpeak(node.text, speaker);

        simChoices.innerHTML = '';
        shuffle(node.choices || []).forEach((choice) => {
            const btn = document.createElement('button');
            btn.className = 'btn-nav';
            btn.style.textAlign = 'left';
            btn.innerText = choice.text;
            btn.onclick = () => {
                const tClick = performance.now();
                flushSimSpeak(); // coupe la réplique en cours, nouvelle génération de file
                currentSimScore += choice.points;
                simDecisions += 1;
                simScore.innerText = `Score: ${currentSimScore}`;

                const feedback = document.createElement('div');
                feedback.style.cssText = `padding:10px; border-radius:8px; margin-bottom:15px; font-size:0.85rem; background:${choice.points > 0 ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)'}; color:${choice.points > 0 ? '#10b981' : '#f43f5e'};`;
                feedback.innerHTML = `<strong>${choice.points > 0 ? '✅' : '⚠️'}</strong> ${choice.feedback}`;
                simLog.appendChild(feedback);
                queueSimSpeak(choice.feedback, choice.speakerOverride || 'cip');
                advance(choice); // renderTurn empile la réplique suivante DERRIÈRE le feedback
                // v9.6.1 : chrono clic → réponse réellement affichée (double rAF = après repaint).
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    console.log(`[Sim clic] réponse affichée en ${Math.round(performance.now() - tClick)} ms`);
                }));
            };
            simChoices.appendChild(btn);
        });
    }

    // Décide du tour suivant : embranchement (choice.next → nœud) ou linéaire (étape +1).
    function advance(choice) {
        if (simData.nodes) {
            const nextId = choice.next;
            if (!nextId || nextId === 'end' || !simData.nodes[nextId]) showSimDebriefing();
            else renderTurn(simData.nodes[nextId]);
        } else {
            currentSimTurn++;
            if (currentSimTurn < simData.steps.length) renderTurn(simData.steps[currentSimTurn]);
            else showSimDebriefing();
        }
    }

    function startSimulation(sim) {
        const labWelcome = document.getElementById('labWelcome');
        const scenarioView = document.getElementById('scenarioView');
        simData = sim;
        currentSimScore = 0;
        currentSimTurn = 0;
        simDecisions = 0;
        simTurnDisplay = 0;
        if (labWelcome) labWelcome.classList.add('hidden');
        if (scenarioView) scenarioView.classList.remove('hidden');
        flushSimSpeak(); // v9.7.0 : repart d'une file vide (annule tout reliquat d'un scénario précédent)
        prewarmScenarioVoices(sim); // v9.4.0 : pré-chauffage voix en arrière-plan (fire-and-forget)
        buildScaffold();
        const first = sim.nodes ? sim.nodes[sim.start] : (sim.steps || [])[0];
        if (first) renderTurn(first);
    }

    function showSimDebriefing() {
        const simChoices = document.getElementById('simChoices');
        const maxScore = Math.max(1, simDecisions) * 10;
        const ratio = currentSimScore / maxScore;

        let rank = "Novice";
        if (ratio > 0.8) rank = "Expert CIP";
        else if (ratio > 0.5) rank = "Praticien";

        const simDone = parseInt(localStorage.getItem('almanach_sim_done') || '0') + 1;
        localStorage.setItem('almanach_sim_done', String(simDone));
        if (typeof window.checkAchievements === 'function') window.checkAchievements();
        // v9.1.0 : la performance nourrit l'Elo du CP associé au scénario (coach.js).
        if (typeof window.coachRecordSimResult === 'function') window.coachRecordSimResult(simData.id, ratio);

        simChoices.innerHTML = `
            <div class="glass" style="padding:20px; border-radius:12px; text-align:center; border:2px solid var(--accent);">
                <h3 style="margin-bottom:10px;">Simulation Terminée !</h3>
                <div style="font-size:2rem; font-weight:bold; color:var(--accent);">${currentSimScore} / ${maxScore} points</div>
                <div style="margin-top:5px; font-weight:600;">Rang : ${rank}</div>
                <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:15px;">
                    Votre performance a été enregistrée. Vous pouvez consulter les recommandations dans le module correspondant.
                </p>
                <button id="simFinish" class="btn-primary" style="margin-top:20px; width:100%;">Terminer</button>
            </div>
        `;
        const finishBtn = document.getElementById('simFinish');
        if (finishBtn) finishBtn.onclick = returnToLab;
    }

    function openScenario(s) {
        const labWelcome = document.getElementById('labWelcome');
        const scenarioView = document.getElementById('scenarioView');
        if (labWelcome) labWelcome.classList.add('hidden');
        if (scenarioView) scenarioView.classList.remove('hidden');

        // Commencer le préchauffage des voix dès l'ouverture de la fiche de présentation
        prewarmScenarioVoices(s);

        const imgBg = s.image
            ? `background-image:url('${s.image}'); background-size:cover; background-position:center;`
            : `background:linear-gradient(135deg,rgba(99,102,241,0.4),rgba(139,92,246,0.2));`;
        document.getElementById('simProfile').innerHTML = `
            <div style="height:100%;display:flex;flex-direction:column;gap:0;">
                <div style="${imgBg} height:130px; border-radius:12px 12px 0 0; flex-shrink:0; position:relative;">
                    <div style="position:absolute;bottom:0;left:0;right:0;height:60%;background:linear-gradient(to top,rgba(10,10,18,0.9),transparent);border-radius:0 0 0 0;"></div>
                </div>
                <div class="glass" style="padding:16px;border-radius:0 0 12px 12px;flex:1;overflow-y:auto;">
                    <h4 style="color:var(--accent);margin-bottom:10px;font-size:0.95rem;">${s.title}</h4>
                    <div style="font-size:0.65rem;opacity:0.5;margin-bottom:7px;text-transform:uppercase;letter-spacing:1px;">Objectifs</div>
                    <ul style="padding-left:16px;line-height:1.9;font-size:0.8rem;">
                        ${s.objectives.map(o => `<li>${o}</li>`).join('')}
                    </ul>
                </div>
            </div>`;

        const simLog = document.getElementById('simLog');
        simLog.innerHTML = '';

        const situation = document.createElement('div');
        situation.style.cssText = 'padding:15px;background:rgba(255,255,255,0.04);border-radius:10px;margin-bottom:15px;';
        situation.innerHTML = `<div style="font-size:0.7rem;opacity:0.5;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Situation</div><p style="line-height:1.7;font-size:0.92rem;">${s.situation}</p>`;
        simLog.appendChild(situation);

        if (s.recommendations && s.recommendations.length) {
            const recTitle = document.createElement('div');
            recTitle.style.cssText = 'font-size:0.7rem;opacity:0.5;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;';
            recTitle.textContent = 'Modules recommandés';
            simLog.appendChild(recTitle);
            s.recommendations.forEach(r => {
                const rec = document.createElement('div');
                rec.className = 'glass';
                rec.style.cssText = 'padding:10px 15px;border-radius:10px;margin-bottom:8px;border-left:3px solid #10b981;';
                const strong = document.createElement('strong');
                strong.style.fontSize = '0.8rem';
                strong.textContent = r.module;
                const span = document.createElement('span');
                span.style.cssText = 'display:block;font-size:0.73rem;opacity:0.6;margin-top:3px;';
                span.textContent = r.reason;
                rec.appendChild(strong);
                rec.appendChild(span);
                simLog.appendChild(rec);
            });
        }

        const simChoices = document.getElementById('simChoices');
        simChoices.innerHTML = '';

        if ((s.steps && s.steps.length > 0) || s.nodes) {
            const btnStart = document.createElement('button');
            btnStart.className = 'btn-primary';
            btnStart.style.cssText = 'width:100%;margin-top:10px;';
            btnStart.textContent = '🎯 Démarrer la simulation interactive';
            btnStart.onclick = () => startSimulation(s);
            simChoices.appendChild(btnStart);
        }

        const btnBack = document.createElement('button');
        btnBack.className = 'btn-nav';
        btnBack.style.marginTop = '8px';
        btnBack.textContent = '← Retour aux scénarios';
        btnBack.onclick = () => {
            document.getElementById('scenarioView').classList.add('hidden');
            document.getElementById('labWelcome').classList.remove('hidden');
        };
        simChoices.appendChild(btnBack);
    }

    // Exposition globale (rétrocompat des call-sites dans app.js).
    window.loadScenarios = loadScenarios;
    window.openScenario = openScenario;
    window.startSimulation = startSimulation;

    // Namespace optionnel.
    window.Almanach = window.Almanach || {};
    window.Almanach.simulation = {
        load: loadScenarios,
        open: openScenario,
        start: startSimulation,
    };
})();
