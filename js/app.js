document.addEventListener('DOMContentLoaded', () => {
    // === Filet d'erreurs global (v6.8.3) ===
    // v9.29.0 : boîte noire locale — chaque erreur captée est AUSSI persistée en
    // JSONL sur disque via IPC (Electron only, best-effort, dédupliquée, plafond
    // 30 écritures/session). En mode portable le journal suit la clé USB.
    window._techEvents = [];
    const _loggedMsgs = new Set();
    window.logTechEvent = function (type, msg, src) {
        try {
            const entry = { type, msg: String(msg).slice(0, 500), src: String(src || '').slice(0, 200), t: new Date().toISOString() };
            window._techEvents.push(entry);
            if (window._techEvents.length > 30) window._techEvents.shift();
            if (type !== 'boot') {
                if (_loggedMsgs.has(entry.msg) || _loggedMsgs.size >= 30) return;
                _loggedMsgs.add(entry.msg);
            }
            if (window.electronAPI && typeof window.electronAPI.logEvent === 'function') {
                window.electronAPI.logEvent({ type: entry.type, msg: entry.msg, src: entry.src, build: window.CIP_BUILD || '?' }).catch(() => {});
            }
        } catch (_) { /* la boîte noire ne doit jamais casser l'app */ }
    };
    window.addEventListener('error', (e) => {
        console.error('[window.error]', e.error || e.message, e);
        if (typeof showErrorToast === 'function') {
            showErrorToast(`Erreur JS : ${e.message} @ ${e.filename || '?'}:${e.lineno || '?'}`);
        }
        window.logTechEvent('error', e.message, `${e.filename || '?'}:${e.lineno || '?'}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
        console.error('[unhandledrejection]', e.reason);
        if (typeof showErrorToast === 'function') {
            showErrorToast(`Promesse rejetée : ${e.reason?.message || e.reason}`);
        }
        window.logTechEvent('rejection', e.reason?.message || e.reason, '');
    });

    // Affichage version pour debug rapide (inspectable via DevTools)
    window.CIP_BUILD = 'v9.32.1';
    console.log('%c[L\'Almanach du CIP] %cBuild ' + window.CIP_BUILD,
        'color:#6366f1; font-weight:bold;', 'color:#94a3b8;');

    // v7.3.2 : exposition précoce de getCCPProgress pour que stats-view (chargé avant app.js)
    // y ait accès au moment où updateOverallProgress() est appelé en boot (ligne ~287).
    // S'appuie sur le hoisting de la function declaration déclarée plus bas dans cette IIFE.
    window.getCCPProgress = getCCPProgress;

    // v9.20.2 : purge des clés localStorage du « Piper Voice Manager » legacy (UI morte supprimée —
    // downloadVoice simulait un téléchargement et posait voice_cached_* sans rien télécharger).
    try {
        Object.keys(localStorage)
            .filter(k => k.startsWith('voice_cached_'))
            .forEach(k => localStorage.removeItem(k));
        localStorage.removeItem('almanach_piper_voice');
    } catch (e) { /* stockage indisponible : sans conséquence */ }

    const moduleNav = document.getElementById('moduleNav');
    const contentGrid = document.getElementById('contentGrid');
    const currentModuleName = document.getElementById('currentModuleName');
    const currentModuleSubtitle = document.getElementById('currentModuleSubtitle');
    const searchInput = document.getElementById('searchInput');
    const ccpFilterBar = document.getElementById('ccpFilterBar');
    const progressBarFill = document.querySelector('.progress-bar-fill');
    const progressPercent = document.querySelector('.percent');

    // --- Éléments Globaux (Modales, listes, etc.) ---
    const labModal = document.getElementById('labModal');
    const scenarioList = document.getElementById('scenarioList');
    const scenarioView = document.getElementById('scenarioView');
    const labWelcome = document.getElementById('labWelcome');
    const helpModal = document.getElementById('helpModal');
    const systemModal = document.getElementById('systemModal');
    const favoritesModal = document.getElementById('favoritesModal');
    const settingsModal = document.getElementById('settingsModal');
    const glossaireModal = document.getElementById('glossaireModal');
    const examModal = document.getElementById('examModal');

    // Service Worker Registration
    // v9.6.7 : on saute l'enregistrement sous file:// (Electron). Un SW ne peut pas mettre
    // en cache des URLs file:// → `cache.addAll` rejette systématiquement à chaque bump de
    // CACHE_NAME (« Request scheme 'file' is unsupported »), le SW ne s'active jamais et
    // Electron sert de toute façon les fichiers directement du disque. Le SW reste pleinement
    // utile en PWA/web (http/https) où le cache offline a un sens.
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('SW Registered!', reg))
                .catch(err => console.error('SW Registration Failed!', err));
        });
    } else if ('serviceWorker' in navigator && location.protocol === 'file:') {
        // v9.6.7 : sous file:// (Electron), on désenregistre activement tout SW résiduel
        // (resté en état « installing » après un ancien bump de cache) pour une console propre.
        navigator.serviceWorker.getRegistrations()
            .then(regs => regs.forEach(r => r.unregister().then(ok => {
                if (ok) console.log('[SW] résidu file:// désenregistré');
            })))
            .catch(() => { /* ignore */ });
    }

    const THEME_MAP = {
        "metier": [1, 3, 20],
        "accompagnement": [15, 17, 5, 2, 18, 0, 16],
        "pedagogie": [4, 6, 7, 8, 10, 13],
        "entreprise": [19, 14, 12],
        "technique": [11, 21, 22]
    };

    function getModuleKey(modName) {
        if (modName === 'Programme') return 'prog';
        const num = modName.match(/\d+/)?.[0];
        if (!num) return 'prog';
        return num;
    }
    window.getModuleKey = getModuleKey;

    function getModuleTheme(modName) {
        const num = parseInt(modName.match(/\d+/));
        for (const [theme, modules] of Object.entries(THEME_MAP)) {
            if (modules.includes(num)) return theme;
        }
        return "technique";
    }
    window.getModuleTheme = getModuleTheme;

    let courseData = null;
    let searchIndex = null;

    // === HELPERS DIAGNOSTIC (v6.8.3) ===
    /**
     * Affiche un toast rouge dans le coin haut-droit avec un message d'erreur.
     * Utilisé par safeWire pour rendre les erreurs runtime visibles à l'utilisateur.
     */
    function showErrorToast(msg, autoHideMs = 5000) {
        let toast = document.getElementById('errorToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'errorToast';
            toast.style.cssText = `
                position: fixed; top: 20px; right: 20px;
                background: rgba(244,63,94,0.95); color: white;
                padding: 12px 18px; border-radius: 10px;
                font-size: 0.85rem; z-index: 100000;
                box-shadow: 0 8px 24px rgba(244,63,94,0.4);
                max-width: 420px; white-space: pre-wrap;
                cursor: pointer;
            `;
            toast.onclick = () => toast.remove();
            document.body.appendChild(toast);
        }
        toast.textContent = '⚠️ ' + msg + '  (clique pour fermer)';
        if (autoHideMs > 0) {
            clearTimeout(toast._t);
            toast._t = setTimeout(() => { if (toast.parentNode) toast.remove(); }, autoHideMs);
        }
    }
    // v9.19.3 : exposé sur window pour que le TTS Router (module ES) puisse notifier l'UI
    // (cas zéro voix FR). Réactive aussi les toasts de secours engine déjà câblés (l.~1948).
    window.showErrorToast = showErrorToast;

    /**
     * Affiche un toast vert de confirmation.
     */
    function showSuccessToast(msg, autoHideMs = 3000) {
        let toast = document.getElementById('successToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'successToast';
            toast.style.cssText = `
                position: fixed; top: 20px; right: 20px;
                background: rgba(16,185,129,0.95); color: white;
                padding: 12px 18px; border-radius: 10px;
                font-size: 0.85rem; z-index: 100000;
                box-shadow: 0 8px 24px rgba(16,185,129,0.4);
                max-width: 420px; cursor: pointer;
            `;
            toast.onclick = () => toast.remove();
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        if (autoHideMs > 0) {
            clearTimeout(toast._t);
            toast._t = setTimeout(() => { if (toast.parentNode) toast.remove(); }, autoHideMs);
        }
    }
    window.showSuccessToast = showSuccessToast;

    /**
     * v6.9.7 : convertit du Markdown utilisateur en HTML sanitisé.
     * Retire <script>, <iframe>, <object>, <embed>, <style>, <link>, <meta>,
     * tous les attributs `on*`, et toute valeur d'attribut commençant par `javascript:`.
     * Utilisé pour les notes que l'utilisateur peut importer via JSON.
     */
    function safeMarkdownToHtml(text) {
        if (!text) return '';
        const html = window.marked ? window.marked.parse(text) : String(text);
        let doc;
        try {
            doc = new DOMParser().parseFromString(html, 'text/html');
        } catch (e) {
            return String(text);
        }
        doc.querySelectorAll('script,iframe,object,embed,style,link,meta,base').forEach(el => el.remove());
        doc.querySelectorAll('*').forEach(el => {
            [...el.attributes].forEach(attr => {
                const name = attr.name.toLowerCase();
                const value = (attr.value || '').trim().toLowerCase();
                if (name.startsWith('on') || value.startsWith('javascript:') || value.startsWith('data:text/html')) {
                    el.removeAttribute(attr.name);
                }
            });
        });
        return doc.body.innerHTML;
    }
    window.safeMarkdownToHtml = safeMarkdownToHtml;

    /**
     * Câble un handler onclick en sécurité :
     * - Si l'élément n'existe pas : log + toast.
     * - Si le handler throw : log + toast avec message + stack.
     * Retourne true si câblé, false sinon.
     */
    function safeWire(elementId, handler, label = null) {
        const el = document.getElementById(elementId);
        if (!el) {
            const msg = `Élément introuvable : #${elementId} (${label || 'sans label'})`;
            console.error('[safeWire FAIL]', msg);
            showErrorToast(msg);
            return false;
        }
        console.log(`[safeWire OK] #${elementId}` + (label ? ` (${label})` : ''));
        el.onclick = async (e) => {
            console.log(`[click] #${elementId}` + (label ? ` (${label})` : ''));
            try {
                await handler(e);
            } catch (err) {
                console.error(`[safeWire] Erreur dans handler de #${elementId}:`, err);
                showErrorToast(`Erreur sur #${elementId} : ${err.message || err}`);
                window.logTechEvent('handler', err.message || String(err), '#' + elementId);
            }
        };
        return true;
    }

    // === CABLAGE PRIORITAIRE TOP-BAR (v6.8.6) ===
    // On câble ces boutons en priorité absolue pour qu'ils soient fonctionnels même si l'init crashe plus loin.
    safeWire('btnHistory', () => {
        const modal = document.getElementById('historyModal');
        if (!modal) throw new Error('historyModal introuvable');
        modal.classList.remove('hidden');
        if (typeof window.renderHistory === 'function') window.renderHistory();
    }, 'Historique');

    safeWire('btnBadges', () => {
        const modal = document.getElementById('badgesModal');
        const list = document.getElementById('badgesList');
        if (!modal) throw new Error('badgesModal introuvable');
        if (!list) throw new Error('badgesList introuvable');
        if (typeof ACHIEVEMENTS === 'undefined') throw new Error('ACHIEVEMENTS non défini');
        const unlocked = JSON.parse(localStorage.getItem('almanach_achievements') || '[]');
        list.innerHTML = ACHIEVEMENTS.map(a => {
            const isUnlocked = unlocked.includes(a.id);
            return `<div class="badge-item ${isUnlocked ? 'unlocked' : ''}"><span class="badge-icon">${isUnlocked ? a.icon : '🔒'}</span><span class="badge-name">${a.name}</span><span class="badge-desc">${a.desc}</span></div>`;
        }).join('');
        modal.classList.remove('hidden');
    }, 'Badges');

    safeWire('btnFavorites', () => {
        const modal = document.getElementById('favoritesModal');
        if (!modal) throw new Error('favoritesModal introuvable');
        modal.classList.remove('hidden');
        if (typeof renderFavorites === 'function') renderFavorites();
    }, 'Favoris');

    safeWire('btnSettings', () => {
        const modal = document.getElementById('settingsModal');
        if (!modal) throw new Error('settingsModal introuvable');
        modal.classList.remove('hidden');
    }, 'Réglages');

    safeWire('btnGlossaire', () => {
        const modal = document.getElementById('glossaireModal');
        if (!modal) throw new Error('glossaireModal introuvable');
        modal.classList.remove('hidden');
        if (typeof renderGlossaire === 'function') renderGlossaire('');
    }, 'Glossaire');

    safeWire('btnSystem', () => {
        const modal = document.getElementById('systemModal');
        if (!modal) throw new Error('systemModal introuvable');
        modal.classList.remove('hidden');
        if (typeof updateSystemInfo === 'function') updateSystemInfo();
    }, 'Système');

    safeWire('btnExamMode', () => {
        const modal = document.getElementById('examModal');
        if (!modal) throw new Error('examModal introuvable');
        modal.classList.remove('hidden');
        if (typeof renderExamMode === 'function') renderExamMode();
        if (typeof renderExamLauncher === 'function') renderExamLauncher();
    }, 'Examen');

    safeWire('btnQuizGlobal', () => {
        if (typeof window.runGlobalQuiz !== 'function') throw new Error('runGlobalQuiz non défini');
        return window.runGlobalQuiz();
    }, 'Quiz général');

    safeWire('btnHelp', () => {
        const modal = document.getElementById('helpModal');
        if (!modal) throw new Error('helpModal introuvable');
        modal.classList.remove('hidden');
    }, 'Aide');

    // v9.29.0 : diagnostic copiable depuis État Système (à coller dans un mail/chat).
    safeWire('btnCopyDiag', async () => {
        let hwLine = '';
        try {
            if (window.electronAPI && window.electronAPI.getHardwareInfo) {
                const hw = await window.electronAPI.getHardwareInfo();
                hwLine = `${hw.os || '?'} (${hw.arch || '?'}) — RAM libre ${hw.memFreeGB ?? '?'}/${hw.memTotalGB ?? '?'} Go`;
            }
        } catch (_) {}
        const lines = [
            '--- DIAGNOSTIC ALMANACH DU CIP ---',
            'Build : ' + (window.CIP_BUILD || '?'),
            'Date : ' + new Date().toLocaleString('fr-FR'),
            'Machine : ' + (hwLine || navigator.userAgent),
            'IA installée (flag) : ' + (localStorage.getItem('almanach_ai_installed') === 'true'),
            '',
            'Derniers événements techniques (' + (window._techEvents || []).length + ') :',
            ...(window._techEvents || []).slice(-10).map(ev => `[${new Date(ev.t).toLocaleString('fr-FR')}] ${ev.type} — ${ev.msg}${ev.src ? ' @ ' + ev.src : ''}`)
        ];
        await navigator.clipboard.writeText(lines.join('\n'));
        showSuccessToast('Diagnostic copié dans le presse-papier.');
    }, 'copier diagnostic');

    safeWire('btnReport', () => {
        const modal = document.getElementById('reportModal');
        if (!modal) throw new Error('reportModal introuvable');
        modal.classList.remove('hidden');
    }, 'Signaler');

    safeWire('btnLab', () => {
        const modal = document.getElementById('labModal');
        if (!modal) throw new Error('labModal introuvable');
        modal.classList.remove('hidden');
        if (typeof loadScenarios === 'function') loadScenarios();
    }, 'Simulation');

    // Fermetures standard (modales top-bar)
    const closeMapping = {
        'closeHistory': 'historyModal',
        'closeBadges': 'badgesModal',
        'closeFavorites': 'favoritesModal',
        'closeSettings': 'settingsModal',
        'closeGlossaire': 'glossaireModal',
        'closeSystem': 'systemModal',
        'closeSystemTop': 'systemModal',
        'closeExam': 'examModal',
        'closeHelp': 'helpModal',
        'closeHelpTop': 'helpModal',
        'closeReportTop': 'reportModal',
        'closeLab': 'labModal'
    };
    Object.entries(closeMapping).forEach(([btnId, modalId]) => {
        const btn = document.getElementById(btnId);
        if (btn) btn.onclick = () => document.getElementById(modalId).classList.add('hidden');
    });

    // v9.21.0 : signalement de souci enregistré sur disque (plus d'email). En Electron,
    // append JSONL dans Documents/Almanach-CIP/signalements.jsonl via l'IPC save-report.
    // En PWA (pas d'accès disque), repli sur le téléchargement d'un fichier .txt daté.
    safeWire('reportSend', async () => {
        const subjEl = document.getElementById('reportSubject');
        const bodyEl = document.getElementById('reportBody');
        const subject = (subjEl?.value || '').trim();
        const desc = (bodyEl?.value || '').trim();
        if (!desc) { showErrorToast('Décris le souci avant d\'enregistrer.'); return; }
        const ver = (window.CIP_BUILD || '?');
        const report = {
            ver,
            platform: navigator.platform || '?',
            ua: navigator.userAgent || '?',
            subject,
            desc,
            diag: JSON.stringify((window._techEvents || []).slice(-10))
        };
        if (window.electronAPI && typeof window.electronAPI.saveReport === 'function') {
            const res = await window.electronAPI.saveReport(report);
            if (res && res.ok) {
                alert('✅ Signalement enregistré dans :\n' + res.path);
            } else {
                showErrorToast('Échec de l\'enregistrement : ' + ((res && res.error) || 'inconnu'));
                return;
            }
        } else {
            // PWA : pas d'accès disque direct → téléchargement d'un fichier texte daté.
            const meta = [
                '--- SIGNALEMENT ALMANACH DU CIP ---',
                'Version : ' + ver,
                'Date : ' + new Date().toLocaleString('fr-FR'),
                'Plateforme : ' + report.platform,
                'Navigateur : ' + report.ua,
                '------------------------------------',
                'Sujet : ' + (subject || '(non précisé)'),
                '',
                'Description :',
                desc,
                '',
                'Diagnostic (10 derniers événements) :',
                report.diag
            ].join('\n');
            const blob = new Blob([meta], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'signalement-almanach-' + Date.now() + '.txt';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }
        document.getElementById('reportModal')?.classList.add('hidden');
        if (subjEl) subjEl.value = '';
        if (bodyEl) bodyEl.value = '';
    }, 'Envoi signalement');

    // v6.9.8 : ACHIEVEMENTS + checkAchievements + showAchievementToast déplacés vers js/modules/achievements.js
    // (exposés sur window.* pour rétrocompat des call-sites ci-dessous).

    // Use Local Data Constant
    if (typeof COURSE_DATA !== 'undefined') {
        courseData = COURSE_DATA;
        renderNavigation(courseData.modules);
        updateOverallProgress();
        initSearchIndex();
        updateStreak();
        checkAchievements();
        if (typeof renderDashboardStats === 'function') renderDashboardStats();
    } else {
        console.error('COURSE_DATA not found. Make sure data.js is loaded.');
    }

    function updateStreak() {
        const today = new Date().toDateString();
        const lastVisit = localStorage.getItem('almanach_last_visit');
        let streak = parseInt(localStorage.getItem('almanach_streak') || '0');

        if (lastVisit === today) {
            // Déjà visité aujourd'hui
        } else if (lastVisit === new Date(Date.now() - 86400000).toDateString()) {
            streak++;
            localStorage.setItem('almanach_streak', streak);
            if (typeof checkAchievements === 'function') checkAchievements();
        } else if (!lastVisit) {
            streak = 1;
            localStorage.setItem('almanach_streak', 1);
            if (typeof checkAchievements === 'function') checkAchievements();
        } else {
            streak = 1; // streak cassé
            localStorage.setItem('almanach_streak', streak);
        }
        localStorage.setItem('almanach_last_visit', today);

        if (streak >= 2) {
            const hero = document.querySelector('.hero-text p') || document.getElementById('currentModuleSubtitle');
            const badge = document.createElement('span');
            badge.style.cssText = 'margin-left: 10px; font-size: 0.85rem; background: rgba(245,158,11,0.2); padding: 3px 10px; border-radius: 20px; color: #f59e0b;';
            badge.textContent = `🔥 ${streak} jours de suite`;
            hero.appendChild(badge);
        }
    }

    // Search Functionality
    // v8.8.0 : debounce 200 ms — l'index MiniSearch compte ~650 docs, chercher à
    // chaque frappe gelait la saisie. Le reset (champ vidé) reste immédiat.
    let searchDebounceTimer = null;
    let currentCcpFilter = '';   // '' = tout ; sinon 'ccp1'|'ccp2'|'ccp3'|'transversal'
    let lastSearchQuery = '';
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        const query = e.target.value.toLowerCase().trim();
        if (query.length > 2) {
            searchDebounceTimer = setTimeout(() => performSearch(query), 200);
        } else if (query.length === 0) {
            contentGrid.innerHTML = '<div class="welcome-message"><h3>Prêt pour une session d\'étude ?</h3><p>Naviguez dans les pôles de compétences pour accéder à vos guides et ressources CIP.</p></div>';
            currentModuleName.innerText = "Bienvenue dans votre Almanach";
            lastSearchQuery = '';
            if (ccpFilterBar) ccpFilterBar.classList.add('hidden');
        }
    });

    // v9.13.0 : filtre CCP des résultats de recherche (chips au-dessus de la grille).
    document.querySelectorAll('.ccp-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            currentCcpFilter = chip.dataset.room || '';
            document.querySelectorAll('.ccp-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            if (lastSearchQuery) performSearch(lastSearchQuery);
        });
    });

    window.initSearchIndex = () => initSearchIndex();
    function initSearchIndex() {
        if (!window.MiniSearch) return;

        // v8.7.1 : stopwords FR filtrés au tokenizing MiniSearch (voir processTerm ci-dessous).
        // 'qu' inclus pour neutraliser « qu'est-ce ». Volontairement PAS de filtre de longueur
        // (on préserve les acronymes courts du domaine : cv, rh, iod, fse, moa, gepp…).
        const SEARCH_STOPWORDS = new Set([
            'le','la','les','un','une','des','de','du','d','l','au','aux',
            'et','ou','mais','donc','car','ni','or',
            'que','qui','quoi','quel','quelle','quels','quelles','où','qu',
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

        searchIndex = new window.MiniSearch({
            // v7.4.3 : ajout du champ 'content' pour permettre au RAG de matcher
            // sur le texte des chapitres, pas seulement sur les titres.
            fields: ['title', 'module', 'type', 'content'],
            storeFields: ['title', 'module', 'type', 'item', 'content', 'isFile', 'isNote', 'isGlossaire', 'isFlash', 'isVault', 'room'],
            // v8.7.1 : appliqué à l'indexation ET à la requête. Minuscule + retrait des accents
            // (matching tolérant, aligné sur _extractQueryKeywords) + drop des stopwords FR.
            // Neutralise la pollution des titres FAQ interrogatifs (« qu'est-ce », « comment »).
            processTerm: (term) => {
                const t = term.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
                return SEARCH_STOPWORDS.has(t) ? null : t;
            },
            searchOptions: {
                // v7.5.0 : boost titre 2→8 pour aligner le ranking sur l'intention sémantique
                // de la query (le titre est un meilleur proxy du sujet que le matching de tokens
                // dispersés dans le contenu). Fuzzy 0.2→0.15 pour réduire le bruit.
                boost: { title: 8, content: 1 },
                fuzzy: 0.15,
                prefix: true
            }
        });

        // v9.12.0 : taxonomie "room" dérivée de COURSE_DATA (champ ccp des modules).
        // Map nom-de-fichier-de-contenu (sans extension) -> room, pour étiqueter les 596
        // chapitres rag-index (qui ne portent pas leur CCP).
        const ccpToRoom = (ccp) => {
            const c = String(ccp || '').toLowerCase();
            if (c.startsWith('ccp 1')) return 'ccp1';
            if (c.startsWith('ccp 2')) return 'ccp2';
            if (c.startsWith('ccp 3')) return 'ccp3';
            return 'transversal';
        };
        const baseFileName = (f) => String(f).replace(/\.(pdf|json)$/i, '');
        const fileRoomMap = new Map();
        (courseData.modules || []).forEach(mod => {
            const room = ccpToRoom(mod.ccp);
            (mod.files || []).forEach(f => fileRoomMap.set(baseFileName(f), room));
            (mod.sub_modules || []).forEach(sub => {
                (sub.files || []).forEach(f => fileRoomMap.set(baseFileName(f), room));
            });
        });

        const documents = [];
        courseData.modules.forEach(mod => {
            if (mod.sub_modules) {
                mod.sub_modules.forEach(sub => {
                    documents.push({
                        id: `sub-${mod.name}-${sub.name}`,
                        title: sub.name,
                        module: mod.name,
                        type: 'CHAPITRE',
                        room: ccpToRoom(mod.ccp),
                        item: { ...sub, parentName: mod.name } // parentName toujours défini
                    });
                });
            }
            if (mod.files) {
                mod.files.forEach(file => {
                    documents.push({
                        id: `file-${mod.name}-${file}`,
                        title: file.replace('.pdf', ''),
                        module: mod.name,
                        type: 'DOCUMENT',
                        room: ccpToRoom(mod.ccp),
                        item: file,
                        isFile: true
                    });
                });
            }
        });

        // Notes utilisateur
        Object.keys(localStorage)
            .filter(k => k.startsWith('note_') || k.startsWith('reflection_'))
            .forEach(k => {
                const noteText = localStorage.getItem(k);
                if (!noteText || noteText.trim().length === 0) return;
                const subjectKey = k.replace('note_', '').replace('reflection_', '');
                documents.push({
                    id: `note-${k}`,
                    title: subjectKey,
                    module: noteText.substring(0, 200),
                    type: 'NOTE',
                    room: 'notes-perso',
                    item: { key: subjectKey, text: noteText },
                    isNote: true
                });
            });

        // Glossaire (si chargé)
        if (window.glossaireData && Array.isArray(window.glossaireData)) {
            window.glossaireData.forEach((g, idx) => {
                documents.push({
                    id: `gloss-${idx}`,
                    title: g.terme,
                    module: g.def,
                    type: 'GLOSSAIRE',
                    room: 'glossaire',
                    item: g,
                    isGlossaire: true
                });
            });
        }

        // Flashcards SM2 (deck utilisateur)
        Object.keys(localStorage)
            .filter(k => k.startsWith('sm2_'))
            .forEach(k => {
                try {
                    const card = JSON.parse(localStorage.getItem(k));
                    if (!card || !card.q) return;
                    documents.push({
                        id: `flash-${k}`,
                        title: card.q,
                        module: card.a || '',
                        type: 'FLASHCARD',
                        room: 'flashcards',
                        item: card,
                        isFlash: true
                    });
                } catch { /* ignore corrupted entries */ }
            });

        searchIndex.addAll(documents);
        window.appSearchIndex = searchIndex;

        // v7.4.3 : enrichissement asynchrone de l'index avec le contenu des cours
        // pré-agrégé par scripts/build-rag-index.js → data/rag-index.json.
        // Sans cette étape, MiniSearch ne matche que sur les titres et le RAG retourne vide.
        window.appRagIndexReady = (async () => {
            try {
                const resp = await fetch('./data/rag-index.json');
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const ragDocs = await resp.json();
                if (!Array.isArray(ragDocs) || ragDocs.length === 0) {
                    console.warn('[RAG] rag-index.json vide ou mal formé');
                    return;
                }
                const enriched = ragDocs.map(d => ({
                    id: 'content-' + d.file,
                    title: d.title,
                    module: '',
                    type: 'CONTENT_CHUNK',
                    room: fileRoomMap.get(baseFileName(d.file)) || 'autre',
                    content: d.content_text,
                    item: d.file,
                    isFile: true
                }));
                // v8.2.1 : indexation par lots avec cession du thread (await setTimeout 0) entre
                // chaque lot. MiniSearch.addAll() est synchrone et bloquant ; indexer 596 chapitres
                // pleins d'un coup gelait l'UI au boot (window ghosting Windows pendant la frappe).
                // Le découpage garde la fenêtre réactive.
                const RAG_BATCH = 50;
                for (let i = 0; i < enriched.length; i += RAG_BATCH) {
                    searchIndex.addAll(enriched.slice(i, i + RAG_BATCH));
                    await new Promise(r => setTimeout(r, 0));
                }
                console.log('[RAG] index enrichi avec', enriched.length, 'chapitres (contenu plein, par lots)');
            } catch (e) {
                console.warn('[RAG] échec du chargement de rag-index.json :', e.message);
            }
        })();

        // v7.7.0 : enrichissement async de l'index avec le vault auto-extrait
        // (RNCP_REFERENTIEL + CIP_GLOSSAIRE) pré-agrégé par scripts/build-vault-index.js.
        // Le vault contient des fiches synthèses fidèles au référentiel officiel,
        // boostées dans le re-ranker (cf ai-helper.js buildRagContext) pour dominer
        // le contexte injecté quand une fiche matche la query.
        window.appVaultIndexReady = (async () => {
            try {
                const resp = await fetch('./data/vault-index.json');
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const vaultDocs = await resp.json();
                if (!Array.isArray(vaultDocs) || vaultDocs.length === 0) {
                    console.warn('[VAULT] vault-index.json vide ou mal formé');
                    return;
                }
                const enriched = vaultDocs.map(d => ({
                    id: d.id || ('vault-' + Math.random().toString(36).slice(2, 9)),
                    title: d.title,
                    module: d.category || 'vault',
                    type: 'VAULT',
                    room: d.category === 'user-note' ? 'notes-perso' : 'referentiel',
                    content: d.content,
                    item: d.id,
                    isVault: true,
                }));
                searchIndex.addAll(enriched);
                console.log('[VAULT] index enrichi avec', enriched.length, 'fiches vault');
            } catch (e) {
                console.warn('[VAULT] échec du chargement de vault-index.json :', e.message);
            }
        })();


    }

    // Le chapitre qui contient ce fichier de cours, quelle que soit son extension (.pdf ou .json).
    function chapitreDuFichier(file) {
        const base = String(file).replace(/\.(pdf|json)$/i, '');
        for (const mod of courseData.modules || []) {
            for (const sub of mod.sub_modules || []) {
                if ((sub.files || []).some(f => f.replace(/\.(pdf|json)$/i, '') === base)) {
                    return { ...sub, parentName: mod.name };
                }
            }
        }
        return null;
    }

    function performSearch(query) {
        lastSearchQuery = query;
        contentGrid.innerHTML = '';
        currentModuleName.innerText = `Résultats pour "${query}"`;
        currentModuleSubtitle.innerText = "Recherche intelligente (MiniSearch)";
        if (ccpFilterBar) ccpFilterBar.classList.remove('hidden');

        if (!searchIndex) {
            console.warn("Index non prêt.");
            return;
        }

        const allResults = searchIndex.search(query);
        const results = currentCcpFilter
            ? allResults.filter(r => r.room === currentCcpFilter)
            : allResults;

        if (results.length === 0) {
            contentGrid.innerHTML = '<div class="welcome-message"><p>Aucun résultat trouvé pour votre recherche.</p></div>';
            return;
        }

        results.forEach(r => {
            const card = document.createElement('div');
            card.className = 'lesson-card glass';

            // Icône + libellé selon le type
            const typeMeta = {
                'CHAPITRE':   { icon: '📖', label: 'CHAPITRE',   color: 'var(--accent)' },
                'DOCUMENT':   { icon: '📄', label: 'DOCUMENT',   color: '#8b5cf6' },
                'NOTE':       { icon: '📝', label: 'MA NOTE',    color: '#10b981' },
                'GLOSSAIRE':  { icon: '📚', label: 'GLOSSAIRE',  color: '#f59e0b' },
                'FLASHCARD':  { icon: '🧠', label: 'FLASHCARD',  color: '#ef4444' },
                'CONTENT_CHUNK': { icon: '📖', label: 'DANS LE COURS', color: 'var(--accent)' },
                'VAULT':      { icon: '🗂️', label: 'FICHE',      color: '#0ea5e9' },
            }[r.type] || { icon: '📌', label: r.type, color: 'var(--accent)' };

            card.innerHTML = `
                <div class="card-content" style="padding:18px 20px;">
                    <div class="card-type" style="color:${typeMeta.color};">${typeMeta.icon} ${typeMeta.label}</div>
                    <h4 style="margin-top:6px;">${r.title}</h4>
                    <p style="font-size:0.78rem; color:var(--text-secondary); margin-top:6px; line-height:1.5;">
                        ${(r.module || '').substring(0, 140)}${(r.module || '').length > 140 ? '…' : ''}
                    </p>
                </div>`;

            // Action selon le type
            card.onclick = () => {
                if (r.isNote) {
                    const modal = document.getElementById('noteModal');
                    document.getElementById('noteModalTitle').innerText = `📝 Note : ${r.item.key}`;
                    document.getElementById('noteModalBody').innerHTML = safeMarkdownToHtml(r.item.text);
                    modal.classList.remove('hidden');
                } else if (r.isGlossaire) {
                    document.getElementById('btnGlossaire').click();
                } else if (r.isFlash) {
                    if (typeof showFlashcards === 'function') showFlashcards([r.item]);
                } else if (r.isVault) {
                    const modal = document.getElementById('noteModal');
                    document.getElementById('noteModalTitle').innerText = `🗂️ ${r.title}`;
                    document.getElementById('noteModalBody').innerHTML = safeMarkdownToHtml(r.content);
                    modal.classList.remove('hidden');
                } else if (r.isFile) {
                    const mod = courseData.modules.find(m => m.files && m.files.includes(r.item));
                    if (mod) {
                        markAsRead(r.item);
                        window.open(`./${encodeURIComponent(mod.name)}/${encodeURIComponent(r.item)}`, '_blank');
                    } else {
                        // Un extrait de cours (rag-index) porte le nom du .json : on ouvre son chapitre
                        // dans le lecteur plutôt que le JSON brut dans un onglet.
                        const sub = chapitreDuFichier(r.item);
                        openSubModule(sub || { name: r.title, files: [r.item], parentName: 'Cours' });
                    }
                } else {
                    openSubModule(r.item);
                }
            };
            contentGrid.appendChild(card);
        });
    }

    function updateOverallProgress() {
        const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
        // v9.25.1 : progression globale par CHAPITRE (cohérente avec les cartes CCP et le plan
        // de révision) — l'ancien ratio fichiers sous-comptait les chapitres lus.
        const ccpAll = getCCPProgress();
        let doneCh = 0, totalCh = 0;
        Object.values(ccpAll).forEach(g => { doneCh += g.done; totalCh += g.total; });
        const percent = totalCh ? Math.round((doneCh / totalCh) * 100) : 0;
        progressBarFill.style.width = `${percent}%`;
        progressPercent.innerText = `${percent}%`;

        const fills = document.querySelectorAll('.ccp-progress-bar-fill');
        if (fills.length > 0) {
            const updated = getCCPProgress();
            const ccpOrder = [
                "CCP 1 - Accueillir pour analyser la demande",
                "CCP 2 - Accompagner les personnes dans leur parcours",
                "CCP 3 - Mettre en œuvre une offre de services employeurs",
                "Transversal - Compétences Support"
            ];
            fills.forEach((fill, i) => {
                const d = updated[ccpOrder[i]] || { total: 0, done: 0 };
                const pct = d.total > 0 ? Math.round((d.done / d.total) * 100) : 0;
                fill.style.width = pct + '%';
                fill.closest('.ccp-progress-row').querySelector('.ccp-progress-pct').innerText = pct + '%';
            });
        }
        // Mettre à jour les stats détaillées si présentes
        if (typeof renderDashboardStats === 'function') renderDashboardStats();
        if (typeof renderCcpStatsCard === 'function') renderCcpStatsCard();
    }

    // v6.9.8 : showStatsView + hideStatsView + renderCcpStatsCard + renderDashboardStats
    // déplacés vers js/modules/stats-view.js (exposés sur window.* pour rétrocompat).
    // getCCPProgress reste dans ce fichier (utilisé par updateOverallProgress + renderNavigation)
    // mais est désormais exposé via window.getCCPProgress (voir PATCH 5).

    window.markAsRead = (id) => markAsRead(id);
    function markAsRead(id) {
        // Tracker activité du jour pour heatmap
        const today = new Date().toISOString().slice(0, 10);
        const activity = JSON.parse(localStorage.getItem('almanach_activity') || '{}');
        activity[today] = (activity[today] || 0) + 1;
        localStorage.setItem('almanach_activity', JSON.stringify(activity));

        const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
        if (!completed.includes(id)) {
            completed.push(id);
            localStorage.setItem('completed_docs', JSON.stringify(completed));
            updateOverallProgress();
            if (typeof checkAchievements === 'function') checkAchievements();
            if (typeof renderDashboardStats === 'function') renderDashboardStats();
            if (typeof window.pedagoRenderDailyPlan === 'function') window.pedagoRenderDailyPlan();
        }
    }

    function renderNavigation(modules) {
        moduleNav.innerHTML = '';
        
        // v6.9.2-stats : bouton "Mes Statistiques" en haut de la sidebar
        const statsBtn = document.createElement('button');
        statsBtn.className = 'sidebar-stats-btn';
        statsBtn.type = 'button';
        statsBtn.innerHTML = '📊 <span>Mes statistiques</span>';
        statsBtn.onclick = () => { if (typeof showStatsView === 'function') showStatsView(); };
        moduleNav.appendChild(statsBtn);

        const ccpProgress = getCCPProgress();
        const ccpColors = {
            "CCP 1 - Accueillir pour analyser la demande": "#6366f1",
            "CCP 2 - Accompagner les personnes dans leur parcours": "#10b981",
            "CCP 3 - Mettre en œuvre une offre de services employeurs": "#f59e0b",
            "Transversal - Compétences Support": "#94a3b8"
        };
        const ccpShort = {
            "CCP 1 - Accueillir pour analyser la demande": "CCP 1",
            "CCP 2 - Accompagner les personnes dans leur parcours": "CCP 2",
            "CCP 3 - Mettre en œuvre une offre de services employeurs": "CCP 3",
            "Transversal - Compétences Support": "Transversal"
        };
        // v6.9.2-stats : ccpBlock obsolète dans la sidebar. Conservé en variable factice
        // pour minimiser le diff sur le code en aval (qui peut référencer ccpBlock).
        const ccpBlock = document.createElement('div');
        ccpBlock.style.display = 'none';
        ccpBlock.innerHTML = '';
        Object.entries(ccpColors).forEach(([fullName, color]) => {
            const data = ccpProgress[fullName] || { total: 0, done: 0 };
            const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
            const row = document.createElement('div');
            row.className = 'ccp-progress-row';
            row.innerHTML = `
                <div class="ccp-progress-label">
                    <span>${ccpShort[fullName]}</span>
                    <span class="ccp-progress-pct">${pct}%</span>
                </div>
                <div class="ccp-progress-bar-bg">
                    <div class="ccp-progress-bar-fill" style="width:${pct}%; background:${color};"></div>
                </div>`;
            ccpBlock.appendChild(row);
        });
        // v6.9.2-stats : ccpBlock ne va plus dans la sidebar, il est rendu dans statsView via renderCcpStatsCard.
        // (suppression de moduleNav.appendChild(ccpBlock))

        // Grouper les modules par CCP
        const groups = {};
        modules.forEach(mod => {
            const ccp = mod.ccp || 'Autre';
            if (!groups[ccp]) groups[ccp] = [];
            groups[ccp].push(mod);
        });

        // Définir l'ordre d'affichage (CCP 1, 2, 3 puis Transversal)
        const order = [
            "CCP 1 - Accueillir pour analyser la demande",
            "CCP 2 - Accompagner les personnes dans leur parcours",
            "CCP 3 - Mettre en œuvre une offre de services employeurs",
            "Transversal - Compétences Support",
            "Autre"
        ];

        order.forEach(groupName => {
            if (!groups[groupName] || groups[groupName].length === 0) return;

            // Ajouter l'en-tête du groupe
            const groupHeader = document.createElement('div');
            groupHeader.className = 'ccp-header';
            groupHeader.innerText = groupName;
            moduleNav.appendChild(groupHeader);

            // Ajouter les modules du groupe
            groups[groupName].forEach(mod => {
                const modNumMatch = mod.name.match(/\d+/);
                const modNum = modNumMatch ? modNumMatch[0] : '?';
                const progress = getModuleProgress(mod);
                const navItem = document.createElement('div');
                navItem.className = 'nav-item';

                const mk = getModuleKey(mod.name);
                navItem.innerHTML = `
                    <div class="nav-item-inner">
                        <div class="nav-item-thumb" style="background-image:url('assets/modules/${mk}.png'),url('assets/themes/${getModuleTheme(mod.name)}.png');"></div>
                        <div class="nav-item-text">
                            <div class="module-num">MODULE ${modNum}</div>
                            <div class="module-name">${mod.name.split('-')[1]?.trim() || mod.name}</div>
                            <div class="mini-progress" style="height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; margin-top: 6px;">
                                <div style="width: ${progress}%; height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.3s;"></div>
                            </div>
                            <div style="font-size: 0.6rem; opacity: 0.5; margin-top: 2px;">${progress}% complété</div>
                        </div>
                    </div>
                `;
                navItem.onclick = () => {
                    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                    navItem.classList.add('active');
                    currentModuleName.innerText = mod.name;
                    currentModuleSubtitle.innerText = `${(mod.sub_modules || []).length} chapitres disponibles`;
                    renderModuleContent(mod);
                };
                moduleNav.appendChild(navItem);
            });
        });
    }

    function getModuleProgress(mod) {
        const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
        const chapters = moduleChapters(mod);
        if (!chapters.length) return 0;
        const done = chapters.filter(c => isChapterDone(c, completed)).length;
        return Math.round((done / chapters.length) * 100);
    }

    // v9.25.1 : modèle canonique de « chapitre » partagé (sous-module marqué par son nom via le
    // lecteur ; repli fichier pour les modules documentaires marqués par nom de fichier).
    function moduleChapters(mod) {
        const units = (mod.sub_modules || [])
            .filter(s => (s.files || []).length)
            .map(s => ({ name: s.name, files: s.files }));
        if (!units.length && (mod.files || []).length) {
            units.push({ name: mod.name, files: mod.files });
        }
        return units;
    }
    function isChapterDone(unit, completed) {
        return completed.includes(unit.name) || (unit.files || []).some(f => completed.includes(f));
    }
    function getCCPProgress() {
        const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
        const groups = {};
        COURSE_DATA.modules.forEach(mod => {
            const ccp = mod.ccp || 'Autre';
            if (!groups[ccp]) groups[ccp] = { total: 0, done: 0 };
            const chapters = moduleChapters(mod);
            groups[ccp].total += chapters.length;
            groups[ccp].done += chapters.filter(c => isChapterDone(c, completed)).length;
        });
        return groups;
    }


    window.renderModuleContent = (mod) => renderModuleContent(mod);
    function renderModuleContent(mod) {
        contentGrid.innerHTML = '';
        currentModuleName.innerText = mod.name;
        
        const quizBtnHtml = `<button id="startQuiz" class="btn-primary" style="margin-left: 20px; font-size: 0.7rem; background: #f43f5e;">🎯 Faire le Quiz</button>`;
        currentModuleSubtitle.innerHTML = `<span>${(mod.sub_modules || []).length} Chapitres | ${(mod.files || []).length} Documents</span>` + quizBtnHtml;

        const theme = getModuleTheme(mod.name);
        const modKey = getModuleKey(mod.name);

        // Mettre à jour le fond du hero avec l'image du module
        const hero = document.querySelector('.dashboard-hero');
        if (hero) {
            hero.style.backgroundImage = `url('assets/modules/${modKey}.png'), url('assets/themes/${theme}.png')`;
            hero.style.backgroundSize = 'cover';
            hero.style.backgroundPosition = 'center';
            hero.style.position = 'relative';
            hero.style.setProperty('--hero-overlay', 'rgba(10,10,18,0.75)');
        }

        // Setup Quiz Button
        const startQuizBtn = document.getElementById('startQuiz');
        const modNum = parseInt(mod.name.match(/\d+/));
        if (startQuizBtn) startQuizBtn.onclick = () => window.startQuiz(modNum);

        if (mod.sub_modules) {
            mod.sub_modules.forEach((sub, subIdx) => {
                const card = document.createElement('div');
                card.className = `lesson-card glass theme-${theme}`;
                const subImg = `assets/sub-modules/${modKey}-${subIdx}.png`;
                const modImg = `assets/modules/${modKey}.png`;
                const themeImg = `assets/themes/${theme}.png`;
                card.innerHTML = `
                    <div class="card-image" style="background-image: url('${subImg}'), url('${modImg}'), url('${themeImg}')"></div>
                    <div class="card-content">
                        <div class="card-type">CHAPITRE</div>
                        <h4>${sub.name}</h4>
                        <div class="lesson-meta"><span>📂 ${sub.files.length} pages</span></div>
                    </div>
                `;
                card.onclick = () => {
                    sub.parentName = mod.name;
                    openSubModule(sub);
                };
                contentGrid.appendChild(card);
            });
        }        
        if (mod.files && mod.files.length > 0) {
            const modImg = `assets/modules/${modKey}.png`;
            const themeImg = `assets/themes/${theme}.png`;
            mod.files.forEach(file => {
                const card = document.createElement('div');
                card.className = `lesson-card glass file-card theme-${theme}`;
                card.innerHTML = `
                    <div class="card-image" style="background-image: url('${modImg}'), url('${themeImg}')"></div>
                    <div class="card-content">
                        <div class="card-type">DOCUMENT</div>
                        <h4>${file.replace('.pdf', '')}</h4>
                        <div class="lesson-meta"><span>📄 PDF</span></div>
                    </div>
                `;
                card.onclick = () => {
                    markAsRead(file);
                    window.open(`./${encodeURIComponent(mod.name)}/${encodeURIComponent(file)}`, '_blank');
                };
                contentGrid.appendChild(card);
            });
        }

        if (contentGrid.innerHTML === '') {
            contentGrid.innerHTML = '<div class="welcome-message"><p>Ce module ne contient pas encore de documents.</p></div>';
        }
    }

    // v6.9.11 : openSubModule déplacé vers js/modules/reader.js (exposé sur window.openSubModule).

    // v9.8.0 : runCoachQuiz / runGeneratedQuiz / runGlobalQuiz déplacés vers js/modules/quiz-engine.js (exposés sur window.*).

    document.getElementById('closeBook').onclick = () => {
        document.getElementById('bookViewer').classList.add('hidden');
        // v7.0.8 : stopReading() coupe le flux speakNextSentence + UI button + highlights.
        // router.hardStop() tue l'audio router-owned (Supertonic/Voxtral/Piper) + pre-synths.
        // L'ancien `speak('')` ne touchait QUE Web Speech via synth.cancel() → bug audio continue.
        if (window.aiHelper && typeof window.aiHelper.stopReading === 'function') {
            window.aiHelper.stopReading();
        }
        try {
            import('./tts/tts-router.js').then(m => {
                const r = m && m.default;
                if (r && typeof r.hardStop === 'function') r.hardStop();
                else if (r && typeof r.stop === 'function') r.stop();
            }).catch(() => {});
        } catch (e) { /* ignore */ }
    };

    // Toggle sommaire mobile
    const toggleTOCBtn = document.getElementById('toggleTOC');
    const readerTOCBackdrop = document.getElementById('readerTOCBackdrop');
    if (toggleTOCBtn && readerTOCBackdrop) {
        toggleTOCBtn.onclick = () => {
            const tocEl = document.getElementById('readerTOC');
            const isOpen = tocEl.classList.toggle('is-open');
            readerTOCBackdrop.classList.toggle('is-open', isOpen);
            toggleTOCBtn.setAttribute('aria-expanded', String(isOpen));
        };
        readerTOCBackdrop.onclick = () => {
            document.getElementById('readerTOC').classList.remove('is-open');
            readerTOCBackdrop.classList.remove('is-open');
            toggleTOCBtn.setAttribute('aria-expanded', 'false');
        };
    }

    // === v6.9.2-stats : bouton retour de la vue Stats ===
    const btnStatsBack = document.getElementById('btnStatsBack');
    if (btnStatsBack) btnStatsBack.onclick = () => { if (typeof hideStatsView === 'function') hideStatsView(); };

    // Toggle sidebar mobile
    const toggleSidebarBtn = document.getElementById('toggleSidebar');
    const sidebarEl = document.querySelector('.sidebar');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');

    if (toggleSidebarBtn && sidebarEl && sidebarBackdrop) {
        const closeSidebar = () => {
            sidebarEl.classList.remove('is-open');
            sidebarBackdrop.classList.remove('is-open');
            toggleSidebarBtn.setAttribute('aria-expanded', 'false');
        };
        toggleSidebarBtn.onclick = () => {
            const isOpen = sidebarEl.classList.toggle('is-open');
            sidebarBackdrop.classList.toggle('is-open', isOpen);
            toggleSidebarBtn.setAttribute('aria-expanded', String(isOpen));
        };
        sidebarBackdrop.onclick = closeSidebar;
        // Fermer la sidebar quand un module est cliqué (sur mobile)
        document.getElementById('moduleNav').addEventListener('click', (e) => {
            if (e.target.closest('.nav-item') && window.innerWidth <= 1024) closeSidebar();
        });
    }

    // v6.9.9 : loadScenarios + state simulation + startSimulation + updateSimulationStep
    // + showSimDebriefing déplacés vers js/modules/simulation.js (exposés sur window.*).

    // --- Exercices Interactifs (Phase 13) ---
    window.startExercise = async (cpCode) => {
        try {
            const response = await fetch('./data/exercises.json');
            const data = await response.json();
            const exercise = data.find(ex => ex.cp === cpCode);
            
            if (!exercise) {
                alert(`Pas d'exercice spécifique pour ${cpCode} pour le moment.`);
                return;
            }

            const modal = document.getElementById('quizModal');
            modal.classList.remove('hidden');
            document.getElementById('quizTitle').innerText = `Exercice Pratique : ${cpCode}`;
            
            // On réutilise la logique de quiz mais adaptée
            window.QuizStore.current = {
                title: exercise.title,
                questions: exercise.questions
            };
            window.QuizStore.idx = 0;
            window.QuizStore.score = 0;
            window.showQuestion();
            
        } catch (e) {
            console.error(e);
            alert("Erreur lors du chargement de l'exercice.");
        }
    };

    // v6.9.9 : openScenario déplacé vers js/modules/simulation.js (exposés sur window.openScenario).

    // Keyboard Navigation
    document.addEventListener('keydown', (e) => {
        const flashModal = document.getElementById('flashcardsModal');
        const bookViewer = document.getElementById('bookViewer');

        if (e.key === 'Escape') {
            // Ordre de priorité : fermer le modal le plus récemment ouvert en premier
            const modalsToClose = [
                { id: 'flashcardsModal', close: () => document.getElementById('flashcardsModal').classList.add('hidden') },
                { id: 'labModal',        close: () => document.getElementById('labModal').classList.add('hidden') },
                { id: 'exerciseModal',   close: () => document.getElementById('exerciseModal').classList.add('hidden') },
                { id: 'examModal',       close: () => document.getElementById('examModal').classList.add('hidden') },
                { id: 'historyModal',    close: () => document.getElementById('historyModal').classList.add('hidden') },
                { id: 'helpModal',       close: () => document.getElementById('helpModal').classList.add('hidden') },
                { id: 'systemModal',     close: () => document.getElementById('systemModal').classList.add('hidden') },
                { id: 'favoritesModal',  close: () => document.getElementById('favoritesModal').classList.add('hidden') },
                { id: 'settingsModal',   close: () => document.getElementById('settingsModal').classList.add('hidden') },
                { id: 'glossaireModal',  close: () => document.getElementById('glossaireModal').classList.add('hidden') },
            ];

            for (const modal of modalsToClose) {
                const el = document.getElementById(modal.id);
                if (el && !el.classList.contains('hidden')) {
                    modal.close();
                    return;
                }
            }

            // Fermer le lecteur en dernier
            if (bookViewer && !bookViewer.classList.contains('hidden')) {
                document.getElementById('closeBook').click();
                return;
            }
        }

        if (bookViewer.classList.contains('hidden')) return;
        if (!flashModal.classList.contains('hidden')) return; // Don't flip book if flashcards are open
        
        const rc = document.getElementById('readerContent');
        if (rc) {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') rc.scrollBy({ top: 200, behavior: 'smooth' });
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') rc.scrollBy({ top: -200, behavior: 'smooth' });
        }
    });

    // --- PWA Installation Logic ---
    let deferredPrompt;
    const installBtn = document.getElementById('installBtn');

    // --- Quiz Logic ---
    // v9.8.0 : window.QuizStore + tout le moteur quiz/examen déplacés vers js/modules/quiz-engine.js.

    // v9.8.0 : startQuiz / showQuestion / startTimer déplacés vers js/modules/quiz-engine.js (exposés sur window.*).

    // v9.10.0 : renderHistory déplacé vers js/modules/stats-view.js (exposé sur window.renderHistory).

    // --- Note Viewer Logic ---
    document.getElementById('closeNote').onclick = () => document.getElementById('noteModal').classList.add('hidden');
    document.getElementById('closeNoteBtn').onclick = () => document.getElementById('noteModal').classList.add('hidden');

    // v9.8.0 : checkAnswer déplacé vers js/modules/quiz-engine.js.

    // v9.8.0 : corps déplacé dans quiz-engine.js (window.quizNextHandler). Câblage conservé ici.
    document.getElementById('nextQuiz').onclick = () => window.quizNextHandler();

    installBtn.onclick = async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === 'accepted') installBtn.classList.add('hidden');
            deferredPrompt = null;
        }
    };

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        installBtn.classList.remove('hidden');
    });

    // --- Notes Export Logic ---
    document.getElementById('downloadNotes').onclick = () => {
        const notes = localStorage.getItem('almanach_notes') || "Aucune note enregistrée.";
        const completed = localStorage.getItem('completed_docs') || "[]";
        
        const content = `# Mes Notes de Révision - L'Almanach du CIP\n\n${notes}\n\n## Progression\nDocuments consultés : ${JSON.parse(completed).length}`;
        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Notes_Almanach_CIP_${new Date().toLocaleDateString()}.md`;
        a.click();
        // v7.0.7 : revoke pour éviter retention RAM (mini-leak à chaque export).
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 0);
    };



    async function updateSystemInfo() {
        const osLabel = document.getElementById('sysOS');
        const engineLabel = document.getElementById('sysEngine');
        const modelLabel = document.getElementById('sysModel');

        if (window.electronAPI && window.electronAPI.getHardwareInfo) {
            try {
                const info = await window.electronAPI.getHardwareInfo();
                osLabel.innerText = `${info.os} (${info.arch})`;
                engineLabel.innerText = info.gpu || "CPU (Pas de GPU détecté)";
                engineLabel.style.color = info.gpu ? "#10b981" : "#f59e0b";
            } catch (e) {
                console.error("Hardware info error:", e);
                osLabel.innerText = "Erreur de détection";
            }
        } else {
            // Fallback pour navigateur standard
            const ua = navigator.userAgent;
            let os = 'Inconnu';
            if (ua.includes('Win')) os = 'Windows';
            else if (ua.includes('Mac')) os = 'macOS';
            else if (ua.includes('Linux')) os = 'Linux';
            else if (ua.includes('Android')) os = 'Android';
            else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
            osLabel.innerText = os;

            const isWebGPU = 'gpu' in navigator;
            engineLabel.innerText = isWebGPU ? "WebGPU (Accélération Matérielle)" : "CPU (Mode Compatibilité)";
            engineLabel.style.color = isWebGPU ? "#10b981" : "#f59e0b";
        }

        // AI Model Status
        const aiReady = window.aiHelper && window.aiHelper.pipeline;
        modelLabel.innerText = aiReady ? "Gemma 2B — Chargé en mémoire" : "En attente d'initialisation (cliquez sur 🤖)";
        modelLabel.style.color = aiReady ? "#10b981" : "#f43f5e";
    }

    function renderFavorites() {
        const favs = JSON.parse(localStorage.getItem('almanach_favorites') || '[]');
        const list = document.getElementById('favoritesList');
        if (favs.length === 0) {
            list.innerHTML = '<p style="color: var(--text-secondary);">Aucun favori pour le moment.</p>';
            return;
        }
        list.innerHTML = '';
        favs.forEach(f => {
            const row = document.createElement('div');
            row.className = 'glass';
            row.style.cssText = 'padding: 12px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center;';
            
            const label = document.createElement('span');
            label.textContent = f.replace('.pdf', '');
            
            const btn = document.createElement('button');
            btn.className = 'btn-icon';
            btn.style.fontSize = '0.7rem';
            btn.textContent = '🗑️';
            btn.addEventListener('click', () => {
                toggleFavorite(f);
                row.remove();
            });
            
            row.appendChild(label);
            row.appendChild(btn);
            list.appendChild(row);
        });
    }

    function renderGlossaire(filter) {
        const list = document.getElementById('glossaireList');
        const cpColors = { CP1:'#6366f1',CP2:'#6366f1',CP3:'#6366f1',CP4:'#6366f1',CP5:'#6366f1',CP6:'#10b981',CP7:'#10b981',CP8:'#10b981',CP9:'#10b981',CP10:'#10b981',CP11:'#10b981',CP12:'#f59e0b',CP13:'#f59e0b',CP14:'#f59e0b',CP15:'#f59e0b',CT1:'#94a3b8',CT2:'#94a3b8' };
        
        const allItems = (typeof CIP_GLOSSAIRE !== 'undefined' ? CIP_GLOSSAIRE : []);
        window.glossaireData = allItems;
        
        const items = allItems.filter(g => !filter || g.terme.toLowerCase().includes(filter) || g.def.toLowerCase().includes(filter) || g.cp.toLowerCase().includes(filter));

        if (items.length === 0) {
            list.innerHTML = '<p style="color:var(--text-secondary); text-align:center; padding:20px;">Aucun terme trouvé.</p>';
            return;
        }
        list.innerHTML = '';
        items.forEach(g => {
            const color = cpColors[g.cp] || 'var(--accent)';
            const div = document.createElement('div');
            div.style.cssText = `padding:14px 16px; background:rgba(255,255,255,0.03); border-radius:12px; border-left:3px solid ${color}; cursor:pointer; transition:background 0.2s;`;
            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
                    <strong style="color:var(--text-primary); font-size:0.95rem;">${g.terme}</strong>
                    <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                        <span style="font-size:0.65rem; padding:3px 8px; background:${color}22; border-radius:20px; color:${color}; white-space:nowrap;">${g.cp}</span>
                        <span style="font-size:0.65rem; opacity:0.4;">🔍</span>
                    </div>
                </div>
                <p style="color:var(--text-secondary); font-size:0.82rem; margin-top:6px; line-height:1.55;">${g.def}</p>`;
            div.onmouseenter = () => { div.style.background = 'rgba(255,255,255,0.07)'; };
            div.onmouseleave = () => { div.style.background = 'rgba(255,255,255,0.03)'; };
            div.onclick = () => {
                // Afficher la fiche détaillée du terme dans la modal glossaire elle-même
                const termColor = color; // Already calculated above
                list.innerHTML = `
                    <div style="padding:20px; background:rgba(255,255,255,0.04); border-radius:14px; border-left:4px solid ${termColor};">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                            <h3 style="color:${termColor}; margin:0;">${g.terme}</h3>
                            <span style="font-size:0.7rem; padding:4px 12px; background:${termColor}22; border-radius:20px; color:${termColor};">${g.cp}</span>
                        </div>
                        <p style="color:var(--text-primary); font-size:0.95rem; line-height:1.65; margin:0;">${g.def}</p>
                        <button id="backToGlossaire" class="btn-primary" style="margin-top:18px; width:100%; background:rgba(255,255,255,0.1);">← Retour au glossaire</button>
                    </div>`;
                document.getElementById('backToGlossaire').onclick = () => {
                    const search = document.getElementById('glossaireSearch');
                    renderGlossaire(search ? search.value.toLowerCase().trim() : '');
                };
            };
            list.appendChild(div);
        });
    }

    // --- Installation IA ---
    // v9.28.1 : le flag localStorage ne survit pas à un profil vierge (mode
    // portable v9.28.0) → si le modèle est physiquement dans le bundle, on
    // pose le flag automatiquement (fin du faux « IA pas installée »).
    const markAIInstalled = () => {
        const btn = document.getElementById('btnInstallAI');
        if (btn) { btn.textContent = '✅ IA Qwen2.5 installée'; btn.disabled = true; btn.style.background = '#10b981'; }
    };
    const aiInstalled = localStorage.getItem('almanach_ai_installed') === 'true';
    if (aiInstalled) {
        markAIInstalled();
    } else if (window.electronAPI && window.electronAPI.aiModelPresent) {
        window.electronAPI.aiModelPresent().then((present) => {
            if (present) {
                localStorage.setItem('almanach_ai_installed', 'true');
                markAIInstalled();
                console.log('[IA] modèle détecté sur disque — flag installé posé automatiquement');
            }
        }).catch(() => {});
    }
    // v9.32.0 : en version web, le téléchargement du modèle ne peut pas aboutir (IA Electron seule).
    if (!window.electronAPI) document.getElementById('aiInstallBlock').style.display = 'none';
    // v9.32.0 : l'export public a un contenu fictif (COURSE_DATA.demo) : on l'annonce d'emblée.
    if (window.COURSE_DATA && window.COURSE_DATA.demo) {
        document.querySelector('.sidebar-header .logo').textContent = 'CIP · démo fictive';
        document.getElementById('currentModuleSubtitle').textContent = "Démo d'un projet en cours de développement : tout le contenu est inventé, les vrais supports de formation ne sont pas publiés.";
    }

    // v9.29.0 : sonde de boot — une entrée de journal par lancement (état machine
    // + app), différée 2,5 s pour ne pas peser sur le démarrage. Electron only de
    // fait (la persistance ne passe que par electronAPI).
    const _bootProbeAt = Math.round(performance.now());
    setTimeout(async () => {
        try {
            if (!window.electronAPI) return;
            const hw = window.electronAPI.getHardwareInfo ? await window.electronAPI.getHardwareInfo() : {};
            const aiOnDisk = window.electronAPI.aiModelPresent ? await window.electronAPI.aiModelPresent() : null;
            window.logTechEvent('boot',
                `boot ${_bootProbeAt} ms | RAM libre ${hw.memFreeGB ?? '?'}/${hw.memTotalGB ?? '?'} Go | IA sur disque : ${aiOnDisk} | flag installé : ${localStorage.getItem('almanach_ai_installed') === 'true'}`,
                hw.os ? `${hw.os} (${hw.arch})` : '');
        } catch (_) {}
    }, 2500);

    // Bouton "Vider le cache IA" — réinitialise tout pour un nouveau téléchargement propre
    document.getElementById('btnClearAICache').onclick = async () => {
        const btn = document.getElementById('btnClearAICache');
        btn.textContent = '⏳ Nettoyage...';
        btn.disabled = true;
        try {
            // Vider IndexedDB (cache principal de Transformers.js)
            const dbs = await indexedDB.databases();
            await Promise.all(dbs.map(db => new Promise((res, rej) => {
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = res;
                req.onerror = rej;
            })));
            // Vider Cache Storage (fichiers WASM et modèles)
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
            // Réinitialiser le flag d'installation
            localStorage.removeItem('almanach_ai_installed');
            // Réactiver le bouton d'installation
            const installBtn = document.getElementById('btnInstallAI');
            installBtn.textContent = '🤖 Télécharger ce modèle';
            installBtn.disabled = false;
            installBtn.style.background = 'linear-gradient(135deg,#6366f1,#8b5cf6)';
            document.getElementById('aiInstallProgress').classList.add('hidden');
            btn.textContent = '✅ Cache vidé — relancez le téléchargement';
            btn.style.background = '#10b981';
        } catch(e) {
            btn.textContent = '❌ Erreur nettoyage';
            btn.disabled = false;
            console.error(e);
        }
    };
    document.getElementById('btnInstallAI').onclick = async () => {
        const btn = document.getElementById('btnInstallAI');
        const progressBlock = document.getElementById('aiInstallProgress');
        const bar = document.getElementById('aiProgressBar');
        const label = document.getElementById('aiProgressLabel');
        // v8.3.0 : modèle unique → plus de sélecteur, libellé fixe pour l'affichage.
        const selectedModel = 'Qwen 2.5 1.5B CIP';

        btn.disabled = true;
        btn.textContent = '⏳ Téléchargement en cours...';
        progressBlock.classList.remove('hidden');

        try {
            label.textContent = `Connexion à HuggingFace (${selectedModel})...`;
            bar.style.width = '3%';

            await window.aiHelper.loadModelWithProgress((progress) => {
                if (progress.status === 'downloading') {
                    label.textContent = `Fichier ${progress.index}/${progress.total} : ${progress.file}`;
                    const filePct = (progress.index - 1) / progress.total * 100;
                    bar.style.width = filePct + '%';
                } else if (progress.status === 'progress' && progress.total) {
                    const filePct = ((progress.index - 1) + progress.loaded / progress.total) / progress.totalFiles * 100;
                    bar.style.width = Math.round(filePct) + '%';
                    const mb = Math.round(progress.loaded / 1024 / 1024);
                    const total = Math.round(progress.total / 1024 / 1024);
                    label.textContent = `Fichier ${progress.index}/${progress.totalFiles} — ${progress.file} : ${mb}/${total} Mo`;
                } else if (progress.status === 'loading') {
                    bar.style.width = '95%';
                    label.textContent = 'Chargement du modèle en mémoire...';
                } else if (progress.status === 'done') {
                    bar.style.width = '100%';
                    label.textContent = 'Prêt !';
                } else if (progress.status === 'skip') {
                    label.textContent = `Fichier ${progress.index}/${progress.total} déjà présent, passage...`;
                }
            });

            localStorage.setItem('almanach_ai_installed', 'true');
            btn.textContent = `✅ IA ${selectedModel} installée !`;
            btn.style.background = '#10b981';
            label.textContent = 'Installation réussie — l\'IA est prête, ouvrez le chat 🤖';
            bar.style.width = '100%';
        } catch (e) {
            btn.disabled = false;
            btn.textContent = '❌ Erreur — Réessayer';
            btn.style.background = '#f43f5e';
            const msg = e?.message || String(e);
            if (msg.includes('403')) {
                label.textContent = 'Accès refusé (403) — modèle nécessitant une licence. Contactez le support.';
            } else if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed')) {
                label.textContent = 'Erreur réseau — vérifiez votre connexion internet.';
            } else {
                label.textContent = `Erreur : ${msg.substring(0, 80)}`;
            }
            console.error('AI install error:', e);
        }
    };

    // v6.9.10 : renderExamMode déplacé vers js/modules/exam.js (exposés sur window.renderExamMode).

    // v6.9.10 : MOCK_EXAM_CONFIG + buildCpToCcpMap + inferCcpForQuestion + sampleN + renderExamLauncher dans js/modules/exam.js.
    // v9.8.0 : startMockExam / startGlobalExamTimer / stopGlobalExamTimer / finishMockExam déplacés vers js/modules/quiz-engine.js (exposés sur window.*).



    safeWire('btnStartMockExam', () => window.startMockExam(), 'btnStartMockExam');
    // === FIN EXAMEN BLANC ==============================================

    // --- Parcours Prioritaire (Phase 15.5) ---
    // v6.9.10 : showParcoursPrioritaire + filterByCP déplacés vers js/modules/exam.js
    // (exposés sur window.*). Le setTimeout boot du banner prioritaire est aussi dans le module.

    document.getElementById('settingTtsRate').onchange = (e) => {
        localStorage.setItem('almanach_tts_rate', e.target.value);
        const readerSpeed = document.getElementById('readerTtsSpeed');
        if (readerSpeed) readerSpeed.value = e.target.value;
    };

    // Sélecteur de voix — populer avec les voix françaises disponibles
    function populateVoiceSelect() {
        const select = document.getElementById('settingVoice');
        const voices = window.speechSynthesis.getVoices()
            .filter(v => v.lang.startsWith('fr'));
        const savedVoice = localStorage.getItem('almanach_tts_voice') || '';

        // Garder l'option "Automatique" + ajouter les voix détectées
        select.innerHTML = '<option value="">Automatique (meilleure voix détectée)</option>';
        voices.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = `${v.name} (${v.lang})`;
            if (v.name === savedVoice) opt.selected = true;
            select.appendChild(opt);
        });
    }
    // Les voix sont chargées de façon asynchrone sur certains navigateurs
    populateVoiceSelect();
    window.speechSynthesis.onvoiceschanged = populateVoiceSelect;

    document.getElementById('settingVoice').onchange = (e) => {
        localStorage.setItem('almanach_tts_voice', e.target.value);
    };
    
    document.getElementById('settingTheme').onchange = (e) => {
        localStorage.setItem('almanach_theme', e.target.value);
        applyReaderTheme(e.target.value);
    };
    const savedTheme = localStorage.getItem('almanach_theme');
    if (savedTheme) document.getElementById('settingTheme').value = savedTheme;

    function applyReaderTheme(theme) {
        const reader = document.getElementById('readerContent');
        if (!reader) return;
        reader.classList.remove('theme-sepia', 'theme-light', 'theme-dark');
        reader.classList.add(`theme-${theme}`);
        
        // Sync body theme
        document.body.classList.remove('dark-theme', 'light-theme', 'sepia-theme');
        document.body.classList.add(theme === 'dark' ? 'dark-theme' : theme === 'light' ? 'light-theme' : 'sepia-theme');
    }
    window.applyReaderTheme = applyReaderTheme;
    document.getElementById('settingFontSize').onchange = (e) => {
        localStorage.setItem('almanach_font_size', e.target.value);
        document.querySelectorAll('.native-text, .reader-section-body').forEach(el => {
            el.style.fontSize = e.target.value;
        });
    };
    document.getElementById('resetProgress').onclick = () => {
        if (confirm('Réinitialiser toute la progression ? Cette action est irréversible.')) {
            localStorage.removeItem('completed_docs');
            localStorage.removeItem('almanach_favorites');
            localStorage.removeItem('almanach_notes');
            // v7.0.8 : nettoyage clé orpheline post-retrait Kokoro v7.0.1.
            localStorage.removeItem('almanach_kokoro_installed');
            updateOverallProgress();
            renderNavigation(courseData.modules);
            alert('Progression réinitialisée.');
        }
    };

    // Reset SM2 flashcards
    document.getElementById('resetSM2').onclick = () => {
        if (!confirm('Réinitialiser toutes vos flashcards SM2 ? Votre historique de révision sera effacé.')) return;
        Object.keys(localStorage).filter(k => k.startsWith('sm2_')).forEach(k => localStorage.removeItem(k));
        alert('✅ Flashcards SM2 réinitialisées.');
    };

    // Taille police globale
    const settingGlobalFontSize = document.getElementById('settingGlobalFontSize');
    const savedGlobalFont = localStorage.getItem('almanach_global_font') || '16px';
    if (settingGlobalFontSize) {
        settingGlobalFontSize.value = savedGlobalFont;
        document.documentElement.style.fontSize = savedGlobalFont;
        settingGlobalFontSize.onchange = (e) => {
            localStorage.setItem('almanach_global_font', e.target.value);
            document.documentElement.style.fontSize = e.target.value;
        };
    }

    // Export données
    document.getElementById('exportAllData').onclick = () => {
        const data = {
            exportDate: new Date().toISOString(),
            progression: JSON.parse(localStorage.getItem('completed_docs') || '[]'),
            favoris: JSON.parse(localStorage.getItem('almanach_favorites') || '[]'),
            streak: localStorage.getItem('almanach_streak'),
            notes: {},
            sm2: {}
        };
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith('note_')) data.notes[k] = localStorage.getItem(k);
            if (k.startsWith('sm2_')) data.sm2[k] = localStorage.getItem(k);
        });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `almanach-backup-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    };

    // Export PDF — synthèse imprimable des notes, scores et progression
    document.getElementById('exportPDF').onclick = () => {
        if (!window.jspdf || !window.jspdf.jsPDF) {
            alert('La librairie PDF n\'est pas chargée. Vérifie que js/lib/jspdf.umd.min.js est bien présent.');
            return;
        }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });

        const PAGE_W = 210, MARGIN = 18;
        let y = MARGIN;

        const checkPageBreak = (needed = 12) => {
            if (y + needed > 280) { doc.addPage(); y = MARGIN; }
        };
        const writeLine = (text, opts = {}) => {
            const { size = 11, color = [30, 30, 40], bold = false, indent = 0 } = opts;
            checkPageBreak(size * 0.6);
            doc.setFont('helvetica', bold ? 'bold' : 'normal');
            doc.setFontSize(size);
            doc.setTextColor(...color);
            const lines = doc.splitTextToSize(String(text), PAGE_W - 2 * MARGIN - indent);
            lines.forEach(l => {
                checkPageBreak(size * 0.5);
                doc.text(l, MARGIN + indent, y);
                y += size * 0.5;
            });
        };
        const writeSeparator = () => { y += 2; doc.setDrawColor(99, 102, 241); doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 6; };

        // En-tête
        writeLine('L\'Almanach du CIP — Rapport personnel', { size: 18, bold: true, color: [99, 102, 241] });
        writeLine(`Généré le ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`, { size: 9, color: [120, 120, 140] });
        writeSeparator();

        // Progression
        const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
        const streak = parseInt(localStorage.getItem('almanach_streak') || '0', 10);
        writeLine('📊 Progression', { size: 14, bold: true });
        writeLine(`• Documents lus : ${completed.length}`, { size: 11, indent: 4 });
        writeLine(`• Série en cours : ${streak} jour(s)`, { size: 11, indent: 4 });
        writeSeparator();

        // Scores quiz
        const quizHistory = JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]');
        if (quizHistory.length > 0) {
            writeLine('🎯 Historique des quiz', { size: 14, bold: true });
            quizHistory.slice(-20).reverse().forEach(q => {
                writeLine(`${q.date || '?'} — ${q.theme || 'Quiz'} : ${q.score}/${q.total}`, { size: 10, indent: 4 });
            });
            writeSeparator();
        }

        // Notes personnelles
        const notes = Object.keys(localStorage)
            .filter(k => k.startsWith('note_'))
            .map(k => ({ key: k.replace('note_', ''), text: localStorage.getItem(k) }))
            .filter(n => n.text && n.text.trim().length > 0);
        if (notes.length > 0) {
            writeLine('📝 Notes personnelles', { size: 14, bold: true });
            notes.forEach(n => {
                writeLine(`▸ ${n.key}`, { size: 11, bold: true, indent: 2 });
                writeLine(n.text, { size: 10, indent: 6, color: [60, 60, 80] });
                y += 2;
            });
            writeSeparator();
        }

        // Favoris
        const favoris = JSON.parse(localStorage.getItem('almanach_favorites') || '[]');
        if (favoris.length > 0) {
            writeLine('⭐ Favoris', { size: 14, bold: true });
            favoris.forEach(f => writeLine(`• ${f}`, { size: 10, indent: 4 }));
        }

        doc.save(`almanach-rapport-${new Date().toISOString().slice(0, 10)}.pdf`);
    };

    // Load saved settings
    // v6.9.5 : settingTtsVoice (legacy hardcodé) supprimé. La voix de lecture
    // est maintenant gérée par settingTtsVoiceReader dans setupTtsSettings() ci-dessous.
    const settingTtsRate = document.getElementById('settingTtsRate');
    if (settingTtsRate) {
        const savedRate = localStorage.getItem('almanach_tts_rate') || '1.0';
        settingTtsRate.value = savedRate;
        settingTtsRate.onchange = (e) => {
            localStorage.setItem('almanach_tts_rate', e.target.value);
        };
    }

    // === v6.9.2 : TTS pluggable multi-moteurs ===========================
    (async function setupTtsSettings() {
        const personaSel = document.getElementById('settingTtsVoicePersona');
        const cipSel = document.getElementById('settingTtsVoiceCip');
        const hwReport = document.getElementById('ttsHardwareReport');
        const dlStatus = document.getElementById('ttsDownloadStatus');
        if (!personaSel || !cipSel) return;

        const router = (await import('./tts/tts-router.js')).default;
        const { summarize, supertonicSuitability } = await import('./tts/hardware-detector.js');

        await router.getOrInit();

        // v7.4.0 : nettoyage des prefs Voxtral orphelines (engine retiré). Sentinelle pour
        // n'exécuter qu'une fois par utilisateur. Sans cela, un pref `voxtral:xxx` ferait
        // throw le router au prochain speakAs (engine inexistant).
        if (localStorage.getItem('almanach_voxtral_removal_v740') !== '1') {
            for (const role of ['reader', 'persona', 'cip']) {
                const key = `almanach_tts_voice_${role}`;
                const val = localStorage.getItem(key) || '';
                if (val.startsWith('voxtral:')) {
                    localStorage.removeItem(key);
                    console.log(`[v7.4.0] Pref TTS ${role} (${val}) retirée — engine Voxtral supprimé.`);
                }
            }
            localStorage.setItem('almanach_voxtral_removal_v740', '1');
        }

        if (hwReport) hwReport.textContent = '🖥️ ' + summarize(router.hardware, router.scores);

        // v7.0.0-beta-2 : bandeau activation Supertonic 3 (pattern Voxtral, plus simple : pas de check hardware/bundle).
        const supertonicBanner = document.getElementById('supertonicActivationBanner');
        const supertonicBtn = document.getElementById('supertonicActivateBtn');
        const supertonicStatus = document.getElementById('supertonicActivationStatus');
        const supertonicEnabled = localStorage.getItem('almanach_supertonic_enabled') === '1';

        // v7.0.4 : pre-init Supertonic au boot pour masquer le cold start du 1er clic
        // (chargement ORT + 4 modèles ONNX + voice style ~5-15 s sur main thread).
        // Lancé en background via requestIdleCallback (ou setTimeout fallback Safari/Electron)
        // pour ne pas retarder le first paint.
        if (supertonicEnabled) {
            const warm = async () => {
                try {
                    const router = (await import('./tts/tts-router.js')).default;
                    // v9.14.5 : warmEngine fait désormais le warmup RÉEL du graphe WASM en interne
                    // (inférence jetable _warm, bypass cache). Voir tts-router.js warmEngine.
                    await router.warmEngine('supertonic', 'reader');
                } catch (e) {
                    console.warn('[Supertonic] pre-init au boot échec:', e?.message || e);
                }
            };
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(() => { warm(); }, { timeout: 3000 });
            } else {
                setTimeout(warm, 500);
            }
        }

        if (supertonicBanner && !supertonicEnabled) {
            supertonicBanner.classList.remove('hidden');
            // v9.19.3 : avertissement matériel calibré avant activation (usage nomade, appareil inconnu).
            const suit = supertonicSuitability(router.hardware);
            const suitWarn = document.getElementById('supertonicSuitabilityWarn');
            if (suitWarn) {
                suitWarn.textContent = suit.message;
                suitWarn.style.color = suit.level === 'weak' ? '#f43f5e' : (suit.level === 'good' ? '#22c55e' : 'inherit');
            }
            if (supertonicBtn) {
                supertonicBtn.onclick = async () => {
                    // Sur appareil modeste : confirmation explicite (le gel per-phrase peut surprendre).
                    if (suit.level === 'weak') {
                        const ok = window.confirm("Supertonic peut figer l'affichage plusieurs secondes à chaque nouvelle phrase sur cet appareil.\n\nActiver quand même ? (la voix système reste disponible et instantanée)");
                        if (!ok) return;
                    }
                    localStorage.setItem('almanach_supertonic_enabled', '1');
                    if (supertonicStatus) supertonicStatus.textContent = '✅ Supertonic 3 activé, rafraîchissement…';
                    location.reload();
                };
            }
        }

        // v7.0.3 : bouton de test des tags expressifs Supertonic.
        (function setupSupertonicExpressiveTest() {
            const enabled = localStorage.getItem('almanach_supertonic_enabled') === '1';
            const row = document.getElementById('supertonicExpressiveTestRow');
            const btn = document.getElementById('supertonicTestExpressiveBtn');
            const status = document.getElementById('supertonicTestExpressiveStatus');
            if (!row || !btn) return;
            if (enabled) row.style.display = '';
            if (!btn._wired) {
                btn._wired = true;
                btn.addEventListener('click', async () => {
                    if (btn.disabled) return;
                    btn.disabled = true;
                    if (status) status.textContent = 'Synthèse en cours…';
                    try {
                        const router = (await import('./tts/tts-router.js')).default;
                        await router.getOrInit();
                        const sample = "Bonjour ! <breath> Aujourd'hui c'est une journée formidable <laugh>. Vraiment <sigh>.";
                        // v9.10.0 : paint du spinner/statut avant la synth WASM bloquante (cf. runTestVoice).
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        await router.speakAs(sample, 'reader');
                        if (status) status.textContent = 'OK — écoutez l\'audio.';
                    } catch (e) {
                        if (status) status.textContent = 'Échec : ' + (e?.message || e);
                        if (typeof window.showErrorToast === 'function') {
                            window.showErrorToast('Test tags expressifs échoué : ' + (e?.message || e));
                        }
                    } finally {
                        btn.disabled = false;
                    }
                });
            }
        })();

        // v7.0.9 : sélecteur langue Supertonic (31 langues, persisté dans almanach_tts_lang).
        (function setupSupertonicLang() {
            const enabled = localStorage.getItem('almanach_supertonic_enabled') === '1';
            const row = document.getElementById('supertonicLangRow');
            const sel = document.getElementById('settingSupertonicLang');
            const status = document.getElementById('supertonicLangStatus');
            if (!row || !sel) return;
            if (enabled) row.style.display = '';
            const saved = (localStorage.getItem('almanach_tts_lang') || 'fr').trim();
            // Si la valeur sauvée existe dans le select, on la sélectionne ; sinon on retombe sur 'fr'.
            const opts = Array.from(sel.options).map(o => o.value);
            sel.value = opts.includes(saved) ? saved : 'fr';
            if (!sel._wired) {
                sel._wired = true;
                sel.addEventListener('change', (e) => {
                    const val = (e.target.value || 'fr').trim();
                    localStorage.setItem('almanach_tts_lang', val);
                    if (status) {
                        status.textContent = `✅ Langue ${val} sauvegardée`;
                        setTimeout(() => { if (status) status.textContent = ''; }, 2000);
                    }
                });
            }
        })();

        const allVoices = await router.listAllVoices();

        function buildOptions(sel, role) {
            const saved = localStorage.getItem(`almanach_tts_voice_${role}`) || '';
            sel.innerHTML = '<option value="">Auto (recommandé)</option>';

            // Groupes par engine
            const byEngine = { supertonic: [], piper: [], webspeech: [] };
            allVoices.forEach(v => { if (byEngine[v.engine]) byEngine[v.engine].push(v); });

            const labels = { 
                supertonic: '🚀 Supertonic 3 (neural multi, opt-in 380 MB)', 
                piper: 'Piper FR (neural local)', 
                webspeech: 'Système (Web Speech)' 
            };
            ['supertonic', 'piper', 'webspeech'].forEach(eng => {
                if (byEngine[eng].length === 0) return;
                const og = document.createElement('optgroup');
                og.label = labels[eng];
                byEngine[eng].forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v.fullId;
                    opt.textContent = v.label + (v.sizeMB ? ` (~${v.sizeMB} MB DL)` : '');
                    if (v.fullId === saved) opt.selected = true;
                    og.appendChild(opt);
                });
                sel.appendChild(og);
            });
        }

        // v6.9.5 : 3ᵉ sélecteur pour la voix de lecture (chapitres).
        const readerSel = document.getElementById('settingTtsVoiceReader');
        if (readerSel) buildOptions(readerSel, 'reader');
        buildOptions(personaSel, 'persona');
        buildOptions(cipSel, 'cip');

        async function onSelectChange(sel, role) {
            const val = sel.value;
            if (!val) { localStorage.removeItem(`almanach_tts_voice_${role}`); return; }
            localStorage.setItem(`almanach_tts_voice_${role}`, val);
            // Prepare (déclenche download Piper si besoin)
            const parsed = val.split(':');
            if (parsed[0] === 'voxtral') {
                // Aucun DL : tout est bundlé. On marque juste prêt.
                if (dlStatus) dlStatus.textContent = `✅ ${parsed[1]} prête (bundle).`;
                setTimeout(() => { if (dlStatus) dlStatus.textContent = ''; }, 3000);
                return;
            }
            if (parsed[0] === 'supertonic') {
                // v7.0.0-beta-2 : modèle ONNX déjà sur disque, mais chargement InferenceSession ~5-10s première fois.
                if (dlStatus) dlStatus.textContent = `🔄 Chargement modèle Supertonic (~10s première fois)…`;
                try {
                    await router.prepareVoice(val, null);
                    if (dlStatus) dlStatus.textContent = `✅ ${parsed[1]} prête.`;
                    setTimeout(() => { if (dlStatus) dlStatus.textContent = ''; }, 3000);
                } catch (e) {
                    if (dlStatus) dlStatus.textContent = `❌ Échec chargement Supertonic : ${e.message || e}`;
                }
                return;
            }
            if (parsed[0] === 'piper') {
                if (dlStatus) dlStatus.textContent = `📥 Téléchargement ${parsed[1]}…`;
                try {
                    await router.prepareVoice(val, (p) => {
                        if (dlStatus) dlStatus.textContent = `📥 ${parsed[1]} : ${p.percent}%`;
                    });
                    if (dlStatus) dlStatus.textContent = `✅ ${parsed[1]} prête.`;
                    setTimeout(() => { if (dlStatus) dlStatus.textContent = ''; }, 3000);
                } catch (e) {
                    if (dlStatus) dlStatus.textContent = `❌ Échec téléchargement ${parsed[1]} : ${e.message || e}`;
                }
            }
        }
        personaSel.onchange = () => onSelectChange(personaSel, 'persona');
        cipSel.onchange = () => onSelectChange(cipSel, 'cip');
        if (readerSel) readerSel.onchange = () => onSelectChange(readerSel, 'reader');

        // Refresh quand Web Speech publie ses voix tardivement
        if (window.speechSynthesis) {
            speechSynthesis.addEventListener('voiceschanged', async () => {
                // Re-fetch et rebuild
                const updated = await router.listAllVoices();
                allVoices.length = 0; allVoices.push(...updated);
                if (readerSel) buildOptions(readerSel, 'reader');
                buildOptions(personaSel, 'persona');
                buildOptions(cipSel, 'cip');
            });
        }

        // v6.9.4 : wrap test buttons avec disable pendant synth pour empêcher cumul de clics.
        // v6.9.13 : capture l'engine effectivement utilisé pour afficher un toast clair.
        async function runTestVoice(btn, otherBtn, text, role) {
            if (!btn) return;
            // Stop toute lecture en cours AVANT (annule synth pendante via token router)
            router.stop();
            const originalLabel = btn.textContent;
            btn.disabled = true;
            if (otherBtn) otherBtn.disabled = true;
            btn.textContent = '⏳ Synthèse…';
            // v9.10.0 : laisse le navigateur peindre le spinner AVANT la synth WASM (qui bloque le
            // thread principal au cold start) — sinon le label « ⏳ Synthèse… » n'apparaît qu'après
            // le freeze. Double rAF = un frame de paint garanti avant le travail bloquant.
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            // v6.9.13 : capture le dernier event done|fallback pour ce rôle.
            let lastEvent = null;
            const captureHandler = (ev) => {
                if (ev.detail && ev.detail.role === role && (ev.detail.status === 'done' || ev.detail.status === 'fallback')) {
                    lastEvent = ev.detail;
                }
            };
            window.addEventListener('tts-engine-used', captureHandler);

            try {
                await router.speakAs(text, role);
                if (!lastEvent) await new Promise(r => setTimeout(r, 100));
                if (lastEvent && lastEvent.status === 'fallback') {
                    if (typeof window.showErrorToast === 'function') {
                        window.showErrorToast(`⚠️ ${lastEvent.engine || 'Engine demandé'} a échoué — voix système (robotique) utilisée. ${lastEvent.error || ''}`);
                    }
                } else if (lastEvent && lastEvent.status === 'done') {
                    const sec = ((lastEvent.durationMs || 0) / 1000).toFixed(1);
                    const cacheTag = lastEvent.fromCache ? ', cache' : '';
                    if (typeof window.showSuccessToast === 'function') {
                        window.showSuccessToast(`✅ Lecture via ${lastEvent.engine}:${lastEvent.voice} (${sec}s${cacheTag})`);
                    }
                }
            } catch (e) {
                console.warn('Test voix échec :', e);
                if (typeof window.showErrorToast === 'function') {
                    window.showErrorToast(`Test voix échec : ${e?.message || e}`);
                }
            } finally {
                window.removeEventListener('tts-engine-used', captureHandler);
                btn.disabled = false;
                if (otherBtn) otherBtn.disabled = false;
                btn.textContent = originalLabel;
            }
        }
        const testPersona = document.getElementById('testTtsVoicePersona');
        const testCip = document.getElementById('testTtsVoiceCip');
        const testReader = document.getElementById('testTtsVoiceReader');
        if (testPersona) testPersona.onclick = () => runTestVoice(testPersona, testCip, 'Bonjour, je suis le candidat que vous accueillez aujourd\'hui.', 'persona');
        if (testCip) testCip.onclick = () => runTestVoice(testCip, testPersona, 'Bonjour, je suis votre conseiller en insertion professionnelle.', 'cip');
        if (testReader) testReader.onclick = () => runTestVoice(testReader, null, 'Ceci est un extrait de chapitre, lu à la voix sélectionnée pour le lecteur de l\'Almanach.', 'reader');

        // v7.1.0 : info cache Supertonic + bouton vider.
        const stCacheText = document.getElementById('supertonicCacheInfoText');
        const stCacheClearBtn = document.getElementById('supertonicCacheClearBtn');
        const stCacheBlock = document.getElementById('supertonicCacheInfoBlock');
        const stEnabled = localStorage.getItem('almanach_supertonic_enabled') === '1';
        async function refreshSupertonicCacheInfo() {
            if (!stCacheText || !stCacheBlock) return;
            const api = window.electronAPI;
            if (!api || typeof api.supertonicCacheInfo !== 'function') {
                stCacheBlock.style.display = 'none';
                return;
            }
            // Bloc visible uniquement si Supertonic activé.
            stCacheBlock.style.display = stEnabled ? 'flex' : 'none';
            if (!stEnabled) return;
            try {
                const info = await api.supertonicCacheInfo();
                const mb = (info.sizeBytes / (1024 * 1024)).toFixed(1);
                stCacheText.textContent = `${info.count} fichier${info.count > 1 ? 's' : ''} · ${mb} Mo`;
            } catch (e) {
                stCacheText.textContent = 'indisponible';
            }
        }
        refreshSupertonicCacheInfo();
        if (stCacheClearBtn) {
            stCacheClearBtn.onclick = async () => {
                const api = window.electronAPI;
                if (!api || typeof api.supertonicCacheClear !== 'function') return;
                stCacheClearBtn.disabled = true;
                stCacheClearBtn.textContent = '⏳ …';
                try {
                    const res = await api.supertonicCacheClear();
                    if (res.ok && typeof window.showSuccessToast === 'function') {
                        window.showSuccessToast(`Cache Supertonic vidé (${res.removed} fichier${res.removed > 1 ? 's' : ''})`);
                    }
                } catch (e) { /* ignore */ }
                stCacheClearBtn.disabled = false;
                stCacheClearBtn.textContent = '🗑️ Vider le cache';
                refreshSupertonicCacheInfo();
            };
        }

        // v6.9.6 : indicateur live — affiche l'engine effectivement utilisé.
        const engineValueSpan = document.getElementById('ttsActiveEngineValue');
        if (engineValueSpan) {
            window.addEventListener('tts-engine-used', (ev) => {
                const { role, engine, voice, status, durationMs, fromCache } = ev.detail || {};
                const emoji = engine === 'voxtral' ? '✨' : engine === 'supertonic' ? '🚀' : engine === 'piper' ? '🧠' : '📢';
                
                let text = `${emoji} ${engine}:${voice} [${role}]`;
                if (status === 'start') {
                    text += ' (synthèse…)';
                } else if (status === 'done' && durationMs !== undefined) {
                    const sec = (durationMs / 1000).toFixed(1);
                    text += ` (${sec}s${fromCache ? ', cache' : ''})`;
                } else if (status === 'fallback') {
                    text = `📢 webspeech:fallback [${role}] (échec ${engine})`;
                }
                
                engineValueSpan.textContent = text;
                engineValueSpan.style.color = status === 'fallback' ? '#f87171' : 'var(--accent)';
                
                // Optionnel : toggle une classe loading
                if (status === 'start') engineValueSpan.classList.add('loading');
                else engineValueSpan.classList.remove('loading');
            });
        }
    })();
    // ====================================================================
    const savedFont = localStorage.getItem('almanach_font_size');
    if (savedFont) document.getElementById('settingFontSize').value = savedFont;

    // --- Close Quiz Modal ---
    document.getElementById('closeQuiz').onclick = () => document.getElementById('quizModal').classList.add('hidden');

    // Clic sur le fond foncé de n'importe quelle lab-overlay = fermer
    document.querySelectorAll('.lab-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.add('hidden');
        });
    });

    console.log('[init] DOMContentLoaded END — tous les wirages sont terminés.');
});