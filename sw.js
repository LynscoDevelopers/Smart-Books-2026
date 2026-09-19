/* Smart Books — Service Worker */
const CACHE_NAME = 'smartbooks-v5';
const CORE_ASSETS = ['./', './index.html'];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.all(CORE_ASSETS.map(url => cache.add(url).catch(() => { })))
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
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ============================================================
 * PUSH NOTIFICATIONS
 * Handles Web Push events delivered via Firebase Cloud Messaging
 * (works whether sent as a "data" message or a "notification"
 * message — this handler always takes control of the display so
 * we can set icon/badge/click-target consistently).
 * ============================================================ */
const FALLBACK_ICON = 'data:image/svg+xml;base64,' + btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#8b5cf6"/>` +
    `</linearGradient></defs>` +
    `<rect width="512" height="512" rx="112" fill="url(#g)"/>` +
    `<g transform="translate(128,128) scale(10.6667)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>` +
    `<path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>` +
    `</g></svg>`
);

self.addEventListener('push', event => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) {
        try { payload = { body: event.data ? event.data.text() : '' }; } catch (e2) { }
    }

    // Support both a raw payload and a Firebase Cloud Messaging
    // { notification, data } envelope.
    const n = payload.notification || {};
    const d = payload.data || payload || {};

    const title = n.title || d.title || 'Smart Books';
    const body = n.body || d.body || '';
    const url = d.url || d.click_action || './';
    const tag = d.tag || n.tag || undefined;
    const count = parseInt(d.count, 10);

    const options = {
        body,
        icon: n.icon || d.icon || FALLBACK_ICON,
        badge: FALLBACK_ICON,
        tag,
        renotify: !!tag,
        data: { url },
        vibrate: [80, 40, 80]
    };

    event.waitUntil((async () => {
        await self.registration.showNotification(title, options);
        try {
            if (!isNaN(count) && 'setAppBadge' in self.navigator) {
                if (count > 0) await self.navigator.setAppBadge(count);
                else await self.navigator.clearAppBadge();
            }
        } catch (e) { /* Badging API not supported here — ignore */ }
    })());
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || './';

    event.waitUntil((async () => {
        const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of allClients) {
            try {
                const clientUrl = new URL(client.url);
                if (clientUrl.origin === self.location.origin) {
                    await client.focus();
                    if ('postMessage' in client) client.postMessage({ type: 'NOTIFICATION_CLICK', url });
                    return;
                }
            } catch (e) { }
        }
        await clients.openWindow(url);
    })());
});

self.addEventListener('pushsubscriptionchange', event => {
    // The push subscription (or FCM token behind it) can rotate silently.
    // Tell any open page so it can re-register a fresh token.
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(all => {
            all.forEach(c => c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGE' }));
        })
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    if (url.hostname.endsWith('firebaseio.com') ||
        url.hostname.endsWith('firebaseapp.com') ||
        url.hostname.includes('identitytoolkit') ||
        url.protocol === 'ws:' || url.protocol === 'wss:') return;

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
                .catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
        );
        return;
    }

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