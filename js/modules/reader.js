// js/modules/reader.js
// v6.9.11 — Extrait de app.js (refactor incrémental, étape 4/4 finale).
// Dépend de :
//   - window.aiHelper.speak / extractFlashcards / pipeline / isSpeaking / currentAudio (ai-helper.js)
//   - window.electronAPI.runAI (preload.js)
//   - window.markAsRead, window.initSearchIndex, window.applyReaderTheme (app.js, exposés via PATCH 5-7)
//   - window.runGeneratedQuiz (app.js, exposé via PATCH 8 — reste dans app.js car manipule le state quiz)
//   - window.hideStatsView, window.checkAchievements (modules/stats-view.js, modules/achievements.js)
// Expose :
//   - window.openSubModule (câblé sur cards et historique dans app.js)
//   - window.showFlashcards (appelé depuis la recherche enrichie dans app.js)
//   - window.getCardSM2, window.updateCardSM2 (helpers SM2)
(function () {
    'use strict';

    // v9.26.0 : clé SM2 stable dérivée de la question (hash 32 bits → base36). Même question
    // ⇒ même entrée entre sessions (fin des clés par index flash_0/flash_1 qui se réécrasaient).
    function cardKey(q) {
        const s = String(q == null ? '' : q);
        let h = 0;
        for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
        return 'c' + (h >>> 0).toString(36);
    }

    function getCardSM2(cardKey) {
        return JSON.parse(localStorage.getItem(`sm2_${cardKey}`) || '{"interval":1,"ease":2.5,"due":0}');
    }

    // v9.26.0 : meta = { q, a } optionnel → persistance du contenu de la carte (rend le deck
    // rejouable + réactive les flashcards dans la recherche/export d'app.js). Signature
    // rétrocompatible (appel à 2 arguments toujours valide).
    function updateCardSM2(cardKey, score, meta) {
        const data = getCardSM2(cardKey);
        if (score < 3) {
            data.interval = 1;
        } else {
            data.interval = Math.round(data.interval * data.ease);
            data.ease = Math.max(1.3, data.ease + 0.1 - (5 - score) * 0.08);
        }
        data.due = Date.now() + data.interval * 86400000;
        if (meta && meta.q) { data.q = meta.q; data.a = meta.a || ''; }
        localStorage.setItem(`sm2_${cardKey}`, JSON.stringify(data));
        if (typeof window.checkAchievements === 'function') window.checkAchievements();
    }

    // v9.26.0 : deck des cartes arrivées à échéance (due <= maintenant), triées « plus en retard
    // d'abord ». Ne renvoie que les entrées disposant d'un contenu (q) — les entrées legacy sans
    // question sont ignorées (puis purgées au boot).
    function getDueCards() {
        const now = Date.now();
        const rows = [];
        Object.keys(localStorage).filter(k => k.startsWith('sm2_')).forEach(k => {
            try {
                const c = JSON.parse(localStorage.getItem(k));
                if (c && c.q && typeof c.due === 'number' && c.due > 0 && c.due <= now) {
                    rows.push({ q: c.q, a: c.a || '', due: c.due });
                }
            } catch (e) { /* entrée corrompue ignorée */ }
        });
        rows.sort((a, b) => a.due - b.due);
        return rows.map(({ q, a }) => ({ q, a }));
    }

    function showFlashcards(cards) {
        if (cards.length === 0) {
            alert("Pas assez de définitions claires trouvées pour générer des flashcards sur ce chapitre.");
            return;
        }
        const modal = document.getElementById('flashcardsModal');
        const container = document.getElementById('flashcardContent');
        const scoreArea = document.getElementById('flashScore');
        const answerInput = document.getElementById('flashUserAnswer');
        const counter = document.getElementById('flashCounter');
        const validateBtn = document.getElementById('flipFlash');
        const nextBtn = document.getElementById('nextFlash');
        const prevBtn = document.getElementById('prevFlash');
        modal.classList.remove('hidden');

        let cardIdx = 0;
        const results = {}; // cardIdx -> bool (réponse jugée correcte)

        // --- Auto-correction déterministe par mots-clés ---
        const FLASH_STOPWORDS = new Set(['dans', 'pour', 'avec', 'les', 'des', 'une', 'sur', 'par', 'que', 'qui', 'est', 'son', 'sa', 'ses', 'ce', 'cette', 'plus', 'sont', 'leur', 'leurs', 'etre', 'avoir', 'fait', 'faire', 'ont', 'pas', 'sans', 'sous', 'entre', 'vers', 'chez', 'dont', 'mais', 'donc', 'car', 'aux', 'comme', 'cela']);
        const normalize = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const keywordsOf = (txt) => [...new Set(normalize(txt).split(' ').filter(w => w.length >= 5 && !FLASH_STOPWORDS.has(w)))]
            .sort((a, b) => b.length - a.length).slice(0, 4);
        const grade = (userAns, expected) => {
            const kw = keywordsOf(expected);
            const userNorm = normalize(userAns);
            if (!kw.length) return { correct: userNorm.length > 2, hits: 0, total: 0 };
            const hits = kw.filter(k => userNorm.includes(k)).length;
            return { correct: hits / kw.length >= 0.5, hits, total: kw.length };
        };

        const renderCard = () => {
            document.querySelector('.flashcard')?.classList.remove('flipped');
            scoreArea.classList.add('hidden');
            scoreArea.innerHTML = '';
            answerInput.value = '';
            answerInput.disabled = false;
            answerInput.style.borderColor = '';
            answerInput.placeholder = 'Écrivez votre réponse puis cliquez « Valider »…';
            validateBtn.disabled = false;
            validateBtn.textContent = '✔ Valider';
            counter.textContent = `${cardIdx + 1} / ${cards.length}`;
            const c = cards[cardIdx];
            container.innerHTML = `
                <div class="flashcard">
                    <div class="front"><h4>❓ Question</h4><p>${c.q}</p></div>
                    <div class="back"><h4>✅ Réponse</h4><p>${c.a}</p></div>
                </div>`;
        };

        const showSessionBilan = () => {
            const vals = Object.values(results);
            const answered = vals.length;
            const correct = vals.filter(Boolean).length;
            const note = answered ? Math.round((correct / answered) * 20 * 10) / 10 : 0;
            const mention =
                note >= 16 ? '🏆 Excellent' :
                note >= 14 ? '👏 Très bien' :
                note >= 12 ? '✅ Bien' :
                note >= 10 ? '🙂 Passable' :
                             '📚 À retravailler';
            scoreArea.classList.add('hidden');
            scoreArea.innerHTML = '';
            answerInput.disabled = true;
            validateBtn.disabled = true;
            counter.textContent = `${cards.length} / ${cards.length}`;
            container.innerHTML = `
                <div style="text-align:center; padding:25px 15px;">
                    <div style="font-size:2.5rem; margin-bottom:10px;">${mention.split(' ')[0]}</div>
                    <h3 style="margin-bottom:8px;">Session terminée</h3>
                    <p style="font-size:2rem; font-weight:800; color:var(--accent); margin:10px 0;">${note}/20</p>
                    <p style="color:var(--text-secondary); margin-bottom:15px;">${mention.slice(mention.indexOf(' ') + 1)} · ${correct}/${answered} bonne(s) réponse(s)</p>
                </div>`;
            if (typeof window.pedagoRenderDailyPlan === 'function') window.pedagoRenderDailyPlan();
        };

        const validate = () => {
            const fc = document.querySelector('.flashcard');
            if (!fc || fc.classList.contains('flipped')) return;
            const c = cards[cardIdx];
            const { correct, hits, total } = grade(answerInput.value, c.a);
            results[cardIdx] = correct;
            // SM2 : bonne réponse → 5, mauvaise → 2 (répétition espacée automatique conservée).
            // v9.26.0 : clé stable par question + persistance q/a (deck dû rejouable).
            updateCardSM2(cardKey(c.q), correct ? 5 : 2, { q: c.q, a: c.a });
            fc.classList.add('flipped');
            answerInput.disabled = true;
            validateBtn.disabled = true;
            const detail = total > 0 ? ` (${hits}/${total} mots-clés)` : '';
            const isLast = cardIdx >= cards.length - 1;
            scoreArea.classList.remove('hidden');
            scoreArea.innerHTML = `
                <div style="flex:1; text-align:center; padding:8px 12px; border-radius:10px; font-weight:600; background:${correct ? 'rgba(16,185,129,0.15)' : 'rgba(244,63,94,0.15)'}; color:${correct ? '#10b981' : '#f43f5e'};">
                    ${correct ? '✅ Correct' : '❌ Incorrect'}${detail}
                </div>
                <button id="flashContinue" class="btn-nav" style="background:var(--accent); color:white; white-space:nowrap;">${isLast ? '🏁 Voir le score' : 'Suivante →'}</button>`;
            const cont = document.getElementById('flashContinue');
            if (cont) cont.onclick = () => { if (isLast) showSessionBilan(); else { cardIdx++; renderCard(); } };
        };

        renderCard();

        validateBtn.onclick = validate;
        nextBtn.onclick = () => {
            if (cardIdx < cards.length - 1) { cardIdx++; renderCard(); }
            else showSessionBilan();
        };
        prevBtn.onclick = () => { if (cardIdx > 0) { cardIdx--; renderCard(); } };
        document.getElementById('closeFlash').onclick = () => modal.classList.add('hidden');
        const closeFlashTop = document.getElementById('closeFlashTop');
        if (closeFlashTop) closeFlashTop.onclick = () => modal.classList.add('hidden');
        modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
    }

    // v9.24.0 : pré-synthèse NON BLOQUANTE de la phrase 1 à l'ouverture du chapitre.
    // Depuis v9.22.0 la synthèse Supertonic tourne dans un utilityProcess (worker) → hors
    // thread UI = zéro gel. On ne l'active donc QU'EN ELECTRON (présence du pont worker) ;
    // en PWA (flux WASM renderer) on s'abstient pour garder l'ouverture instantanée (cf v9.18.0).
    // Objectif : au 1er clic ▶, la phrase 1 est déjà en cache (hot-swap) → latence ~2,9 s (8 steps
    // HD) absorbée pendant que l'utilisateur parcourt le chapitre. Fire-and-forget : ne jamais
    // attendre, ne jamais bloquer l'ouverture. preSynthesize est no-op si la voix ≠ Supertonic.
    async function _preSynthFirstSentence(fullText) {
        try {
            if (!(window.electronAPI && typeof window.electronAPI.supertonicSynth === 'function')) return;
            if (!fullText || !fullText.trim()) return;
            const { segmentFrenchSentences } = await import('../tts/utils/sentence-segmenter.js');
            const sents = segmentFrenchSentences(fullText);
            const first = ((sents && sents[0]) ? sents[0] : fullText).trim();
            if (!first) return;
            const router = (await import('../tts/tts-router.js')).default;
            router.preSynthesize(first, 'reader'); // fire-and-forget, no-op si voix ≠ Supertonic
        } catch (e) {
            console.warn('[Reader] pré-synthèse phrase 1 échec (silencieux):', e?.message || e);
        }
    }

    function openSubModule(sub) {
        const _t0 = performance.now();
        // v7.0.7 : cleanup en entrée. Si on arrive ici alors qu'une lecture/pre-synth
        // d'un chapitre précédent tournait encore, on libère le main thread immédiatement.
        if (window.aiHelper && typeof window.aiHelper.stopReading === 'function') {
            window.aiHelper.stopReading();
        }
        try {
            import('../tts/tts-router.js').then(m => {
                const r = m && m.default;
                if (r && typeof r.hardStop === 'function') r.hardStop();
                else if (r && typeof r.stop === 'function') r.stop();
            }).catch(() => {});
        } catch (e) { /* ignore */ }

        if (typeof window.hideStatsView === 'function') window.hideStatsView();
        const bookViewer = document.getElementById('bookViewer');
        const readerContent = document.getElementById('readerContent');
        const readerTOC = document.getElementById('readerTOC');

        bookViewer.classList.remove('hidden');
        readerContent.innerHTML = '<div class="loading-shimmer">Chargement du contenu...</div>';
        document.getElementById('readerModuleName').textContent = sub.parentName || 'Module';
        document.getElementById('readerChapterName').textContent = sub.name;

        if (typeof window.markAsRead === 'function') window.markAsRead(sub.name);

        const promises = sub.files.map(file =>
            fetch(`./data/content/${encodeURIComponent(file.replace('.pdf', '.json'))}`)
                .then(r => r.json())
                .catch(() => ({ title: file, content: ["Contenu non disponible."], missing: true }))
        );

        Promise.all(promises).then(contents => {
            // v9.32.0 : démo web, data/content n'est pas publié (droits d'auteur). Un message clair
            // plutôt que N fois « Contenu non disponible. », et pas de boutons qui tournent à vide.
            const indisponible = contents.every(c => c.missing);
            ['toggleAudio', 'btnQuizIA', 'showFlashcards', 'toggleView'].forEach(id => {
                document.getElementById(id).disabled = indisponible;
            });
            // Les PDF d'origine n'existent que dans l'application installée.
            if (!window.electronAPI) document.getElementById('toggleView').disabled = true;
            if (indisponible) {
                readerTOC.innerHTML = '';
                readerContent.innerHTML = `
                    <div class="reader-section">
                        <div class="reader-section-meta">Chapitre non inclus</div>
                        <h2 class="reader-section-title">${sub.name}</h2>
                        <div class="reader-section-body">
                            <p>Les supports de cours appartiennent à leurs auteurs : ils ne sont pas publiés dans cette version.</p>
                            <p>Les quiz, l'examen blanc, les flashcards, le glossaire et les mises en situation restent disponibles depuis l'accueil.</p>
                        </div>
                    </div>`;
                return;
            }

            readerTOC.innerHTML = '<h4>Sommaire</h4>';
            contents.forEach((data, i) => {
                const tocItem = document.createElement('a');
                tocItem.className = 'toc-item';
                tocItem.href = `#section-${i}`;
                tocItem.innerHTML = `${data.title.replace('.pdf', '')}<span class="toc-badge">Document ${i + 1}/${contents.length}</span>`;
                tocItem.onclick = (e) => {
                    e.preventDefault();
                    document.getElementById(`section-${i}`).scrollIntoView({ behavior: 'smooth' });
                    readerTOC.classList.remove('is-open');
                    document.getElementById('readerTOCBackdrop').classList.remove('is-open');
                    document.getElementById('toggleTOC').setAttribute('aria-expanded', 'false');
                };
                readerTOC.appendChild(tocItem);
            });

            readerContent.innerHTML = '';
            contents.forEach((data, i) => {
                const section = document.createElement('div');
                section.className = 'reader-section';
                section.id = `section-${i}`;

                const sectionTexts = data.content.join('\n');
                const paragraphs = sectionTexts.split(/\n{2,}|\n(?=[A-ZÀÂÉÈÊËÏÎÔÙÛÜÇ])/)
                    .map(p => p.trim())
                    .filter(p => p.length > 0);

                section.innerHTML = `
                    <div class="reader-section-meta">Document ${i + 1} sur ${contents.length}</div>
                    <h2 class="reader-section-title">${data.title.replace('.pdf', '')}</h2>
                    <div class="reader-section-body">
                        ${paragraphs.map(p => `<p>${p.replace(/\n/g, ' ')}</p>`).join('')}
                    </div>
                `;
                readerContent.appendChild(section);
            });
            console.log(`[Chrono] ouverture chapitre « ${sub.name} » : ${Math.round(performance.now() - _t0)} ms`);

            if (typeof window.applyReaderTheme === 'function') {
                window.applyReaderTheme(localStorage.getItem('almanach_theme') || 'dark');
            }

            readerContent.onscroll = () => {
                const el = readerContent;
                const scrollPercent = (el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100;
                document.getElementById('readerProgressFill').style.width = `${scrollPercent}%`;

                localStorage.setItem(`reading_pos_${sub.name}`, el.scrollTop);

                const sections = el.querySelectorAll('.reader-section');
                let activeIdx = 0;
                sections.forEach((sec, idx) => {
                    if (sec.offsetTop - el.scrollTop < 200) activeIdx = idx;
                });
                readerTOC.querySelectorAll('.toc-item').forEach((item, idx) => {
                    item.classList.toggle('active', idx === activeIdx);
                });
            };

            const savedPos = localStorage.getItem(`reading_pos_${sub.name}`);
            if (savedPos) {
                setTimeout(() => { readerContent.scrollTop = parseInt(savedPos); }, 100);
            }

            const reflectionBlock = document.createElement('div');
            reflectionBlock.className = 'glass';
            reflectionBlock.style.cssText = 'margin-top: 40px; padding: 25px; border-radius: 16px; border: 1px solid var(--accent);';
            const savedReflection = localStorage.getItem(`reflection_${sub.name}`) || '';

            reflectionBlock.innerHTML = `
                <h3 style="color:var(--accent); margin-bottom:15px;">📓 Ma Réflexion Professionnelle</h3>
                <p style="font-size:0.9rem; color:var(--text-secondary); margin-bottom:20px;">
                    Prenez un moment pour réfléchir à la mise en œuvre de ces concepts dans votre pratique de CIP :
                </p>
                <div style="margin-bottom:15px;">
                    <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:8px;">1. Qu'est-ce qui me semble le plus complexe dans ce chapitre ?</label>
                    <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:8px;">2. Comment pourrais-je utiliser ces outils lors de mon prochain entretien ?</label>
                </div>
                <textarea id="reflectionText" class="glass"
                    style="width:100%; min-height:120px; padding:15px; border-radius:10px; color:var(--text-primary); font-family:inherit; font-size:0.95rem; resize:vertical; border:1px solid rgba(255,255,255,0.1);"
                    placeholder="Notez vos réflexions ici... Elles sont sauvegardées automatiquement.">${savedReflection}</textarea>
                <div style="margin-top:10px; text-align:right; font-size:0.75rem; opacity:0.5;" id="reflectionStatus">
                    ${savedReflection ? '✅ Dernière sauvegarde automatique' : ''}
                </div>
            `;
            readerContent.appendChild(reflectionBlock);

            const textarea = reflectionBlock.querySelector('#reflectionText');
            const status = reflectionBlock.querySelector('#reflectionStatus');
            textarea.oninput = () => {
                localStorage.setItem(`reflection_${sub.name}`, textarea.value);
                status.textContent = '⏳ Sauvegarde en cours...';
                clearTimeout(textarea.saveTimeout);
                textarea.saveTimeout = setTimeout(() => {
                    status.textContent = '✅ Sauvegarde effectuée';
                    if (typeof window.initSearchIndex === 'function') window.initSearchIndex();
                }, 1000);
            };

            let currentFontSize = parseFloat(localStorage.getItem('almanach_font_size_px') || '18');
            const applyFontSize = () => {
                readerContent.querySelectorAll('.reader-section-body').forEach(el => {
                    el.style.fontSize = currentFontSize + 'px';
                });
            };
            applyFontSize();

            const speedSelect = document.getElementById('readerTtsSpeed');
            const savedSpeed = localStorage.getItem('almanach_tts_rate') || '0.95';
            speedSelect.value = savedSpeed;
            speedSelect.onchange = (e) => {
                const val = e.target.value;
                localStorage.setItem('almanach_tts_rate', val);
                // v7.0.8 : aiHelper.currentAudio is null pour Supertonic/Voxtral/Piper (router-owned).
                // Délégué au router qui sait quel <audio> est actif.
                import('../tts/tts-router.js').then(m => {
                    const r = m && m.default;
                    if (r && typeof r.setPlaybackRate === 'function') r.setPlaybackRate(val);
                }).catch(() => {});
                // Web Speech : pas de changement live possible, mais utterance.rate sera lu à
                // la prochaine phrase via localStorage.almanach_tts_rate (déjà en place).
            };

            document.getElementById('readerFontPlus').onclick = () => {
                currentFontSize = Math.min(currentFontSize + 2, 28);
                localStorage.setItem('almanach_font_size_px', currentFontSize);
                applyFontSize();
            };
            document.getElementById('readerFontMinus').onclick = () => {
                currentFontSize = Math.max(currentFontSize - 2, 12);
                localStorage.setItem('almanach_font_size_px', currentFontSize);
                applyFontSize();
            };

            const fullText = contents.map(c => c.content.join(' ')).join(' ');
            // v9.18.0 : plus de pré-synthèse à l'ouverture (elle figeait l'UI ~11 s sur
            // WASM mono-thread, cf [Chrono pré-warm lecture] v9.17.0). On ne fait
            // qu'initialiser le router et stopper l'audio du chapitre précédent →
            // ouverture toujours instantanée. Le gel unique de la 1ʳᵉ synthèse de session
            // est payé au 1er clic ▶ (indicateur « ⏳ Préparation de la voix… »).
            if (window.aiHelper && typeof window.aiHelper.resetReaderAudio === 'function') {
                // v9.24.0 : pré-synthèse phrase 1 CHAÎNÉE après resetReaderAudio — celui-ci
                // appelle hardStop() (purge pending + activePreSynthesizes + pré-fetch), donc
                // démarrer la pré-synthèse avant lui la tuerait. Non bloquant pour l'ouverture.
                Promise.resolve(window.aiHelper.resetReaderAudio())
                    .finally(() => _preSynthFirstSentence(fullText));
            } else {
                _preSynthFirstSentence(fullText);
            }
            document.getElementById('toggleAudio').onclick = () => {
                if (window.aiHelper) window.aiHelper.speak(fullText);
            };

            document.getElementById('toggleView').onclick = () => {
                const hasIframe = readerContent.querySelector('iframe');
                if (hasIframe) {
                    openSubModule(sub);
                } else {
                    const pdfPath = `./${encodeURIComponent(sub.parentName)}/${encodeURIComponent(sub.name)}/${encodeURIComponent(sub.files[0])}`;
                    readerContent.innerHTML = `<iframe src="${pdfPath}" style="width:100%; height:100%; border:none; border-radius:10px;"></iframe>`;
                }
            };

            document.getElementById('showFlashcards').onclick = async () => {
                const btn = document.getElementById('showFlashcards');
                const originalText = btn.innerText;
                btn.innerText = "⏳ Analyse...";
                btn.disabled = true;

                try {
                    const cards = window.aiHelper.extractFlashcards(contents.flatMap(c => c.content));
                    showFlashcards(cards);
                } finally {
                    btn.innerText = originalText;
                    btn.disabled = false;
                }
            };

            document.getElementById('btnQuizIA').onclick = async () => {
                const fullText = contents.flatMap(c => c.content).join('\n').substring(0, 4000);
                if (typeof window.runGeneratedQuiz === 'function') {
                    await window.runGeneratedQuiz(sub.name, fullText);
                }
            };
        });
    }

    // Exposition globale (rétrocompat des call-sites dans app.js).
    window.openSubModule = openSubModule;
    window.showFlashcards = showFlashcards;
    window.getCardSM2 = getCardSM2;
    window.updateCardSM2 = updateCardSM2;
    window.getDueCards = getDueCards;
    window.cardKey = cardKey;

    // Namespace optionnel.
    window.Almanach = window.Almanach || {};
    window.Almanach.reader = {
        open: openSubModule,
        showFlashcards,
        sm2: { get: getCardSM2, update: updateCardSM2 },
    };

    // v9.26.0 : purge des entrées SM2 legacy `sm2_flash_<n>` (clé par index de session, sans
    // contenu) — orphelines depuis le passage à la clé stable par question. Idempotent.
    try {
        Object.keys(localStorage)
            .filter(k => /^sm2_flash_\d+$/.test(k))
            .forEach(k => localStorage.removeItem(k));
    } catch (e) { /* stockage indisponible : sans effet */ }
})();
