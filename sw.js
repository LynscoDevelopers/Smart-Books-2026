/* Smart Books — Service Worker (v3 · network-first HTML) */
const CACHE_NAME = 'smartbooks-v3';       // ← bump this on every deploy
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

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
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

    // ── HTML navigations: NETWORK-FIRST ──
    const isHTML = req.mode === 'navigate' ||
        (req.headers.get('accept') || '').includes('text/html');

    if (isHTML) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(c => c.put(req, clone));
                    }
                    return res;
                })
                .catch(() =>
                    caches.match(req).then(c => c || caches.match('./index.html'))
                )
        );
        return;
    }

    // ── Same-origin static assets: cache-first ──
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

    // ── Cross-origin (fonts, CDN): stale-while-revalidate ──
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