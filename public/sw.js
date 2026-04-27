// sw.js — Mindspace service worker
// Caches static assets for offline shell; never caches socket.io or API

const CACHE  = 'mindspace-v3';
const STATIC = ['/', '/index.html', '/safety.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never intercept socket.io, API, or mod routes
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api') || url.pathname.startsWith('/mod')) return;
  // Cache-first for static assets
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => caches.match('/index.html'));
      })
    );
  }
});

// Push notification handler
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Mindspace', {
      body: data.body || 'You have a new message',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'mindspace',
      data: data,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});