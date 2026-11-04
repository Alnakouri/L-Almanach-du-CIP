const CACHE_NAME = 'almanach-cip-v19-60';
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './css/fonts/outfit.css',
  './css/fonts/outfit-300.ttf',
  './css/fonts/outfit-400.ttf',
  './css/fonts/outfit-600.ttf',
  './css/fonts/outfit-800.ttf',
  './js/lib/minisearch.min.js',
  './js/lib/jspdf.umd.min.js',
  './js/lib/marked.min.js',
  './js/lib/onnx/ort.min.js',
  './js/lib/onnx/ort.min.mjs',
  './js/lib/onnx/ort-wasm-simd-threaded.mjs',
  './js/lib/onnx/ort-wasm-simd-threaded.jsep.mjs',
  './js/lib/onnx/ort-wasm-simd-threaded.wasm',
  './js/lib/onnx/ort-wasm-simd-threaded.jsep.wasm',
  './js/tts/engine-interface.js',
  './js/tts/voice-catalog.js',
  './js/tts/hardware-detector.js',
  './js/tts/tts-router.js',
  './js/tts/engines/web-speech-engine.js',
  './js/tts/engines/piper-engine.js',
  './js/tts/engines/supertonic-engine.js',
  './js/tts/engines/supertonic-helper.js',
  './js/tts/utils/sentence-segmenter.js',
  './js/tts/utils/wav-trim.js',
  './js/lib/piper/piper-tts-web.js',
  './js/lib/piper/piper-o91UDS6e.js',
  './js/lib/piper/voices_static-D_OtJDHM.js',
  './js/lib/piper/piper_phonemize.js',
  './js/lib/piper/piper_phonemize.wasm',
  './js/lib/piper/piper_phonemize.data',
  './js/app.js',
  './js/data.js',
  './js/ai-helper.js',
  './js/modules/achievements.js',
  './js/modules/stats-view.js',
  './js/modules/simulation.js',
  './js/modules/exam.js',
  './js/modules/reader.js',
  './js/modules/coach.js',
  './js/modules/pedago.js',
  './js/modules/quiz-engine.js',
  './data/scenarios.json',
  './data/quizzes.json',
  './data/vault-index.json',
  './assets/themes/metier.png',
  './assets/themes/accompagnement.png',
  './assets/themes/pedagogie.png',
  './assets/themes/entreprise.png',
  './assets/themes/technique.png',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

// Install: Cache static assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: Clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    })
  );
  self.clients.claim();
});

// Fetch: Cache-First + mise en cache dynamique des images
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (url.pathname.endsWith('.json')) {
    // Stale-While-Revalidate pour les JSON
    e.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(e.request).then((response) => {
          const fetchPromise = fetch(e.request).then((networkResponse) => {
            cache.put(e.request, networkResponse.clone());
            return networkResponse;
          });
          return response || fetchPromise;
        });
      })
    );
  } else {
    // Cache-First + caching dynamique pour les images et assets
    e.respondWith(
      caches.match(e.request).then((res) => {
        if (res) return res;
        return fetch(e.request).then((networkRes) => {
          // Mettre en cache les images des modules, sous-modules et scénarios
          const isSupertonicLocal = url.pathname.includes('/assets/models/supertonic/');

          if (
              url.pathname.includes('/assets/modules/') ||
              url.pathname.includes('/assets/sub-modules/') ||
              url.pathname.includes('/assets/scenarios/') ||
              url.pathname.includes('/assets/themes/') ||
              isSupertonicLocal
          ) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return networkRes;
        });
      })
    );
  }
});
