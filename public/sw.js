/* jshint esversion: 5, worker: true */
// ==========================================
// POCKET READER SERVICE WORKER (ES5 COMPATIBLE)
// ==========================================

var CACHE_NAME = 'pocket-reader-core-v142';

function fetchWithTimeout(request, timeoutMs) {
    if (typeof AbortController === 'undefined') return fetch(request);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    // A navigation request (mode 'navigate') cannot be re-issued through
    // fetch() with an init object in some browsers — constructing a Request
    // from it plus a RequestInit throws synchronously ("Cannot construct a
    // Request with a RequestInit whose mode member is set as 'navigate'"). If
    // that ever happens the abortable fetch must not hard-fail the navigation:
    // fall back to a plain fetch(request) so the page still loads (just without
    // the timeout guard for that one request).
    var fetchPromise;
    try {
        fetchPromise = fetch(request, { signal: controller.signal });
    } catch (constructError) {
        clearTimeout(timer);
        return fetch(request);
    }
    return fetchPromise.then(
        function (response) {
            clearTimeout(timer);
            return response;
        },
        function (error) {
            clearTimeout(timer);
            throw error;
        }
    );
}

function updateAppCache(request, response) {
    if (!response || !response.ok) return Promise.resolve();
    return caches.open(CACHE_NAME).then(function (cache) {
        return cache.put(request, response.clone());
    }).catch(function (error) {
        // A full device cache must never convert a successful network fetch
        // into an app-level failure. Serving the fresh response is more
        // important than refreshing this optional offline copy.
        console.warn('[ServiceWorker] App cache update skipped:', error);
        return null;
    });
}

function withNarrationIsolation(response) {
    if (!response) return response;
    var headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('Origin-Agent-Cluster', '?1');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
    });
}

self.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'claim-clients') return;
    event.waitUntil(self.clients.claim());
});

// Cosmetic assets. The app boots and narrates without them (system fallback
// fonts, missing glyphs), so a flaky mobile connection must not be allowed to
// fail the whole install over one woff2 -- that used to leave the device with no
// offline shell at all. Cached best-effort below and, if missed, filled in by
// the fetch handler on first use.
var OPTIONAL_ASSETS = [
    'assets/icons/lucide-sprite.svg',
    'assets/fonts/literata-400.woff2',
    'assets/fonts/literata-600.woff2',
    'assets/fonts/literata-700.woff2',
    'assets/fonts/lucide.woff2?v=1'
];

// Large narration-runtime modules. They are lazy-loaded by
// narration_runtime_loader, so the shell is fully usable before they arrive.
// Precaching them is what makes narration work offline, but on a weak
// connection these are the most likely single fetch to fail -- and losing the
// offline shell is a far worse outcome than re-fetching these on first play.
var DEFERRED_ASSETS = [
    'assets/js/buffer_manager.js?v=buffer-v50',
    'assets/js/audio_core.js?v=audio-v61',
    'assets/js/pocket_worker.js?v=pocket-worker-v46',
    'assets/js/pocket_pcm_worklet.js?v=pcm-v1'
];

// The "App Shell" - files to cache instantly on first load
var CORE_ASSETS = [
    './',
    'assets/css/theme.css?v=midnight-v22',
    'assets/js/tts_pronunciation_core.js?v=pron-v11',
    'assets/js/pocket_backend_policy.js?v=backend-v20',
    'assets/js/pocket_performance_policy.js?v=performance-v2',
    'assets/js/diagnostics.js?v=diag-v4',
    'assets/js/api_core.js?v=search-v18',
    'assets/js/experience_coordinator.js?v=experience-v5',
    'assets/js/virtue_controller.js?v=virtue-v10',
    'assets/js/engine_utils.js',
    'assets/js/ui_controller.js?v=ui-v89',
    'assets/js/supabase_bridge.js?v=supabase-v5',
    'assets/js/profile_merge.js?v=merge-v5',
    'assets/js/data_transfer.js?v=transfer-v3',
    'assets/js/device_setup.js?v=device-setup-v7',
    'assets/js/device_benchmark_worker.js?v=device-bench-v1',
    'assets/js/settings_manager.js?v=settings-v49',
    'assets/js/library_manager.js?v=library-v13',
    'assets/js/narration_runtime_loader.js?v=narration-loader-v15',
    'assets/js/storage_core.js?v=storage-v11',
    'assets/js/sync_core.js?v=sync-v8',
    'assets/js/cinematic_ui.js?v=cinematic-v6',
    'assets/js/reader_features.js?v=features-v6',
    'assets/js/motion_lite.js'
];

