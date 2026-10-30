const C='bsim-v11',A=['./','index.html','style.css','app.js','manifest.json','icon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.origin!==location.origin||e.request.method!=='GET')return;
e.respondWith(fetch(e.request,{cache:'no-cache'}).then(r=>{if(r.ok&&r.status===200){const c=r.clone();caches.open(C).then(x=>x.put(e.request,c)).catch(()=>{})}return r}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(m=>m||caches.match('./'))))});
