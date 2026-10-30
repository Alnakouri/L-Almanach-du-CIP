// Packaging Electron avec clauses d'exclusion (v9.27.0).
// Remplace l'appel CLI direct : les exclusions en regex dans package.json
// étaient illisibles (double échappement JSON + séparateurs Windows).
//
// Exclusions : .git (~178 Mo), node_modules/onnxruntime-web (~68 Mo — le
// renderer consomme le vendored js/lib/onnx/ et transformers.js démarre
// sans ce paquet, vérifié), docs internes, scripts de build, lanceurs dev.
//
// ⚠️ Les dossiers de cours "N MODULE - ..." à la racine sont du contenu
// RUNTIME (référencés par js/data.js) : ne JAMAIS les exclure.
import { packager } from '@electron/packager';

const EXCLUDES = [
  /^\/\.git(\/|$)/,
  /^\/\.gitignore$/,
  /^\/\.gitattributes$/,
  /^\/\.github(\/|$)/,
  /^\/CLAUDE\.md$/,
  /^\/PLAN_EXECUTION\.md$/,
  /^\/prochaine feature\.md$/,
  /^\/scripts(\/|$)/,
  /^\/download_model\.py$/,
  /^\/convert-icon\.js$/,
  /^\/Almanach_CIP\.vbs$/,
  /^\/Lancer_Almanach\.bat$/,
  /^\/node_modules\/onnxruntime-web(\/|$)/,
];

packager({
  dir: '.',
  name: 'AlmanachCIP',
  platform: 'win32',
  arch: 'x64',
  out: 'dist',
  overwrite: true,
  icon: 'assets/icon-512.ico',
  ignore: (filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    return EXCLUDES.some((re) => re.test(normalized));
  },
}).then((paths) => {
  console.log('✅ Package créé :', paths.join(', '));
}).catch((err) => {
  console.error('❌ Packaging échoué :', err);
  process.exit(1);
});
