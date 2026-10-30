#!/usr/bin/env node
// Garde-fou des chemins statiques. Deux pièges maison, tous deux déjà survenus :
//
//  1. `cache.addAll(STATIC_ASSETS)` est ATOMIQUE : un seul chemin en 404 fait échouer
//     l'installation entière du Service Worker, et l'erreur n'apparaît que dans l'onglet
//     Application des devtools — jamais dans la Console. L'app perd son mode hors-ligne
//     sans le moindre signal.
//  2. Un fichier peut exister sur DISQUE et ne pas être SUIVI par git : le motif
//     `*MODULE*/` du .gitignore a avalé `js/modules/` (7 modules de code) à cause de
//     core.ignorecase sous Windows, rendant le dépôt public non-buildable pendant des
//     semaines sans que rien ne le signale en local.
//
// On vérifie donc les deux propriétés — présence ET suivi git — pour les assets du
// Service Worker et pour les <script src> / <link href> de index.html.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
);

function normalize(ref) {
  return ref.replace(/^\.\//, '').replace(/^\//, '').split('?')[0].split('#')[0];
}

function isExternal(ref) {
  return /^(https?:|data:|blob:|mailto:|#)/.test(ref);
}

function staticAssets() {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf-8');
  const block = sw.match(/STATIC_ASSETS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error('STATIC_ASSETS introuvable dans sw.js');
  return [...block[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]);
}

function indexRefs() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
}

const problems = [];
let checked = 0;

for (const [origine, refs] of [['sw.js STATIC_ASSETS', staticAssets()], ['index.html', indexRefs()]]) {
  for (const ref of refs) {
    if (!ref || isExternal(ref)) continue;
    const rel = normalize(ref);
    if (!rel) continue;
    checked++;
    if (!fs.existsSync(path.join(ROOT, rel))) {
      problems.push(`❌ ${origine} → « ${ref} » : absent du disque (cache.addAll échouera en bloc)`);
    } else if (!tracked.has(rel)) {
      problems.push(`❌ ${origine} → « ${ref} » : présent en local mais NON SUIVI par git (clone frais cassé — vérifier .gitignore)`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n❌ Assets : ${problems.length} problème(s) sur ${checked} chemins.`);
  process.exit(1);
}

console.log(`✅ Assets OK — ${checked} chemins présents et suivis par git.`);