// Best-effort cache fill: each entry is independent, so one failure costs only
// that entry rather than the entire install.
function cacheBestEffort(cache, assets) {
    return Promise.all(assets.map(function (asset) {
        return cache.add(asset).catch(function (error) {
            console.warn('[Service Worker] Optional pre-cache skipped:', asset, error);
            return null;
        });
    }));
}

// 1. INSTALLATION & PRE-CACHING
self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function (cache) {
                console.log('[Service Worker] Pre-caching App Shell');
                // The shell itself stays atomic: a half-populated core cache
                // would serve a broken app offline, so this must still reject.
                return cache.addAll(CORE_ASSETS).then(function () {
                    return cacheBestEffort(cache, DEFERRED_ASSETS.concat(OPTIONAL_ASSETS));
                });
            })
            .then(function () {
                return self.skipWaiting();
            })
            .catch(function (err) {
                console.error('[Service Worker] Install failed:', err);
                throw err;
            })
    );
});

// 2. ACTIVATION & CLEANUP
self.addEventListener('activate', function (event) {
    // Delete old caches if the CACHE_NAME version is updated, then claim clients
    event.waitUntil(
        caches.keys()
            .then(function (cacheNames) {
                return Promise.all(
                    cacheNames.map(function (cacheName) {
                        var keepModelCache = cacheName.indexOf('pocket-voices') !== -1 || cacheName.indexOf('onnx') !== -1 || cacheName.indexOf('pr-push-meta') !== -1;
                        if (cacheName !== CACHE_NAME && !keepModelCache) {
                            console.log('[Service Worker] Clearing old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(function () {
                return self.clients.claim();
            })
            .catch(function (err) {
                console.error('[Service Worker] Activation failed:', err);
            })
    );
});

// 3. PUSH NOTIFICATIONS
self.addEventListener('push', function (event) {
    var payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (_) {}
    var title = payload.title || 'Pocket Reader';
    var options = {
        body: payload.body || 'A subscribed story has an update.',
        icon: '/assets/img/reader%20192.png',
        badge: '/assets/img/reader%20192.png',
        data: {
            storyUrl: payload.storyUrl || payload.url || '',
            type: payload.type || ''
        }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// Re-subscribe when the browser rotates or expires the push subscription.
// Without this, a rotated subscription silently stops delivering new-chapter
// alerts: the backend prunes the now-dead endpoint on its next 410/404, but
// nothing ever registers a fresh one, so the user quietly stops getting updates
// until they manually toggle push off and on. settings_manager stashes the push
// metadata (user id, ownership token, VAPID key, API base) in the 'pr-push-meta'
// cache when push is enabled, and clears it on disable, so this only fires for a
// user who currently wants updates.
function urlBase64ToUint8Array(base64String) {
    var padding = '';
    while ((base64String.length + padding.length) % 4 !== 0) { padding += '='; }
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) { output[i] = raw.charCodeAt(i); }
    return output;
}

self.addEventListener('pushsubscriptionchange', function (event) {
    event.waitUntil(
        caches.match('/pr-push-meta').then(function (resp) {
            return resp ? resp.json() : null;
        }).then(function (meta) {
            if (!meta || !meta.vapidKey || !meta.user_id) return null;
            return self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(meta.vapidKey)
            }).then(function (sub) {
                return fetch((meta.apiBase || '') + '/api/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: meta.user_id,
                        subscription: sub.toJSON(),
                        auth_token: meta.auth_token || null
                    })
                });
            });
        }).catch(function (err) {
            console.warn('[Service Worker] pushsubscriptionchange re-subscribe failed:', err);
        })
    );
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var storyUrl = event.notification.data && event.notification.data.storyUrl || '';
    var target = '/';
    if (storyUrl) target += '?story_update=' + encodeURIComponent(storyUrl);
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            for (var i = 0; i < clientList.length; i++) {
                if ('focus' in clientList[i]) {
                    clientList[i].postMessage({ type: 'story-update', storyUrl: storyUrl });
                    return clientList[i].focus();
                }
            }
            return clients.openWindow ? clients.openWindow(target) : null;
        })
    );
});

