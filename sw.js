/* Service worker: caches the app shell so the app works offline.
 *
 * DEPLOYING CHANGES: bump CACHE_VERSION below. A changed sw.js makes the browser install
 * the new worker, which downloads a fresh shell; old caches are deleted on activate.
 */
'use strict';

const CACHE_VERSION = 'v1';
// All *.github.io project sites share one origin (and one Cache Storage), so every cache
// name carries this app's prefix and cleanup only touches caches with that prefix.
const CACHE_PREFIX = 'coffee-app-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// Relative URLs resolve against this file's location, i.e. /coffee-app/ on GitHub Pages.
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload' bypasses the HTTP cache, so a new version never stores stale files.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-first for same-origin GET requests; offline navigations fall back to index.html.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  const isNavigation = request.mode === 'navigate';
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: isNavigation });
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (err) {
        if (isNavigation) {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      }
    })
  );
});
