/* Shader Sandbox service worker: network-first, cache fallback for the app shell. */
'use strict';
var CACHE = 'shader-sandbox-v1';
var SHELL = [
  './', './index.html', './manifest.webmanifest',
  'css/base.css', 'css/editor.css', 'css/graph.css', 'css/mobile.css',
  'js/window-manager.js', 'js/glsl.js', 'js/editor.js', 'js/shader-preview.js', 'js/shader-probe.js',
  'js/graph-widget.js', 'js/gif-encoder.js', 'js/examples.js', 'js/app.js', 'js/code-keyboard.js', 'js/mobile.js',
  'icons/app-icon-192.png', 'icons/app-icon-512.png', 'icons/apple-touch-icon-180.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // Tolerate individual misses so one 404 never blocks installation.
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) { return hit || caches.match('./index.html'); });
  }));
});
