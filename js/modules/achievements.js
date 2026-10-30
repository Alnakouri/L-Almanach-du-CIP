// js/modules/achievements.js
// v6.9.8 — Extrait de app.js (refactor incrémental, étape 1/4).
// Dépend de : window.COURSE_DATA (chargé via data.js AVANT ce fichier).
// Expose : window.ACHIEVEMENTS, window.checkAchievements, window.showAchievementToast.
(function () {
    'use strict';

    const ACHIEVEMENTS = [
        { id: 'first-step', icon: '🏁', name: 'Premier pas', desc: 'Ouvrir un premier document', check: () => (JSON.parse(localStorage.getItem('completed_docs') || '[]')).length >= 1 },
        { id: 'reader-50',  icon: '📖', name: 'Lecteur assidu', desc: '50 documents lus', check: () => (JSON.parse(localStorage.getItem('completed_docs') || '[]')).length >= 50 },
        { id: 'streak-7',   icon: '🔥', name: 'Série de 7', desc: '7 jours d\'affilée', check: () => parseInt(localStorage.getItem('almanach_streak') || '0') >= 7 },
        { id: 'streak-30',  icon: '🚀', name: 'Marathon', desc: '30 jours d\'affilée', check: () => parseInt(localStorage.getItem('almanach_streak') || '0') >= 30 },
        { id: 'streak-90',  icon: '💎', name: 'Immortel', desc: '90 jours d\'affilée', check: () => parseInt(localStorage.getItem('almanach_streak') || '0') >= 90 },
        { id: 'quiz-perfect', icon: '🎯', name: 'Sans-faute', desc: 'Premier quiz 100%', check: () => {
            const h = JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]');
            return h.some(q => q.score === q.total && q.total > 0);
        }},
        { id: 'quiz-10', icon: '✅', name: 'Quizzeur', desc: '10 quiz complétés', check: () => (JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]')).length >= 10 },
        { id: 'quiz-5perfect', icon: '🌟', name: 'Excellence', desc: '5 quiz à 100%', check: () => {
            const h = JSON.parse(localStorage.getItem('almanach_quiz_history') || '[]');
            return h.filter(q => q.score === q.total && q.total > 0).length >= 5;
        }},
        { id: 'flash-50',   icon: '🧠', name: 'Maître flashcards', desc: '50 flashcards révisées', check: () => {
            const cards = Object.keys(localStorage).filter(k => k.startsWith('sm2_'));
            return cards.length >= 50;
        }},
        { id: 'flash-200',  icon: '🧪', name: 'Maître mental', desc: '200 flashcards révisées', check: () => Object.keys(localStorage).filter(k => k.startsWith('sm2_')).length >= 200 },
        { id: 'mod-complete', icon: '🏆', name: 'Module complet', desc: 'Premier module à 100%', check: () => {
            const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
            return (window.COURSE_DATA?.modules || []).some(mod => {
                const subs = mod.sub_modules || [];
                return subs.length > 0 && subs.every(s => completed.includes(s.name));
            });
        }},
        { id: 'mod-5', icon: '🥉', name: 'Bronze', desc: '5 modules à 100%', check: () => {
            const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
            const mods = window.COURSE_DATA?.modules || [];
            return mods.filter(m => (m.sub_modules || []).length > 0 && (m.sub_modules || []).every(s => completed.includes(s.name))).length >= 5;
        }},
        { id: 'mod-10', icon: '🥈', name: 'Argent', desc: '10 modules à 100%', check: () => {
            const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
            const mods = window.COURSE_DATA?.modules || [];
            return mods.filter(m => (m.sub_modules || []).length > 0 && (m.sub_modules || []).every(s => completed.includes(s.name))).length >= 10;
        }},
        { id: 'mod-15', icon: '🥇', name: 'Or', desc: '15 modules à 100%', check: () => {
            const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
            const mods = window.COURSE_DATA?.modules || [];
            return mods.filter(m => (m.sub_modules || []).length > 0 && (m.sub_modules || []).every(s => completed.includes(s.name))).length >= 15;
        }},
        { id: 'all-mods',   icon: '👑', name: 'Légende CIP', desc: 'Tous les modules à 100%', check: () => {
            const completed = JSON.parse(localStorage.getItem('completed_docs') || '[]');
            const mods = window.COURSE_DATA?.modules || [];
            return mods.length > 0 && mods.every(mod => (mod.sub_modules || []).length === 0 || (mod.sub_modules || []).every(s => completed.includes(s.name)));
        }},
        { id: 'note-taker', icon: '📝', name: 'Preneur de notes', desc: '20 chapitres avec notes', check: () => Object.keys(localStorage).filter(k => (k.startsWith('note_') || k.startsWith('reflection_')) && (localStorage.getItem(k) || '').length > 50).length >= 20 },
        { id: 'ai-friend', icon: '🤖', name: 'Apprenti IA', desc: 'Charger l\'IA pour la 1ère fois', check: () => localStorage.getItem('almanach_ai_installed') === 'true' },
        { id: 'simulator', icon: '🎭', name: 'Acteur', desc: 'Compléter 3 simulations', check: () => parseInt(localStorage.getItem('almanach_sim_done') || '0') >= 3 },
    ];

    function checkAchievements() {
        const unlocked = JSON.parse(localStorage.getItem('almanach_achievements') || '[]');
        const newly = [];
        ACHIEVEMENTS.forEach(a => {
            if (!unlocked.includes(a.id) && a.check()) {
                unlocked.push(a.id);
                newly.push(a);
            }
        });
        localStorage.setItem('almanach_achievements', JSON.stringify(unlocked));
        newly.forEach(a => showAchievementToast(a));
        return unlocked;
    }

    function showAchievementToast(achievement) {
        const toast = document.createElement('div');
        toast.className = 'achievement-toast';
        toast.innerHTML = `
            <div class="achievement-toast-icon">${achievement.icon}</div>
            <div>
                <div class="achievement-toast-title">Badge débloqué !</div>
                <div class="achievement-toast-name">${achievement.name}</div>
                <div class="achievement-toast-desc">${achievement.desc}</div>
            </div>`;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('is-visible'), 50);
        setTimeout(() => {
            toast.classList.remove('is-visible');
            setTimeout(() => toast.remove(), 400);
        }, 4500);
    }

    // Exposition globale (rétrocompat des call-sites dans app.js).
    window.ACHIEVEMENTS = ACHIEVEMENTS;
    window.checkAchievements = checkAchievements;
    window.showAchievementToast = showAchievementToast;

    // Namespace optionnel pour usage futur.
    window.Almanach = window.Almanach || {};
    window.Almanach.achievements = { ACHIEVEMENTS, check: checkAchievements, showToast: showAchievementToast };
})();
