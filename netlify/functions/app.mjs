import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const SITE_NAME = process.env.SITE_NAME || 'Videoteca';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;

/* ---------- almacenamiento (Netlify Blobs) ---------- */

async function load() {
  try {
    const d = await getStore('videoteca').get('videos', { type: 'json' });
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

async function save(list) {
  await getStore('videoteca').setJSON('videos', list);
}

/* ---------- utilidades ---------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sessionToken = () => crypto.createHmac('sha256', SECRET).update('admin-session').digest('hex');

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const c = parseCookies(req.headers.get('cookie')).sesion;
  return Boolean(c) && safeEqual(c, sessionToken());
}

const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.t > 15 * 60 * 1000) {
    attempts.set(ip, { n: 1, t: now });
    return false;
  }
  rec.n += 1;
  return rec.n > 10;
}

/* ---------- reconocer enlaces de video ---------- */

const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v|m3u8)$/i;
const ID_RE = /^[\w-]+$/;

function parseSource(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { error: 'El enlace no es válido.' };
  }
  if (!/^https?:$/.test(u.protocol)) return { error: 'El enlace debe empezar con http o https.' };
  const host = u.hostname.replace(/^www\./, '');

  if (['mega.nz', 'mega.io', 'mega.co.nz'].includes(host)) {
    if (/^\/folder\//.test(u.pathname) || /^#F!/.test(u.hash)) {
      return { error: 'Los enlaces de carpeta de Mega no se pueden reproducir. Usa el enlace de cada archivo.' };
    }
    let m = u.pathname.match(/^\/(?:file|embed)\/([\w-]+)$/);
    const key = u.hash.replace(/^#/, '');
    if (m && ID_RE.test(key)) return { kind: 'frame', provider: 'Mega', embed: `https://mega.nz/embed/${m[1]}#${key}` };
    m = u.hash.match(/^#!([\w-]+)!([\w-]+)$/);
    if (m) return { kind: 'frame', provider: 'Mega', embed: `https://mega.nz/embed/#!${m[1]}!${m[2]}` };
    return { error: 'El enlace de Mega está incompleto. Copia el enlace completo, con la clave después del #.' };
  }

  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    let id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/);
      if (m) id = m[1];
    }
    if (ID_RE.test(id)) {
      return {
        kind: 'frame',
        provider: 'YouTube',
        embed: `https://www.youtube-nocookie.com/embed/${id}`,
        thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
    }
    return { error: 'No se pudo leer el enlace de YouTube.' };
  }

  if (host === 'drive.google.com') {
    const m = u.pathname.match(/^\/file\/d\/([\w-]+)/);
    const id = m ? m[1] : u.searchParams.get('id') || '';
    if (ID_RE.test(id)) {
      return {
        kind: 'frame',
        provider: 'Google Drive',
        embed: `https://drive.google.com/file/d/${id}/preview`,
        thumb: `https://drive.google.com/thumbnail?id=${id}&sz=w640`,
      };
    }
    return { error: 'No se pudo leer el enlace de Google Drive.' };
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(\d{5,})/);
    if (m) return { kind: 'frame', provider: 'Vimeo', embed: `https://player.vimeo.com/video/${m[1]}` };
    return { error: 'No se pudo leer el enlace de Vimeo.' };
  }

  if (host.endsWith('dropbox.com')) {
    const d = new URL(u.href);
    d.hostname = 'dl.dropboxusercontent.com';
    d.searchParams.delete('dl');
    d.searchParams.set('raw', '1');
    return { kind: 'video', provider: 'Dropbox', embed: d.href };
  }

  if (VIDEO_EXT.test(u.pathname)) return { kind: 'video', provider: 'Enlace directo', embed: u.href };

  return { error: 'Servicio no compatible. Usa Mega, YouTube, Google Drive, Vimeo, Dropbox o un enlace directo a un archivo de video.' };
}

