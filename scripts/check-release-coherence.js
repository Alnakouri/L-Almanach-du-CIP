#!/usr/bin/env node
// Garde-fou de release. Le bump de `CACHE_NAME` dans sw.js est LE truc qu'un plan
// exécuté par un agent saute systématiquement : l'app se met à jour, les navigateurs
// et le bundle continuent de servir l'ancien cache, et le bug rapporté est
// incompréhensible parce que le code sur disque est correct.
//
// On prend l'en-tête de CLAUDE.md comme source de vérité unique — c'est la ligne que
// l'humain relit de toute façon — et on vérifie que les autres endroits la
// suivent : la version npm, le CIP_BUILD affiché dans l'app, le nom du cache SW,
// la majeure Electron déclarée en devDependencies, et les cache-busters de index.html.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf-8');

const entete = read('CLAUDE.md').match(
  /^- \*\*Version\*\* : ([\d.]+) \(Mastery Edition (v[\d.]+)\) \| Electron ([\d.]+) \| Cache SW (v[\d-]+)/m
);
if (!entete) {
  console.error("❌ CLAUDE.md : ligne « - **Version** : X (Mastery Edition vY) | Electron Z | Cache SW vN » introuvable ou reformatée.");
  process.exit(1);
}
const [, versionRef, buildRef, electronRef, cacheRef] = entete;

const trouve = {
  'package.json → version': JSON.parse(read('package.json')).version,
  'js/app.js → CIP_BUILD': (read('js/app.js').match(/window\.CIP_BUILD\s*=\s*'([^']+)'/) || [])[1],
  'sw.js → CACHE_NAME': (read('sw.js').match(/CACHE_NAME\s*=\s*'almanach-cip-([^']+)'/) || [])[1],
};
const electronRange = JSON.parse(read('package.json')).devDependencies.electron || '';

const attendu = {
  'package.json → version': versionRef,
  'js/app.js → CIP_BUILD': buildRef,
  'sw.js → CACHE_NAME': cacheRef,
};

const ecarts = [];
for (const [ou, valeur] of Object.entries(trouve)) {
  if (valeur !== attendu[ou]) {
    ecarts.push(`❌ ${ou} = « ${valeur} » — CLAUDE.md annonce « ${attendu[ou]} »`);
  }
}
// Cinquième endroit à bumper, et le seul que rien ne vérifiait : le cache-buster
// `?v=` de index.html. CACHE_NAME peut être bumpé correctement pendant que le
// renderer continue de servir un app.js périmé depuis son cache HTTP. Oubli
// constaté à la v9.31.0 (build v9.31.0 affiché, scripts servis en ?v=9.30.1).
const busterRef = buildRef.replace(/^v/, '');
const busters = [...read('index.html').matchAll(/([^\s"']+)\?v=([\d.]+)/g)];
if (!busters.length) {
  ecarts.push('❌ index.html : aucun cache-buster ?v= trouvé — balises reformatées ?');
}
for (const [, ressource, version] of busters) {
  if (version !== busterRef) {
    ecarts.push(`❌ index.html → ${ressource}?v=${version} — CIP_BUILD annonce ${busterRef}`);
  }
}

if (!electronRange.includes(electronRef.split('.')[0])) {
  ecarts.push(`❌ package.json → devDependencies.electron = « ${electronRange} » — CLAUDE.md annonce Electron ${electronRef}`);
}

if (ecarts.length) {
  console.error(ecarts.join('\n'));
  console.error('\n❌ Release incohérente : bumper les 5 endroits ensemble (CLAUDE.md fait foi).');
  process.exit(1);
}

console.log(`✅ Release cohérente — ${versionRef} / ${buildRef} / cache ${cacheRef} / Electron ${electronRef} / ${busters.length} cache-busters.`);
