// js/modules/stats-view.js
// v6.9.8 — Extrait de app.js (refactor incrémental, étape 1/4).
// Dépend de : window.COURSE_DATA (data.js), window.getCCPProgress (app.js, exposé via PATCH 5).
// Expose : window.showStatsView, window.hideStatsView, window.renderCcpStatsCard, window.renderDashboardStats, window.renderHistory.
(function () {
    'use strict';

    function showStatsView() {
        const statsView = document.getElementById('statsView');
        const heroEl = document.querySelector('.dashboard-hero');
        const contentGrid = document.getElementById('contentGrid');
        const dashStats = document.getElementById('dashboardStats');
        if (!statsView) return;
        statsView.classList.remove('hidden');
        if (heroEl) heroEl.classList.add('hidden');
        if (contentGrid) contentGrid.classList.add('hidden');
        if (dashStats) dashStats.classList.add('hidden');
        if (typeof renderDashboardStats === 'function') renderDashboardStats();
        if (typeof renderCcpStatsCard === 'function') renderCcpStatsCard();
        if (typeof window.pedagoRenderReadiness === 'function') window.pedagoRenderReadiness();
        document.querySelectorAll('.sidebar-stats-btn').forEach(b => b.classList.add('active'));
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function hideStatsView() {
        const statsView = document.getElementById('statsView');
        const heroEl = document.querySelector('.dashboard-hero');
        const contentGrid = document.getElementById('contentGrid');
        if (statsView) statsView.classList.add('hidden');
        if (heroEl) heroEl.classList.remove('hidden');
        if (contentGrid) contentGrid.classList.remove('hidden');
        document.querySelectorAll('.sidebar-stats-btn').forEach(b => b.classList.remove('active'));
    }

    function renderCcpStatsCard() {
        const target = document.getElementById('statsCcpProgress');
        if (!target) return;
        const getCCPProgress = window.getCCPProgress;
        if (typeof getCCPProgress !== 'function') {
            console.warn('[stats-view] window.getCCPProgress non exposé — carte CCP désactivée.');
            return;
        }
        // v9.25.1 : on dérive les lignes des données réelles (clés = valeurs de mod.ccp) au lieu
        // de libellés codés en dur qui ne matchaient plus CCP 2/3/Transversal (affichaient 0/0).
        const ccpProgress = getCCPProgress();
        const colorByNum = { '1': '#6366f1', '2': '#8b5cf6', '3': '#a78bfa' };
        const ccpNum = k => { const m = /CCP\s*(\d+)/i.exec(k); return m ? parseInt(m[1], 10) : 99; };
        const keys = Object.keys(ccpProgress).sort((a, b) => {
            const na = ccpNum(a), nb = ccpNum(b);
            return na !== nb ? na - nb : a.localeCompare(b);
        });
        target.innerHTML = '';
        keys.forEach(fullName => {
            const data = ccpProgress[fullName] || { total: 0, done: 0 };
            const pct = data.total === 0 ? 0 : Math.round((data.done / data.total) * 100);
            const m = /CCP\s*(\d+)/i.exec(fullName);
            const color = (m && colorByNum[m[1]]) || '#64748b';
            const label = m ? `CCP ${m[1]}` : fullName;
            const item = document.createElement('div');
            item.className = 'ccp-progress-item';
            item.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-weight:600; font-size:0.85rem;">${label}</span>
                    <span style="font-weight:700; color:${color}; font-size:0.95rem;">${pct}%</span>
                </div>
                <div class="progress-bar-bg" style="height:6px; border-radius:3px;">
                    <div class="progress-bar-fill" style="width:${pct}%; background:${color}; height:100%; border-radius:3px;"></div>
                </div>
                <div style="font-size:0.72rem; opacity:0.6; margin-top:6px;">${data.done}/${data.total} chapitres</div>
            `;
            target.appendChild(item);
        });
    }

    function renderDashboardStats() {
        const statsEl = document.getElementById('dashboardStats');
        if (!statsEl) return;
        statsEl.classList.remove('hidden');

        // Heatmap 30 jours
        const heatmap = document.getElementById('activityHeatmap');
        const activity = JSON.parse(localStorage.getItem('almanach_activity') || '{}');
        if (heatmap) {
            heatmap.innerHTML = '';
            for (let i = 29; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const key = d.toISOString().slice(0, 10);
                const count = activity[key] || 0;
                const lvl = count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : count < 10 ? 3 : 4;
                const cell = document.createElement('div');
                cell.className = `activity-cell ${lvl ? 'lvl-' + lvl : ''}`;
                cell.title = `${key} : ${count} document(s) lus`;
                heatmap.appendChild(cell);
            }
        }

        // Top 3 quiz ratés
        const quizReview = document.getElementById('quizToReview');
        if (quizReview) {
            const history = JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]');
            const failed = history.filter(q => q.score / q.total < 0.5).slice(-3).reverse();
            quizReview.innerHTML = failed.length
                ? failed.map(q => `<div class="quiz-review-item"><span>${q.theme || 'Quiz'}</span><span class="pp">${q.score}/${q.total}</span></div>`).join('')
                : '<div style="opacity:0.5; font-size:0.8rem;">Aucun quiz à revoir 🎉</div>';
        }

        // Progression par module (top 5 in-progress)
        const modulesEl = document.getElementById('modulesProgress');
        if (modulesEl) {
            const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
            const modStats = (window.COURSE_DATA?.modules || []).map(mod => {
                const subs = mod.sub_modules || [];
                const total = subs.length;
                const done = subs.filter(s => completed.includes(s.name)).length;
                return { name: (mod.name.split('-')[1] || mod.name).trim(), done, total, pct: total ? Math.round(done / total * 100) : 0 };
            }).filter(m => m.total > 0 && m.done < m.total).sort((a, b) => b.pct - a.pct).slice(0, 5);
            modulesEl.innerHTML = modStats.length
                ? modStats.map(m => `<div class="module-progress-item"><span>${m.name}</span><span class="pp">${m.done}/${m.total} · ${m.pct}%</span></div>`).join('')
                : '<div style="opacity:0.5; font-size:0.8rem;">Tous les modules sont complets 🏆</div>';
        }
    }

    // v9.10.0 : renderHistory déplacé depuis app.js (modale Historique — mêmes données
    // activité + historique quiz que le dashboard).
    function renderHistory() {
        const list = document.getElementById('historyList');
        if (!list) throw new Error('historyList introuvable');

        const activity = JSON.parse(localStorage.getItem('almanach_activity') || '{}');
        const quizHistory = JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]');

        // 7 derniers jours triés du plus récent au plus ancien
        const last7Dates = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            last7Dates.push(d.toISOString().slice(0, 10));
        }
        const activityRows = last7Dates
            .map(date => {
                const count = activity[date] || 0;
                const label = (date === last7Dates[0]) ? "Aujourd'hui"
                            : (date === last7Dates[1]) ? 'Hier'
                            : new Date(date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' });
                const opacity = count > 0 ? '1' : '0.4';
                return `<div style="display:flex; justify-content:space-between; padding:8px 12px; background:rgba(255,255,255,0.05); border-radius:8px; opacity:${opacity};">
                            <span style="text-transform:capitalize;">${label}</span>
                            <span style="color:var(--accent); font-weight:600;">${count > 0 ? count + ' lecture' + (count > 1 ? 's' : '') : '—'}</span>
                        </div>`;
            }).join('');

        const quizRows = quizHistory.slice(0, 10).map(q => {
            const pct = q.total ? Math.round((q.score / q.total) * 100) : 0;
            const color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#f43f5e';
            return `<div style="display:flex; justify-content:space-between; padding:8px 12px; background:rgba(255,255,255,0.05); border-radius:8px;">
                        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${q.module || 'Quiz'}</span>
                        <span style="opacity:0.6; font-size:0.8rem; margin:0 10px;">${q.date || ''}</span>
                        <span style="color:${color}; font-weight:600;">${q.score}/${q.total}</span>
                    </div>`;
        }).join('');

        list.innerHTML = `
            <h4 style="margin:0 0 8px; font-size:0.9rem; color:var(--accent); opacity:0.85;">📅 7 derniers jours</h4>
            ${activityRows}
            <h4 style="margin:14px 0 8px; font-size:0.9rem; color:var(--accent); opacity:0.85;">🎯 Tentatives quiz récentes</h4>
            ${quizHistory.length > 0
                ? quizRows
                : '<div style="opacity:0.5; font-size:0.85rem; padding:10px; text-align:center;">Aucun quiz tenté pour le moment.</div>'}
        `;
    }

    // Exposition globale (rétrocompat des call-sites dans app.js).
    window.showStatsView = showStatsView;
    window.hideStatsView = hideStatsView;
    window.renderCcpStatsCard = renderCcpStatsCard;
    window.renderDashboardStats = renderDashboardStats;
    window.renderHistory = renderHistory;

    // Namespace optionnel.
    window.Almanach = window.Almanach || {};
    window.Almanach.stats = {
        showView: showStatsView,
        hideView: hideStatsView,
        renderCcpCard: renderCcpStatsCard,
        renderDashboard: renderDashboardStats,
    };
})();
