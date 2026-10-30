#!/usr/bin/env node
// Vérifie l'intégrité données↔images. Exit 1 en cas de problème.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'js', 'data.js');
const ASSETS = path.join(ROOT, 'assets');

const errors = [];
const warnings = [];

// Charger data.js (extraction brutale du JSON COURSE_DATA)
let src;
try {
    src = fs.readFileSync(DATA_PATH, 'utf-8');
} catch (e) {
    console.error(`❌ Impossible de lire ${DATA_PATH}`);
    process.exit(1);
}

const match = src.match(/(?:const|window\.)?\s*COURSE_DATA\s*=\s*(\{[\s\S]*?\});\s*$/m)
    || src.match(/(?:const|window\.)?\s*COURSE_DATA\s*=\s*(\{[\s\S]*\})/);
if (!match) {
    console.error('❌ Impossible de parser COURSE_DATA dans js/data.js');
    process.exit(1);
}

let courseData;
try {
    courseData = eval('(' + match[1] + ')');
} catch (e) {
    console.error('❌ Erreur de parsing JS dans COURSE_DATA');
    process.exit(1);
}

// Helper : extraire le numéro de module
function getModuleKey(name) {
    if (name === 'Programme') return 'prog';
    const num = name.match(/\d+/);
    return num ? num[0] : 'prog';
}

// 1) Unicité du numéro de module
const seen = new Map();
courseData.modules.forEach(mod => {
    const key = getModuleKey(mod.name);
    if (seen.has(key)) {
        errors.push(`Module key "${key}" dupliqué : "${seen.get(key)}" et "${mod.name}"`);
    } else {
        seen.set(key, mod.name);
    }
});

// 2) Image module présente
courseData.modules.forEach(mod => {
    const key = getModuleKey(mod.name);
    const img = path.join(ASSETS, 'modules', `${key}.png`);
    if (!fs.existsSync(img)) {
        warnings.push(`Image module manquante : assets/modules/${key}.png  (${mod.name})`);
    }
});

// 3) Image sub_module présente
courseData.modules.forEach(mod => {
    const key = getModuleKey(mod.name);
    (mod.sub_modules || []).forEach((sub, i) => {
        const img = path.join(ASSETS, 'sub-modules', `${key}-${i}.png`);
        if (!fs.existsSync(img)) {
            warnings.push(`Image sub-module manquante : assets/sub-modules/${key}-${i}.png  (${mod.name} → ${sub.name})`);
        }
    });
});

// 4) Images orphelines
if (fs.existsSync(path.join(ASSETS, 'modules'))) {
    const expectedModuleImgs = new Set(courseData.modules.map(m => `${getModuleKey(m.name)}.png`));
    fs.readdirSync(path.join(ASSETS, 'modules')).forEach(f => {
        if (f.endsWith('.png') && !expectedModuleImgs.has(f)) {
            warnings.push(`Image module orpheline : assets/modules/${f}`);
        }
    });
}

if (fs.existsSync(path.join(ASSETS, 'sub-modules'))) {
    const expectedSubImgs = new Set();
    courseData.modules.forEach(mod => {
        const key = getModuleKey(mod.name);
        (mod.sub_modules || []).forEach((_, i) => expectedSubImgs.add(`${key}-${i}.png`));
    });
    fs.readdirSync(path.join(ASSETS, 'sub-modules')).forEach(f => {
        if (f.endsWith('.png') && !expectedSubImgs.has(f)) {
            warnings.push(`Image sub-module orpheline : assets/sub-modules/${f}`);
        }
    });
}

// Rapport
console.log(`\n📋 Vérification intégrité L'Almanach du CIP\n`);
console.log(`   Modules : ${courseData.modules.length}`);
console.log(`   Sous-modules : ${courseData.modules.reduce((n, m) => n + (m.sub_modules?.length || 0), 0)}\n`);

if (warnings.length) {
    console.log(`⚠️  ${warnings.length} avertissement(s) :`);
    warnings.forEach(w => console.log(`   · ${w}`));
    console.log();
}
if (errors.length) {
    console.log(`❌ ${errors.length} erreur(s) bloquante(s) :`);
    errors.forEach(e => console.log(`   · ${e}`));
    console.log();
    process.exit(1);
}
console.log(`✅ Intégrité OK\n`);
