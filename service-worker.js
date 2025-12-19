const CACHE_NAME = 'dragon-keep-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './src/css/styles.css',
    './src/js/script.js',
    './manifest.json',
    './icons/icon-512.png',
    './sounds/Dragon Valley Ambience.mp3',
    './sounds/Sleeping Dragon.mp3',
    './sounds/Relaxing Rain Sounds = Drifting to Sleep 😴-256x144-avc1-opus.mp3',
    './sounds/Fireplace.mp3',
    'https://cdn.tailwindcss.com',
    'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                return cache.addAll(ASSETS_TO_CACHE);
            })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                return response || fetch(event.request);
            })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});
