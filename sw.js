const CACHE = 'sc-bo-trainer-v2';
const ASSETS = ['./', './index.html', './style.css', './data.js', './main.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// 네트워크 우선: 온라인이면 항상 최신 파일을 받아오고, 오프라인일 때만 캐시로 대체.
// (예전의 "캐시 우선" 방식은 배포 후에도 예전 버전이 계속 보이는 원인이었음)
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
