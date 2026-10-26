import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { env } from '../env.js';
import { publicLiveLocation } from '../services/liveLocation.js';

// The page behind a live location link (services/liveLocation.ts), opened by the customer: no sign-in, the link's
// token is the key. It shows only the shared position on a map, following it until sharing ends, and links to
// Google Maps / Apple Maps. Self-contained (no outside scripts), with a strict Content-Security-Policy.
export const liveRouter = Router();

const TOKEN = /^[A-Za-z0-9_-]{24}$/;

function tileOrigin() {
  try {
    return new URL(env.mapTileUrl.replace(/\{[^}]+\}/g, '0')).origin;
  } catch {
    return '';
  }
}

const noStore = (res: import('express').Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  // The tile server sees only this site's address, never the link's token
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
};

liveRouter.get('/:token/position', (req, res) => {
  noStore(res);
  const live = TOKEN.test(req.params.token) ? publicLiveLocation(req.params.token) : null;
  if (!live) return res.status(404).json({ error: 'This live location link is not valid' });
  res.json(live);
});

liveRouter.get('/:token', (req, res) => {
  noStore(res);
  const nonce = randomBytes(16).toString('base64');
  const origin = tileOrigin();
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src ${origin || "'none'"} data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  const config = JSON.stringify({ tileUrl: env.mapTileUrl, attribution: env.mapAttribution, app: env.appName }).replace(/</g, '\\u003c');
  res.type('html').send(page(nonce, config, TOKEN.test(req.params.token)));
});