// 4. FETCH INTERCEPTION
self.addEventListener('fetch', function (event) {
    var url = new URL(event.request.url);

    // Never intercept the service worker script itself or backend API calls
    if (
        url.pathname.endsWith('/sw.js') ||
        url.origin.indexOf('hf.space') !== -1
    ) {
        return;
    }

    // Navigation: network-first with an offline fallback to the cached shell.
    // Isolation is opt-in and limited to ?tts_fast=1 narration sessions. The
    // normal app stays unisolated because COOP same-origin severs OAuth popup
    // relationships. COEP require-corp enables SharedArrayBuffer and threaded
    // ONNX WASM; the Cloudflare model proxy explicitly permits cross-origin use.
    if (event.request.mode === 'navigate') {
        if (url.pathname.indexOf('/debug/') === 0) {
            return;
        }
        var isolateNarration = url.searchParams.get('tts_fast') === '1';
        event.respondWith(
            fetchWithTimeout(event.request, 6000)
                .catch(function () {
                    return caches.match('/').then(function (fallbackResponse) {
                        return fallbackResponse || new Response('Offline', { status: 503 });
                    });
                })
                .then(function (response) {
                    return isolateNarration ? withNarrationIsolation(response) : response;
                })
        );
        return;
    }

    if (url.pathname.indexOf('/assets/') === 0 && (url.pathname.slice(-3) === '.js' || url.pathname.slice(-4) === '.css')) {
        var isPocketWorker = url.pathname.indexOf('/pocket_worker.js') !== -1;
        var fetchAndCache = function () {
            return fetch(event.request).then(function (networkResponse) {
                var servedResponse = isPocketWorker ? withNarrationIsolation(networkResponse) : networkResponse;
                return updateAppCache(event.request, servedResponse).then(function () {
                    return servedResponse;
                });
            });
        };

        // A ?v= URL is immutable by construction: changing a module changes its
        // version, and therefore its URL. So a cache hit can never be stale and
        // revalidating it can never return anything new. This previously issued
        // a background fetch for every versioned module on every single load --
        // re-downloading the whole JS bundle (~700 KB across ~25 modules) per
        // launch on cellular, competing with the model and voice downloads that
        // actually gate narration starting.
        if (url.searchParams.has('v')) {
            event.respondWith(
                caches.match(event.request).then(function (cachedResponse) {
                    if (cachedResponse) {
                        return isPocketWorker ? withNarrationIsolation(cachedResponse) : cachedResponse;
                    }
                    return fetchAndCache();
                }).catch(function () {
                    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
                })
            );
            return;
        }

        // Unversioned assets stay network-first so emergency updates to a URL
        // that never changes are never pinned behind the cache.
        var updatePromise = fetchAndCache();
        event.waitUntil(updatePromise.then(function () {}).catch(function () {}));
        event.respondWith(
            updatePromise.catch(function () {
                return caches.match(event.request).then(function (cachedResponse) {
                    if (!cachedResponse) return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
                    return isPocketWorker ? withNarrationIsolation(cachedResponse) : cachedResponse;
                });
            })
        );
        return;
    }

    // Cache-first strategy for large visual assets.
    if (url.pathname.indexOf('/assets/') === 0 || event.request.destination === 'image') {
        event.respondWith(
            caches.match(event.request).then(function (cachedResponse) {
                if (cachedResponse) {
                    return cachedResponse;
                }
                var assetUpdate = fetch(event.request)
                    .then(function (networkResponse) {
                        return updateAppCache(event.request, networkResponse).then(function () {
                            return networkResponse;
                        });
                    });
                event.waitUntil(assetUpdate.then(function () {}).catch(function () {}));
                return assetUpdate
                    .catch(function () {
                        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
                    });
            })
        );
    }
});