const cleanUrl = (v) => {
  try {
    const u = new URL(String(v || '').trim());
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
};

/* ---------- plantillas ---------- */

function layout({ title, body, script = true, admin = false }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;800&family=Figtree:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/estilos.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">${esc(SITE_NAME)}</a>
  <a class="admin-link" href="/admin">${admin ? 'Panel' : 'Administrar'}</a>
</header>
<main class="wrap">
${body}
</main>
${script ? '<script src="/app.js" defer></script>' : ''}
</body>
</html>`;
}

function card(v) {
  const thumb = v.thumb
    ? `<img src="${esc(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="ph">${esc((v.title[0] || '?').toUpperCase())}</span>`;
  return `<a class="card" href="/ver/${esc(v.id)}" data-title="${esc((v.title + ' ' + v.category).toLowerCase())}" data-cat="${esc(v.category)}">
  <div class="thumb">${thumb}<i class="play" aria-hidden="true"></i></div>
  <h3>${esc(v.title)}</h3>
  <p>${esc(v.category)}</p>
</a>`;
}

function catalogPage(list) {
  const cats = [...new Set(list.map((v) => v.category))].sort((a, b) => a.localeCompare(b, 'es'));
  const body = list.length
    ? `<div class="head">
  <h1>Todos los videos</h1>
  <span class="count" id="count">${list.length} ${list.length === 1 ? 'video' : 'videos'}</span>
</div>
<div class="tools">
  <input id="q" type="search" placeholder="Buscar un video" aria-label="Buscar un video" autocomplete="off">
  <div class="chips" id="chips">
    <button class="chip on" data-cat="">Todos</button>
    ${cats.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
  </div>
</div>
<div class="grid" id="grid">${list.map(card).join('')}</div>
<p class="empty" id="empty" hidden>Ningún video coincide con tu búsqueda.</p>`
    : `<div class="head"><h1>Todos los videos</h1></div>
<p class="empty">Aún no hay videos. Agrega el primero desde <a href="/admin">el panel</a>.</p>`;
  return layout({ title: SITE_NAME, body });
}

function playerPage(v, list) {
  const player =
    v.kind === 'video'
      ? `<video controls preload="metadata" playsinline src="${esc(v.embed)}"></video>`
      : `<iframe src="${esc(v.embed)}" title="${esc(v.title)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  const more = list.filter((x) => x.id !== v.id).slice(0, 8);
  const body = `<a class="back" href="/">Volver al catálogo</a>
<div class="player">${player}</div>
<h1 class="vt">${esc(v.title)}</h1>
<p class="meta">${esc(v.category)} · desde ${esc(v.provider)}</p>
${v.description ? `<p class="desc">${esc(v.description)}</p>` : ''}
${more.length ? `<h2>Más videos</h2><div class="grid">${more.map(card).join('')}</div>` : ''}`;
  return layout({ title: `${v.title} | ${SITE_NAME}`, body, script: false });
}

const MESSAGES = {
  mal: 'Contraseña incorrecta.',
  muchos: 'Demasiados intentos. Espera unos minutos.',
  agregado: 'Video agregado.',
  borrado: 'Video eliminado.',
  falta: 'Escribe un título y un enlace.',
};

function adminPage(req, list, note, isError) {
  if (!ADMIN_PASSWORD) {
    return layout({
      title: `Panel | ${SITE_NAME}`,
      script: false,
      admin: true,
      body: `<h1>Panel</h1><p class="empty">Define la variable de entorno ADMIN_PASSWORD para activar el panel.</p>`,
    });
  }
  if (!isAdmin(req)) {
    return layout({
      title: `Panel | ${SITE_NAME}`,
      script: false,
      admin: true,
      body: `<h1>Entrar al panel</h1>
${note ? `<p class="note ${isError ? 'bad' : ''}">${esc(note)}</p>` : ''}
<form class="form narrow" method="post" action="/admin/entrar">
  <label>Contraseña<input type="password" name="password" required autofocus></label>
  <button class="btn" type="submit">Entrar</button>
</form>`,
    });
  }
  const rows = list
    .map(
      (v) => `<li>
  <div><strong>${esc(v.title)}</strong><span>${esc(v.category)} · ${esc(v.provider)}</span></div>
  <form method="post" action="/admin/borrar/${esc(v.id)}"><button class="btn ghost" type="submit">Eliminar</button></form>
</li>`
    )
    .join('');
  return layout({
    title: `Panel | ${SITE_NAME}`,
    script: false,
    admin: true,
    body: `<h1>Panel</h1>
${note ? `<p class="note ${isError ? 'bad' : ''}">${esc(note)}</p>` : ''}
<h2>Agregar video</h2>
<form class="form" method="post" action="/admin/agregar">
  <label>Título<input name="title" maxlength="120" required></label>
  <label>Enlace del video
    <input name="url" type="url" placeholder="https://mega.nz/file/..." required>
    <small>Mega, YouTube, Google Drive, Vimeo, Dropbox o enlace directo a un archivo de video.</small>
  </label>
  <label>Categoría<input name="category" maxlength="40" placeholder="General"></label>
  <label>Imagen de portada (opcional)
    <input name="thumb" type="url" placeholder="https://...">
    <small>Mega y los enlaces directos no generan portada. Sin imagen se muestra la inicial del título.</small>
  </label>
  <label>Descripción (opcional)<textarea name="description" rows="3" maxlength="600"></textarea></label>
  <button class="btn" type="submit">Agregar video</button>
</form>
<h2>Videos (${list.length})</h2>
<ul class="rows">${rows || '<li><span>No hay videos todavía.</span></li>'}</ul>
<form method="post" action="/admin/salir" class="out"><button class="btn ghost" type="submit">Cerrar sesión</button></form>`,
  });
}

/* ---------- estilos y script del cliente ---------- */

const CSS = `
:root{--bg:#1b1530;--surface:#261e42;--line:#3a2f5e;--text:#f4f0ff;--muted:#a89fc8;--accent:#ffb454;--bad:#ff7a7a}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.55 'Figtree',system-ui,sans-serif}
a{color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.top{display:flex;justify-content:space-between;align-items:center;padding:18px clamp(16px,4vw,40px);border-bottom:1px solid var(--line)}
.brand{font:800 1.35rem 'Bricolage Grotesque',sans-serif;text-decoration:none;letter-spacing:-.01em}
.admin-link{color:var(--muted);font-size:.9rem;text-decoration:none}
.admin-link:hover{color:var(--text)}
.wrap{max-width:1200px;margin:0 auto;padding:32px clamp(16px,4vw,40px) 80px}
h1,h2,h3{font-family:'Bricolage Grotesque',sans-serif;line-height:1.15;margin:0}
h1{font-size:clamp(1.8rem,4vw,2.6rem);font-weight:800;letter-spacing:-.02em}
h2{font-size:1.3rem;margin:40px 0 16px}
.head{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.count{color:var(--muted)}
.tools{display:flex;flex-direction:column;gap:14px;margin-bottom:28px}
input,textarea{width:100%;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:12px 14px;font:inherit}
input::placeholder,textarea::placeholder{color:#7d74a0}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font:inherit;font-size:.9rem;cursor:pointer}
.chip:hover{color:var(--text)}
.chip.on{background:var(--accent);border-color:var(--accent);color:#2a1d05;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:26px 20px}
.card{text-decoration:none;display:block}
.thumb{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--surface);border:1px solid var(--line)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.ph{display:grid;place-items:center;height:100%;font:800 3rem 'Bricolage Grotesque',sans-serif;color:var(--line)}
.play{position:absolute;right:10px;bottom:10px;width:38px;height:38px;border-radius:50%;background:var(--accent)}
.play::after{content:'';position:absolute;left:15px;top:11px;border-left:12px solid #2a1d05;border-top:8px solid transparent;border-bottom:8px solid transparent}
.card:hover .thumb,.card:focus-visible .thumb{border-color:var(--accent)}
.card h3{font-size:1.05rem;font-weight:600;margin-top:10px}
.card p{margin:2px 0 0;color:var(--muted);font-size:.9rem}
.empty{color:var(--muted);padding:40px 0}
.empty a{color:var(--accent)}
.back{display:inline-block;color:var(--muted);text-decoration:none;margin-bottom:16px;font-size:.95rem}
.back:hover{color:var(--text)}
.player{aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.player iframe,.player video{width:100%;height:100%;border:0;display:block}
.vt{font-size:clamp(1.5rem,3.5vw,2.1rem);margin-top:20px}
.meta{color:var(--muted);margin:6px 0 0}
.desc{max-width:70ch;margin:16px 0 0;color:#ddd6f5}
.form{display:flex;flex-direction:column;gap:16px;max-width:560px}
.form.narrow{max-width:360px}
label{display:flex;flex-direction:column;gap:6px;font-weight:500}
small{color:var(--muted);font-weight:400}
.btn{align-self:flex-start;background:var(--accent);color:#2a1d05;border:0;border-radius:8px;padding:11px 20px;font:600 1rem 'Figtree',sans-serif;cursor:pointer}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line);padding:7px 14px;font-size:.9rem}
.btn.ghost:hover{border-color:var(--bad);color:var(--bad)}
.note{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px 14px;max-width:560px}
.note.bad{border-color:var(--bad);color:var(--bad)}
.rows{list-style:none;margin:0;padding:0;max-width:760px}
.rows li{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
.rows span{display:block;color:var(--muted);font-size:.9rem}
.out{margin-top:32px}
@media (prefers-reduced-motion:no-preference){.thumb{transition:border-color .15s}}
`;

const CLIENT_JS = `
(function () {
  var q = document.getElementById('q');
  var grid = document.getElementById('grid');
  if (!q || !grid) return;
  var cards = Array.prototype.slice.call(grid.children);
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');
  var cat = '';
  function apply() {
    var t = q.value.trim().toLowerCase();
    var shown = 0;
    cards.forEach(function (c) {
      var ok = (!cat || c.dataset.cat === cat) && (!t || c.dataset.title.indexOf(t) !== -1);
      c.hidden = !ok;
      if (ok) shown++;
    });
    empty.hidden = shown !== 0;
    count.textContent = shown + (shown === 1 ? ' video' : ' videos');
  }
  q.addEventListener('input', apply);
  chips.forEach(function (b) {
    b.addEventListener('click', function () {
      cat = b.dataset.cat;
      chips.forEach(function (x) { x.classList.toggle('on', x === b); });
      apply();
    });
  });
})();
`;

/* ---------- respuestas ---------- */

const SECURITY = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    'img-src * data:',
    'media-src *',
    'frame-src https://mega.nz https://www.youtube-nocookie.com https://drive.google.com https://player.vimeo.com',
    "form-action 'self'",
    "base-uri 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const send = (body, type, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': type, ...SECURITY, ...extra } });
const page = (html, status = 200) => send(html, 'text/html; charset=utf-8', status);
const go = (req, to, extra = {}) =>
  new Response(null, { status: 303, headers: { Location: new URL(to, req.url).href, ...extra } });
const notFound = (title, msg) =>
  page(layout({ title, script: false, body: `<h1>${msg}</h1><p class="empty"><a href="/">Volver al catálogo</a></p>` }), 404);

/* ---------- rutas ---------- */

export default async (req, context) => {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (p === '/estilos.css') return send(CSS, 'text/css; charset=utf-8', 200, { 'Cache-Control': 'public, max-age=300' });
    if (p === '/app.js') return send(CLIENT_JS, 'application/javascript; charset=utf-8', 200, { 'Cache-Control': 'public, max-age=300' });
    if (p === '/salud') return send('ok', 'text/plain');

    if (p === '/') return page(catalogPage(await load()));

    const ver = p.match(/^\/ver\/([\w-]+)$/);
    if (ver) {
      const list = await load();
      const v = list.find((x) => x.id === ver[1]);
      return v ? page(playerPage(v, list)) : notFound('No encontrado', 'Video no encontrado');
    }

    if (p === '/api/videos') {
      const list = (await load()).map(({ id, title, category, provider, thumb, description }) => ({ id, title, category, provider, thumb, description }));
      return send(JSON.stringify(list), 'application/json; charset=utf-8');
    }

    if (p === '/admin') {
      const k = url.searchParams.get('m');
      const note = MESSAGES[k] || '';
      return page(adminPage(req, await load(), note, k === 'mal' || k === 'muchos' || k === 'falta'));
    }
    return notFound('No encontrado', 'Página no encontrada');
  }

  if (req.method === 'POST') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) return send('Solicitud rechazada', 'text/plain', 403);

    const raw = await req.text();
    if (raw.length > 20000) return send('Solicitud demasiado grande', 'text/plain', 413);
    const form = new URLSearchParams(raw);

    if (p === '/admin/entrar') {
      if (!ADMIN_PASSWORD) return go(req, '/admin');
      if (tooManyAttempts(context.ip || 'x')) return go(req, '/admin?m=muchos');
      if (!safeEqual(form.get('password') || '', ADMIN_PASSWORD)) return go(req, '/admin?m=mal');
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return go(req, '/admin', {
        'Set-Cookie': `sesion=${sessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 12}${secure}`,
      });
    }

    if (p === '/admin/salir') {
      return go(req, '/admin', { 'Set-Cookie': 'sesion=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (p === '/admin/agregar') {
      if (!isAdmin(req)) return go(req, '/admin');
      const title = String(form.get('title') || '').trim().slice(0, 120);
      const link = String(form.get('url') || '').trim();
      if (!title || !link) return go(req, '/admin?m=falta');
      const src = parseSource(link);
      const list = await load();
      if (src.error) return page(adminPage(req, list, src.error, true));
      list.unshift({
        id: crypto.randomUUID().slice(0, 8),
        title,
        category: String(form.get('category') || '').trim().slice(0, 40) || 'General',
        description: String(form.get('description') || '').trim().slice(0, 600),
        kind: src.kind,
        provider: src.provider,
        embed: src.embed,
        thumb: cleanUrl(form.get('thumb')) || src.thumb || '',
        createdAt: new Date().toISOString(),
      });
      await save(list);
      return go(req, '/admin?m=agregado');
    }

    const del = p.match(/^\/admin\/borrar\/([\w-]+)$/);
    if (del) {
      if (!isAdmin(req)) return go(req, '/admin');
      await save((await load()).filter((v) => v.id !== del[1]));
      return go(req, '/admin?m=borrado');
    }
  }

  return notFound('No encontrado', 'Página no encontrada');
};

export const config = { path: '/*' };
