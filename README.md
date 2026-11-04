# L'Almanach du CIP

**Plateforme d'apprentissage autonome et 100 % hors ligne, conçue pour la formation CIP** (Conseiller·ère en Insertion Professionnelle).

Application **Electron** (desktop) + **PWA** (web) qui réunit un lecteur de cours, un moteur de quiz et d'examen blanc, des flashcards à répétition espacée, des mises en situation et une synthèse vocale, le tout sans connexion.

> 🚧 **Projet en cours de développement** : l'application n'est pas terminée, des fonctions peuvent encore changer ou manquer.
>
> Projet **non commercial / gratuit**. Voir [LICENSE](./LICENSE).

**🌐 Démo en ligne : https://alnakouri.github.io/L-Almanach-du-CIP/**

## 🎭 Ce dépôt contient un contenu fictif

Les vrais supports de formation sont confidentiels : ils ne sont pas dans ce dépôt, ni aucun texte qui en dérive. Pour montrer l'application, tout le contenu a été **inventé** : la Maison Horizon, la ville de Valbourg, Nadia, Inès et Karim n'existent pas. Seul le cadre public du titre professionnel (blocs CCP, compétences RNCP) est réel.

Dans la démo web, chapitres, quiz, examen blanc, flashcards, mises en situation, glossaire et recherche fonctionnent. L'assistant IA n'existe que dans l'application de bureau : son modèle n'est pas publié, et le chat répond alors par recherche locale.

---

## ✨ Fonctionnalités

- **Lecteur « Article Mode »** avec synthèse vocale karaoké (surlignage synchronisé).
- **Assistant IA local** (application de bureau) : Qwen 2.5 1.5B fine-tuné, RAG lexical (MiniSearch).
- **Quiz & Examen blanc** : QCM chronométrés, restitution par CCP, notes /20.
- **Flashcards SM2** (répétition espacée) avec auto-correction par mots-clés.
- **Mises en situation** interactives à embranchements, voix multi-personnages.
- **Coach** : ciblage de la compétence la plus faible (Elo par compétence).
- **Suivi** : streak, heatmap d'activité, achievements, statistiques par CCP, export JSON/PDF.
- **3 moteurs TTS** : Web Speech, Piper FR, Supertonic 3.

## 🧱 Stack technique

- **Electron** 44 + **PWA** (Service Worker, cache hors ligne).
- **IA** : `@huggingface/transformers` (transformers.js) + ONNX Runtime, inférence dans un `utilityProcess` dédié.
- **RAG** : MiniSearch (lexical pur, offline) + vault auto-construit.
- **TTS** : ONNX Runtime Web vendored (`js/lib/onnx/`), Piper vendored (`js/lib/piper/`), Supertonic 3.
- Aucune dépendance cloud à l'exécution.

## 🚀 Démarrage (développement)

Prérequis : **Node.js 22.12+** et **pnpm 11** (version figée par le champ `packageManager`
de `package.json` ; `corepack enable` installe la bonne).

```bash
pnpm install
pnpm start        # lance l'app Electron
```

> Côté chaîne d'approvisionnement, `allowBuilds` (`pnpm-workspace.yaml`) n'autorise aucun
> script d'installation de dépendance, et la CI installe avec `pnpm install --frozen-lockfile` :
> un lockfile désynchronisé fait échouer le build. Electron télécharge son binaire au
> premier lancement.

### ⚠️ Modèles IA / TTS (non inclus dans le dépôt)

Les modèles lourds sont **exclus du dépôt** (limite GitHub de 100 Mo par fichier). Sans eux, l'app démarre mais l'assistant IA et les voix Supertonic et Piper restent indisponibles : la lecture passe par Web Speech, la voix du système, et le reste fonctionne.

## 🛠️ Commandes

| Commande | Rôle |
|---|---|
| `pnpm start` | Lance l'application en développement |
| `pnpm run check` | Vérifie l'intégrité des données et des images |
| `pnpm run build-rag` | Régénère l'index RAG des chapitres (`data/rag-index.json`) |
| `pnpm run build-vault` | Régénère le vault (`data/vault-index.json`) |
| `pnpm run package` | Build Windows (@electron/packager), précédé de `check:all` |

### Ajouter ses propres notes au RAG

Déposez des fichiers Markdown dans `data/vault/*.md` (frontmatter `title` / `tags` optionnel), puis lancez `pnpm run build-vault`. Les fichiers dont le nom commence par `_` sont ignorés.

## 📁 Structure

```
index.html            Structure de l'app (sidebar, dashboard, lecteur, modales)
main.js / preload.js  Process principal Electron + pont IPC
ai-worker.js          Inférence IA (utilityProcess dédié)
js/
  app.js              Logique principale (navigation, progression, wiring)
  ai-helper.js        Assistant IA + RAG (buildRagContext)
  data.js             Structure des cours (modules, CCP, glossaire)
  modules/            Modules extraits (reader, simulation, quiz-engine, coach, stats…)
  tts/                Architecture TTS pluggable (router + 3 engines)
data/                 Chapitres, quiz, scénarios, vault, index RAG (contenu fictif)
scripts/              Build des index + vérification d'intégrité
sw.js                 Service Worker (cache hors ligne)
```

## ✅ Vérifications

```bash
pnpm run check:all
```

Rejoue en local ce que fait la CI (`.github/workflows/ci.yml`) sur chaque push et chaque
pull request vers `main` :

| Contrôle | Ce qu'il empêche |
|---|---|
| `pnpm install --frozen-lockfile` | un `package.json` modifié sans régénérer le lockfile, ou un script d'installation non tranché dans `allowBuilds` |
| `check:syntax` | un fichier livré qui ne parse pas (CommonJS et modules ES gérés séparément) |
| `check:assets` | un chemin du Service Worker en 404 (`cache.addAll` est atomique et échoue en silence) ou un fichier présent en local mais non suivi par git |
| `check:release` | un bump de version oublié dans l'un des cinq endroits (dont les cache-busters `?v=` de `index.html`) |
| `check` | une incohérence entre `js/data.js` et les images/contenus |
| dérive de l'index vault | un `data/vault-index.json` périmé face à ses sources |
| `pnpm audit` | une nouvelle faille haute dans les dépendances |

## 📄 Licence

Usage **non commercial** uniquement. Voir [LICENSE](./LICENSE).
