/**
 * Service Worker for Stratux PWA Apps
 * Provides offline caching for the engine monitor and fuel planner
 */

const CACHE_NAME = 'stratux-app-v2';

// Core files required for offline operation
const CORE_ASSETS = [
    './',
    './fuel-planner.html',
    './fuel-planner.js',
    './fuel-planner.css',
    './manifest.json',
    './engine-monitor-manifest.json',
    './static/chart.min.js',
    './help'
];

// Offline fallback page shown when cache is empty and server is unreachable
const OFFLINE_PAGE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline</title>
<style>
body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
  justify-content: center; min-height: 100vh; margin: 0; background: #FFFFF0;
  color: #333; text-align: center; padding: 20px; }
.box { max-width: 400px; }
h1 { color: #006400; font-size: 1.4em; }
p { line-height: 1.5; }
button { background: #006400; color: white; border: none; padding: 12px 24px;
  border-radius: 6px; font-size: 1em; margin-top: 12px; cursor: pointer; }
</style></head>
<body><div class="box">
<h1>Not Connected</h1>
<p>Connect to the Stratux WiFi network and try again.</p>
<p>If you previously loaded this page while connected, it should be available offline. Try closing and reopening the app.</p>
<button onclick="location.reload()">Retry</button>
</div></body></html>`;

// Install event - cache core assets individually (not all-or-nothing)
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                // Cache each asset individually so one failure doesn't prevent others
                return Promise.all(
                    CORE_ASSETS.map(url =>
                        cache.add(url).catch(err => {
                            console.warn('Failed to cache:', url, err);
                        })
                    )
                );
            })
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean up old caches and claim clients immediately
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch event - cache-first for static assets, network-first for API
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Only handle same-origin requests
    if (url.origin !== location.origin) {
        return;
    }

    // Network-first for API calls
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(event.request, clone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    return caches.match(event.request);
                })
        );
        return;
    }

    // Cache-first for static assets, with network fallback and background update
    event.respondWith(
        caches.match(event.request, { ignoreVary: true })
            .then(cachedResponse => {
                // Start network fetch in background to update cache
                const networkFetch = fetch(event.request)
                    .then(networkResponse => {
                        if (networkResponse.ok) {
                            const clone = networkResponse.clone();
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(event.request, clone);
                            });
                        }
                        return networkResponse;
                    })
                    .catch(() => null);

                if (cachedResponse) {
                    return cachedResponse;
                }

                // Not in cache - wait for network
                return networkFetch.then(networkResponse => {
                    if (networkResponse) {
                        return networkResponse;
                    }

                    // Both cache and network failed
                    if (event.request.mode === 'navigate') {
                        // Try fallback matches for navigation requests
                        if (url.pathname.includes('fuel-planner')) {
                            return caches.match('./fuel-planner.html')
                                .then(r => r || new Response(OFFLINE_PAGE, {
                                    headers: { 'Content-Type': 'text/html' }
                                }));
                        }
                        return caches.match('./')
                            .then(r => r || new Response(OFFLINE_PAGE, {
                                headers: { 'Content-Type': 'text/html' }
                            }));
                    }
                    return new Response('', { status: 503, statusText: 'Offline' });
                });
            })
    );
});
