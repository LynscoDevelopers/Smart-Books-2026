/* Smart Books — Service Worker */
const CACHE_NAME = 'smartbooks-v1';
const CORE_ASSETS = [
    './',
    './index.html'
];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.all(CORE_ASSETS.map(url =>
                cache.add(url).catch(() => { })
            ))
        )
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Never intercept Firebase
    if (url.hostname.endsWith('firebaseio.com') ||
        url.hostname.endsWith('firebaseapp.com') ||
        url.hostname.includes('identitytoolkit') ||
        url.protocol === 'ws:' || url.protocol === 'wss:') {
        return;
    }

    // Same-origin: cache-first, refresh in background
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(req).then(cached => {
                const network = fetch(req).then(res => {
                    if (res && res.status === 200 && res.type === 'basic') {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(c => c.put(req, clone));
                    }
                    return res;
                }).catch(() => cached);
                return cached || network;
            })
        );
        return;
    }

    // Cross-origin (fonts, CDN): stale-while-revalidate
    event.respondWith(
        caches.match(req).then(cached => {
            const network = fetch(req).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(req, clone));
                }
                return res;
            }).catch(() => cached);
            return cached || network;
        })
    );
});