function page(nonce: string, config: string, validToken: boolean) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Live location</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg:#f4f1ec; --card:#fff; --ink:#1b1b1b; --muted:#6b6b6b; --line:#e3ded6; --brand:#0f5e4f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --card:#1d1d1d; --ink:#eee; --muted:#a3a3a3; --line:#333; --brand:#3fb49b; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:720px; margin:0 auto; padding:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; overflow:hidden; }
  header { padding:14px 16px; display:flex; gap:10px; align-items:center; }
  .dot { width:10px; height:10px; border-radius:50%; background:#22c55e; box-shadow:0 0 0 4px rgba(34,197,94,.2); flex:none; }
  .ended .dot { background:#9ca3af; box-shadow:none; }
  h1 { font-size:16px; margin:0; }
  .sub { color:var(--muted); font-size:13px; }
  #map { position:relative; height:min(60vh,460px); overflow:hidden; background:#ddd; touch-action:none; }
  #tiles img { position:absolute; width:256px; height:256px; user-select:none; }
  .pin { position:absolute; left:50%; top:50%; width:22px; height:22px; margin:-11px 0 0 -11px; border-radius:50%; background:#1a73e8; border:3px solid #fff; box-shadow:0 1px 6px rgba(0,0,0,.4); }
  .acc { position:absolute; left:50%; top:50%; border-radius:50%; background:rgba(26,115,232,.15); border:1px solid rgba(26,115,232,.4); transform:translate(-50%,-50%); }
  .zoom { position:absolute; right:10px; top:10px; display:flex; flex-direction:column; gap:4px; }
  .zoom button { width:34px; height:34px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); font-size:18px; cursor:pointer; }
  .attr { position:absolute; right:0; bottom:0; background:rgba(255,255,255,.85); color:#333; font-size:11px; padding:2px 6px; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; padding:12px 16px 16px; }
  .actions a { flex:1 1 180px; text-align:center; text-decoration:none; padding:10px 12px; border-radius:10px; font-weight:600; border:1px solid var(--line); color:var(--ink); }
  .actions a.primary { background:var(--brand); color:#fff; border-color:transparent; }
  .msg { padding:28px 16px; text-align:center; color:var(--muted); }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <div class="card" id="card">
    <header><span class="dot"></span><div><h1 id="title">Live location</h1><div class="sub" id="sub">Loading…</div></div></header>
    <div id="map" hidden><div id="tiles"></div><div class="acc" id="acc"></div><div class="pin"></div>
      <div class="zoom"><button type="button" id="zin" aria-label="Zoom in">+</button><button type="button" id="zout" aria-label="Zoom out">−</button></div>
      <div class="attr" id="attr"></div></div>
    <div class="msg" id="msg" hidden></div>
    <div class="actions" id="actions" hidden>
      <a id="gmaps" class="primary" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>
      <a id="amaps" target="_blank" rel="noopener noreferrer">Open in Apple Maps</a>
    </div>
  </div>
</main>
<script nonce="${nonce}">
(function () {
  var cfg = ${config};
  var validToken = ${validToken ? 'true' : 'false'};
  var token = location.pathname.split('/').filter(Boolean).pop();
  var $ = function (id) { return document.getElementById(id); };
  var zoom = 16, last = null, timer = null;
  $('attr').textContent = cfg.attribution;
  document.title = 'Live location · ' + cfg.app;
  function ended(text) {
    $('card').className = 'card ended';
    $('map').hidden = true; $('actions').hidden = true;
    $('title').textContent = 'Live location ended';
    $('sub').textContent = '';
    $('msg').hidden = false; $('msg').textContent = text;
    if (timer) clearInterval(timer);
  }
  function worldPx(lat, lng, z) {
    var s = 256 * Math.pow(2, z), r = Math.PI / 180;
    var y = Math.log(Math.tan(lat * r) + 1 / Math.cos(lat * r));
    return { x: (lng + 180) / 360 * s, y: (1 - y / Math.PI) / 2 * s };
  }
  function draw() {
    if (!last) return;
    var box = $('map'), w = box.clientWidth, h = box.clientHeight, n = Math.pow(2, zoom);
    var c = worldPx(last.latitude, last.longitude, zoom), left = c.x - w / 2, top = c.y - h / 2;
    var tiles = $('tiles'); tiles.textContent = '';
    for (var tx = Math.floor(left / 256); tx <= Math.floor((left + w) / 256); tx++)
      for (var ty = Math.floor(top / 256); ty <= Math.floor((top + h) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        var img = document.createElement('img');
        img.alt = ''; img.draggable = false; img.referrerPolicy = 'strict-origin-when-cross-origin';
        img.src = cfg.tileUrl.replace('{z}', zoom).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
        img.style.left = Math.round(tx * 256 - left) + 'px'; img.style.top = Math.round(ty * 256 - top) + 'px';
        tiles.appendChild(img);
      }
    var acc = $('acc');
    if (last.accuracy) {
      var mpp = 156543.03392 * Math.cos(last.latitude * Math.PI / 180) / n; // metres per pixel here
      var d = Math.min(2 * last.accuracy / mpp, 2000);
      acc.style.width = acc.style.height = d + 'px'; acc.hidden = d < 24;
    } else acc.hidden = true;
  }
  function links(p) {
    var ll = p.latitude + ',' + p.longitude;
    $('gmaps').href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ll);
    $('amaps').href = 'https://maps.apple.com/?ll=' + encodeURIComponent(ll) + '&q=' + encodeURIComponent('Live location');
  }
  function ago(at) {
    var s = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
    return s < 60 ? 'just now' : Math.round(s / 60) + ' min ago';
  }
  function refresh() {
    fetch(location.pathname.replace(/\\/$/, '') + '/position', { cache: 'no-store' })
      .then(function (r) { if (r.status === 404) throw new Error('gone'); return r.json(); })
      .then(function (d) {
        if (!d.active) return ended('This live location has ended.');
        var until = new Date(d.until);
        $('title').textContent = d.sharerName + ' is sharing a live location';
        $('sub').textContent = 'Until ' + until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (d.position ? ' · updated ' + ago(d.position.at) : '');
        if (d.position) {
          // Redrawn only when the position changed (redrawing reloads the map pictures)
          var p = d.position, moved = !last || last.latitude !== p.latitude || last.longitude !== p.longitude || last.accuracy !== p.accuracy;
          last = p;
          $('map').hidden = false; $('actions').hidden = false; $('msg').hidden = true;
          if (moved) { links(p); draw(); }
        }
      })
      .catch(function (e) { if (e.message === 'gone') ended('This live location link is not valid or has expired.'); });
  }
  if (!validToken) return ended('This live location link is not valid or has expired.');
  $('zin').onclick = function () { zoom = Math.min(19, zoom + 1); draw(); };
  $('zout').onclick = function () { zoom = Math.max(3, zoom - 1); draw(); };
  window.addEventListener('resize', draw);
  refresh();
  timer = setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}
