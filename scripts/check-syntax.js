#!/usr/bin/env node
// Garde-fou syntaxe : `node --check` sur tous les .js/.mjs suivis par git.
//
// Deux subtilités, sans lesquelles ce script est inutilisable :
//  1. `js/lib/` est du code VENDORÉ (ONNX Runtime Web, Piper) : ce n'est pas notre
//     code, il est minifié et on ne le corrigera pas — on l'exclut.
//  2. `package.json` déclare `"type": "commonjs"`, donc `node --check` refuse les 10
//     fichiers de `js/tts/` avec « Cannot use import statement outside a module ».
//     Ce sont de vrais modules ES chargés en <script type="module"> : on les détecte
//     sur la présence d'un import/export en tête de ligne et on les vérifie avec
//     `--input-type=module`. Sans ça, la CI serait rouge sur du code parfaitement sain.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = [/^js\/lib\//];
const ESM_RE = /^[ \t]*(import|export)[ \t{*\n]/m;

const files = execFileSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: ROOT, encoding: 'utf-8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => !SKIP.some((re) => re.test(f)));

let esm = 0;
let cjs = 0;
const failures = [];

for (const rel of files) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  const isEsm = ESM_RE.test(source);
  const args = isEsm ? ['--input-type=module', '--check'] : ['--check'];
  try {
    execFileSync(process.execPath, args, { input: source, stdio: ['pipe', 'ignore', 'pipe'] });
    isEsm ? esm++ : cjs++;
  } catch (err) {
    const detail = String(err.stderr || '').trim().split('\n').slice(0, 5).join('\n');
    failures.push(`❌ ${rel} (${isEsm ? 'module ES' : 'CommonJS'})\n${detail}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  console.error(`\n❌ Syntaxe : ${failures.length} fichier(s) en échec sur ${files.length}.`);
  process.exit(1);
}

console.log(`✅ Syntaxe OK — ${files.length} fichiers (${cjs} CommonJS, ${esm} modules ES).`);
