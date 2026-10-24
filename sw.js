/* NYCPM Unofficial — offline shell.
   Upload this file to the root of the site, next to index.html.
   If it is missing the site still works exactly as before; registration
   simply fails and is ignored.

   Strategy
   - the page itself: serve the cached copy at once, fetch a fresh one in the
     background for next time (stale-while-revalidate), so a repeat visit paints
     with no network at all
   - posts.json / histology.json: network first, cache as a fallback, because
     these carry published content and must never be stale
   - the Apps Script backend, Google Drive and Google Fonts: never touched here
   - images and everything else same-origin: cache first, refreshed in the background
*/
var VERSION = 'nycpm-v4';
var SHELL   = ['./', './index.html'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === VERSION ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function fromNetwork(req, cache) {
  return fetch(req).then(function (res) {
    if (res && res.ok && req.method === 'GET') cache.put(req, res.clone());
    return res;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;        // backend, Drive, fonts
  if (url.search.indexOf('nosw') > -1) return;            // escape hatch

  var isPage = req.mode === 'navigate' ||
               (req.headers.get('accept') || '').indexOf('text/html') > -1;
  var isData = /\.(json)$/i.test(url.pathname);

  /* content files: always try the network first so a new upload is seen at once */
  if (isData) {
    e.respondWith(
      caches.open(VERSION).then(function (c) {
        return fromNetwork(req, c).catch(function () { return c.match(req); });
      })
    );
    return;
  }

  /* the page: cached copy immediately, fresh copy fetched for next time.
     The visitor is told only when the new copy is actually different, so the
     refresh nudge never appears on an ordinary reload.
     waitUntil has to be called while the event is still being dispatched, so
     the background comparison is hung off a promise created here and settled
     later. */
  if (isPage) {
    var settle;
    e.waitUntil(new Promise(function (r) { settle = r; }));
    e.respondWith(
      caches.open(VERSION).then(function (c) {
        return c.match('./index.html').then(function (hit) {
          /* clone the cached copy BEFORE it is handed to the page, because
             serving it consumes the body and it can no longer be read */
          var cached = hit ? hit.clone() : null;
          var net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
            if (!res || !res.ok) { settle(); return hit || res; }
            var fresh = res.clone();
            if (!cached) { c.put('./index.html', res.clone()).then(settle, settle); return res; }
            Promise.all([cached.text(), fresh.text()]).then(function (t) {
              if (t[0] === t[1]) return;
              return c.put('./index.html', new Response(t[1], {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
              })).then(function () { return tellClients('refreshed'); });
            }).then(settle, settle);
            return res;
          }).catch(function () { settle(); return hit; });
          return hit || net;
        });
      })
    );
    return;
  }

  /* everything else same-origin: cache first, quietly refreshed */
  e.respondWith(
    caches.open(VERSION).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fromNetwork(req, c).catch(function () { return hit; });
        return hit || net;
      });
    })
  );
});

function tellClients(msg) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (cl) { cl.postMessage({ sw: msg }); });
  });
}

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'clear') caches.delete(VERSION);
});
