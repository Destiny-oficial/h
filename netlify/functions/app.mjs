import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const SITE_NAME = process.env.SITE_NAME || 'Videoteca';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;
const IMGBB_KEY = process.env.IMGBB_KEY || '';
const PER_PAGE = 24;
const TYPES = ['OVA', 'Serie', 'Película', 'Especial'];
const STATUSES = ['Finalizado', 'En emisión'];

async function uploadImage(file) {
  if (!file || typeof file === 'string' || !file.size) return '';
  if (!IMGBB_KEY) throw new Error('Falta la variable IMGBB_KEY en Netlify para subir imágenes.');
  if (!String(file.type).startsWith('image/')) throw new Error('El archivo no es una imagen.');
  if (file.size > 5 * 1024 * 1024) throw new Error('La imagen pesa más de 5 MB.');
  const body = new FormData();
  body.append('image', file, file.name || 'imagen.jpg');
  let j = null;
  let ok = false;
  try {
    const res = await fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(IMGBB_KEY), { method: 'POST', body });
    ok = res.ok;
    j = await res.json();
  } catch {
    throw new Error('No se pudo conectar con ImgBB. Intenta de nuevo.');
  }
  if (!ok || !j || !j.success || !j.data || !j.data.url) {
    const why = j && j.error && j.error.message ? `: ${j.error.message}` : '';
    throw new Error(`ImgBB no aceptó la imagen${why}`);
  }
  return j.data.url;
}

function normalizeEp(e) {
  if (!Array.isArray(e.servers)) {
    e.servers = e.embed ? [{ name: e.provider || 'Servidor', kind: e.kind, provider: e.provider, embed: e.embed }] : [];
    delete e.kind;
    delete e.provider;
    delete e.embed;
  }
  return e;
}

/* ---------- almacenamiento (Netlify Blobs) ---------- */

async function load() {
  try {
    const d = await getStore('videoteca').get('series', { type: 'json' });
    if (!Array.isArray(d)) return [];
    d.forEach((s) => {
      s.episodes = (s.episodes || []).map(normalizeEp);
    });
    return d;
  } catch {
    return [];
  }
}

async function save(list) {
  await getStore('videoteca').setJSON('series', list);
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

const isAdult = (req) => parseCookies(req.headers.get('cookie')).mayor === '1';

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

const slugify = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'serie';

function uniqueSlug(list, title) {
  const base = slugify(title);
  let slug = base;
  let i = 2;
  while (list.some((x) => x.slug === slug)) slug = `${base}-${i++}`;
  return slug;
}

const byNew = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

function ago(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!(m >= 0) || m < 2) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} ${h === 1 ? 'hora' : 'horas'}`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo === 1 ? 'hace un mes' : `hace ${mo} meses`;
  const y = Math.floor(d / 365);
  return y <= 1 ? 'hace un año' : `hace ${y} años`;
}

function parseGenres(raw) {
  const seen = new Set();
  const out = [];
  String(raw || '')
    .split(',')
    .map((g) => g.trim().slice(0, 30))
    .filter(Boolean)
    .forEach((g) => {
      const k = g.toLowerCase();
      if (!seen.has(k) && out.length < 15) {
        seen.add(k);
        out.push(g);
      }
    });
  return out;
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

  if (host === 'youtu.be' || host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
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

  if (host.endsWith('dropbox.com') || host.endsWith('dropboxusercontent.com')) {
    const d = new URL(u.href);
    d.hostname = 'dl.dropboxusercontent.com';
    d.searchParams.delete('dl');
    d.searchParams.set('raw', '1');
    return { kind: 'video', provider: 'Dropbox', embed: d.href };
  }

  if (VIDEO_EXT.test(u.pathname)) return { kind: 'video', provider: 'Enlace directo', embed: u.href };

  if (/^voe[\w.-]*$/.test(host)) {
    const m = u.pathname.match(/^\/(?:e\/)?([\w-]+)$/);
    if (m) return { kind: 'frame', provider: 'Voe', embed: `${u.origin}/e/${m[1]}` };
  }

  const label = host.split('.').slice(-2, -1)[0] || host;
  return { kind: 'frame', provider: label.charAt(0).toUpperCase() + label.slice(1), embed: u.href };
}

function parseServers(text) {
  const servers = [];
  let thumb = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const bar = t.indexOf('|');
    const name = bar > 0 && !/^https?:/i.test(t.slice(0, bar).trim()) ? t.slice(0, bar).trim().slice(0, 30) : '';
    const link = bar > 0 && name ? t.slice(bar + 1).trim() : t;
    const src = parseSource(link);
    if (src.error) return { servers: [], thumb: '', error: `${src.error} (${link.slice(0, 60)})` };
    servers.push({ name: name || src.provider, kind: src.kind, provider: src.provider, embed: src.embed });
    if (!thumb && src.thumb) thumb = src.thumb;
  }
  return { servers: servers.slice(0, 12), thumb, error: '' };
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

const MESSAGES = {
  mal: 'Contraseña incorrecta.',
  muchos: 'Demasiados intentos. Espera unos minutos.',
  falta: 'Escribe un título.',
  serieok: 'Serie guardada.',
  seriebor: 'Serie eliminada.',
  epok: 'Episodio guardado.',
  epbor: 'Episodio eliminado.',
};

const imgTag = (src, cls = '') =>
  src ? `<img ${cls ? `class="${cls}" ` : ''}src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';

const initial = (s) => `<span class="ph">${esc((s.title[0] || '?').toUpperCase())}</span>`;
const meta = (s) => [s.type, s.year, s.status].filter(Boolean).join(' · ');
const tags = (s, n = 15) =>
  (s.genres || [])
    .slice(0, n)
    .map((g) => `<a class="tag" href="/catalogo?genre=${encodeURIComponent(g)}">${esc(g)}</a>`)
    .join('');

function layout({ title, body, script = false, hls = false, q = '', bare = false }) {
  const head = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="RATING" content="RTA-5042-1996-1400-1577-RTA">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;800&family=Figtree:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/estilos.css">
</head>`;
  if (bare) return `${head}\n<body>\n${body}\n</body>\n</html>`;
  return `${head}
<body>
<header class="top">
  <a class="brand" href="/">${esc(SITE_NAME)}</a>
  <nav class="nav"><a href="/">Inicio</a><a href="/catalogo">Catálogo</a></nav>
  <form class="sbox" action="/catalogo" method="get"><input type="search" name="q" value="${esc(q)}" placeholder="Buscar" aria-label="Buscar"></form>
</header>
<main class="wrap">
${body}
</main>
<footer class="foot"><span>${esc(SITE_NAME)} · Solo para mayores de 18 años</span><a href="/admin">Administrar</a></footer>
${hls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>' : ''}
${script || hls ? '<script src="/app.js" defer></script>' : ''}
</body>
</html>`;
}

function gatePage(next) {
  return layout({
    title: SITE_NAME,
    bare: true,
    body: `<main class="gate">
  <h1>${esc(SITE_NAME)}</h1>
  <p>Este sitio contiene material para adultos. Para entrar debes ser mayor de 18 años.</p>
  <form method="post" action="/mayor">
    <input type="hidden" name="next" value="${esc(next)}">
    <button class="btn" type="submit">Soy mayor de 18 años</button>
  </form>
  <a class="leave" href="https://www.google.com">Salir</a>
</main>`,
  });
}

function poster(s) {
  return `<a class="poster" href="/media/${esc(s.slug)}">
  <div class="pimg">${s.cover ? imgTag(s.cover) : initial(s)}<em class="badge">${esc(s.type)}</em></div>
  <h3>${esc(s.title)}</h3>
</a>`;
}

function epCard(e) {
  const s = e.series;
  const pic = e.thumb || s.backdrop || s.cover;
  return `<a class="ep" href="/media/${esc(s.slug)}/${e.n}">
  <div class="eimg">${pic ? imgTag(pic) : initial(s)}<em class="badge">${esc(ago(e.createdAt))}</em></div>
  <strong>Episodio ${e.n}</strong>
  <span>${esc(s.title)}</span>
</a>`;
}

function hero(list) {
  const slides = list
    .map((s) => {
      const bg = s.backdrop || s.cover;
      return `<article class="slide">
  ${bg ? imgTag(bg, 'bg') : ''}<div class="shade"></div>
  <div class="info">
    <h2>${esc(s.title)}</h2>
    <p class="sub">${esc(meta(s))}</p>
    <div class="chips">${tags(s, 4)}</div>
    ${s.synopsis ? `<p class="syn">${esc(s.synopsis)}</p>` : ''}
    <a class="btn" href="/media/${esc(s.slug)}">Ver ahora</a>
  </div>
</article>`;
    })
    .join('');
  return `<section class="hero"><div class="slides" id="slides">${slides}</div>${list.length > 1 ? '<div class="dots" id="dots"></div>' : ''}</section>`;
}

function homePage(list) {
  if (!list.length) {
    return layout({
      title: SITE_NAME,
      body: `<h1>${esc(SITE_NAME)}</h1><p class="empty">Aún no hay contenido. Agrega la primera serie desde <a href="/admin">el panel</a>.</p>`,
    });
  }
  const feat = list.filter((s) => s.featured);
  const slides = (feat.length ? feat : [...list].sort(byNew)).slice(0, 6);
  const eps = list
    .flatMap((s) => (s.episodes || []).map((e) => ({ ...e, series: s })))
    .sort(byNew)
    .slice(0, 18);
  const added = [...list].sort(byNew).slice(0, 24);
  return layout({
    title: SITE_NAME,
    script: true,
    body: `${hero(slides)}
${eps.length ? `<section class="sec"><div class="sh"><h2>Episodios recientes</h2></div><div class="eps">${eps.map(epCard).join('')}</div></section>` : ''}
<section class="sec"><div class="sh"><h2>Recientemente agregados</h2><a href="/catalogo">Ver catálogo</a></div><div class="posters">${added.map(poster).join('')}</div></section>`,
  });
}

function catalogPage(all, qs) {
  const q = (qs.get('q') || '').trim();
  const genre = qs.get('genre') || '';
  const type = qs.get('type') || '';
  const status = qs.get('status') || '';
  const order = qs.get('order') === 'az' ? 'az' : 'recent';
  const pageNum = Math.max(1, parseInt(qs.get('page'), 10) || 1);

  let list = all.filter(
    (s) =>
      (!q || s.title.toLowerCase().includes(q.toLowerCase())) &&
      (!genre || (s.genres || []).includes(genre)) &&
      (!type || s.type === type) &&
      (!status || s.status === status)
  );
  list = order === 'az' ? list.sort((a, b) => a.title.localeCompare(b.title, 'es')) : list.sort(byNew);

  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const pg = Math.min(pageNum, pages);
  const shown = list.slice((pg - 1) * PER_PAGE, pg * PER_PAGE);
  const genres = [...new Set(all.flatMap((s) => s.genres || []))].sort((a, b) => a.localeCompare(b, 'es'));

  const opt = (val, label, cur) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const link = (n, label) => {
    const u = new URLSearchParams(qs);
    u.set('page', String(n));
    return `<a href="/catalogo?${esc(u.toString())}">${label}</a>`;
  };

  return layout({
    title: `Catálogo | ${SITE_NAME}`,
    q,
    body: `<div class="head"><h1>Catálogo</h1><span class="count">${list.length} ${list.length === 1 ? 'resultado' : 'resultados'}</span></div>
<form class="filters" method="get" action="/catalogo">
  <input type="search" name="q" value="${esc(q)}" placeholder="Buscar por título" aria-label="Buscar por título">
  <select name="genre" aria-label="Género"><option value="">Todos los géneros</option>${genres.map((g) => opt(g, g, genre)).join('')}</select>
  <select name="type" aria-label="Tipo"><option value="">Todos los tipos</option>${TYPES.map((t) => opt(t, t, type)).join('')}</select>
  <select name="status" aria-label="Estado"><option value="">Todos los estados</option>${STATUSES.map((t) => opt(t, t, status)).join('')}</select>
  <select name="order" aria-label="Orden">${opt('recent', 'Más recientes', order)}${opt('az', 'A-Z', order)}</select>
  <button class="btn" type="submit">Filtrar</button>
</form>
${shown.length ? `<div class="posters">${shown.map(poster).join('')}</div>` : '<p class="empty">No hay resultados con esos filtros.</p>'}
${pages > 1 ? `<nav class="pager">${pg > 1 ? link(pg - 1, 'Anterior') : ''}<span>Página ${pg} de ${pages}</span>${pg < pages ? link(pg + 1, 'Siguiente') : ''}</nav>` : ''}`,
  });
}

function epList(s, eps, current) {
  return `<ol class="eplist">${eps
    .map(
      (e) => `<li${e.n === current ? ' class="on"' : ''}><a href="/media/${esc(s.slug)}/${e.n}"><span class="num">${e.n}</span><span class="et">${esc(e.title || 'Episodio ' + e.n)}</span><em>${esc(ago(e.createdAt))}</em></a></li>`
    )
    .join('')}</ol>`;
}

function seriePage(s) {
  const eps = [...(s.episodes || [])].sort((a, b) => a.n - b.n);
  return layout({
    title: `${s.title} | ${SITE_NAME}`,
    body: `<section class="sheet">
  <div class="scover">${s.cover ? imgTag(s.cover) : initial(s)}</div>
  <div class="sinfo">
    <h1>${esc(s.title)}</h1>
    <p class="sub">${esc(meta(s))}</p>
    <div class="chips">${tags(s)}</div>
    ${s.synopsis ? `<p class="syn2">${esc(s.synopsis)}</p>` : ''}
    ${eps.length ? `<a class="btn" href="/media/${esc(s.slug)}/${eps[0].n}">Ver episodio ${eps[0].n}</a>` : ''}
  </div>
</section>
<h2>Episodios</h2>
${eps.length ? epList(s, eps, 0) : '<p class="empty">Todavía no hay episodios.</p>'}`,
  });
}

function episodePage(s, e, idx) {
  const eps = [...(s.episodes || [])].sort((a, b) => a.n - b.n);
  const prev = [...eps].reverse().find((x) => x.n < e.n);
  const next = eps.find((x) => x.n > e.n);
  const sv = e.servers[idx];
  const isHls = sv.kind === 'video' && /\.m3u8(\?|$)/i.test(sv.embed);
  const player = isHls
    ? `<video controls playsinline data-hls="${esc(sv.embed)}"></video>`
    : sv.kind === 'video'
    ? `<video controls preload="metadata" playsinline src="${esc(sv.embed)}"></video>`
    : `<iframe src="${esc(sv.embed)}" title="${esc(s.title)} episodio ${e.n}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  const base = `/media/${esc(s.slug)}/${e.n}`;
  const servers =
    e.servers.length > 1
      ? `<nav class="servers" aria-label="Servidores"><span>Servidor:</span>${e.servers
          .map((v, i) => `<a class="srv${i === idx ? ' on' : ''}" href="${base}?s=${i + 1}">${esc(v.name)}</a>`)
          .join('')}</nav>`
      : '';
  return layout({
    title: `${s.title} episodio ${e.n} | ${SITE_NAME}`,
    hls: isHls,
    body: `<a class="back" href="/media/${esc(s.slug)}">${esc(s.title)}</a>
<div class="player">${player}</div>
${servers}
<h1 class="vt">${esc(s.title)} · Episodio ${e.n}</h1>
${e.title ? `<p class="meta">${esc(e.title)}</p>` : ''}
<nav class="epnav">${prev ? `<a class="btn ghost" href="/media/${esc(s.slug)}/${prev.n}">Anterior</a>` : ''}${next ? `<a class="btn" href="/media/${esc(s.slug)}/${next.n}">Siguiente</a>` : ''}</nav>
<h2>Episodios</h2>
${epList(s, eps, e.n)}`,
  });
}

/* ---------- panel ---------- */

function adminShell(title, inner) {
  return layout({ title: `${title} | ${SITE_NAME}`, body: inner, script: true });
}

const noteHtml = (note, bad) => (note ? `<p class="note ${bad ? 'bad' : ''}">${esc(note)}</p>` : '');

function loginPage(note, bad) {
  if (!ADMIN_PASSWORD) {
    return adminShell('Panel', '<h1>Panel</h1><p class="empty">Define la variable de entorno ADMIN_PASSWORD para activar el panel.</p>');
  }
  return adminShell(
    'Panel',
    `<h1>Entrar al panel</h1>
${noteHtml(note, bad)}
<form class="form narrow" method="post" action="/admin/entrar">
  <label>Contraseña<input type="password" name="password" required autofocus></label>
  <button class="btn" type="submit">Entrar</button>
</form>`
  );
}

function serieFields(s = {}) {
  const v = (k) => esc(s[k] ?? '');
  return `<input type="hidden" name="id" value="${esc(s.id || '')}">
<label>Título<input name="title" maxlength="140" required value="${v('title')}"></label>
<div class="two">
  <label>Tipo<select name="type">${TYPES.map((t) => `<option${s.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
  <label>Estado<select name="status">${STATUSES.map((t) => `<option${s.status === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
  <label>Año<input name="year" inputmode="numeric" maxlength="4" value="${v('year')}"></label>
</div>
<label>Géneros (separados por coma)<input name="genres" value="${esc((s.genres || []).join(', '))}"></label>
<label>Sinopsis<textarea name="synopsis" rows="4" maxlength="1500">${v('synopsis')}</textarea></label>
<label>Portada (imagen vertical)
  <input type="file" name="coverfile" accept="image/*" data-resize>
  <small>Elige una foto y se sube sola. También puedes pegar un enlace.</small>
  <input name="cover" type="url" value="${v('cover')}" placeholder="o pega un enlace https://...">
</label>
<label>Imagen ancha para el carrusel (opcional)
  <input type="file" name="backdropfile" accept="image/*" data-resize>
  <input name="backdrop" type="url" value="${v('backdrop')}" placeholder="o pega un enlace https://...">
</label>
<label class="check"><input type="checkbox" name="featured" value="1"${s.featured ? ' checked' : ''}> Mostrar en el carrusel de la portada</label>`;
}

function adminPage(req, list, note, bad) {
  if (!isAdmin(req)) return loginPage(note, bad);
  const rows = [...list]
    .sort(byNew)
    .map(
      (s) => `<li>
  <div><strong>${esc(s.title)}</strong><span>${esc(meta(s))} · ${(s.episodes || []).length} episodios</span></div>
  <a class="btn ghost" href="/admin/serie/${esc(s.id)}">Editar</a>
</li>`
    )
    .join('');
  return adminShell(
    'Panel',
    `<h1>Panel</h1>
${noteHtml(note, bad)}
<h2>Nueva serie</h2>
<form class="form" method="post" action="/admin/serie/guardar" enctype="multipart/form-data">
  ${serieFields()}
  <button class="btn" type="submit">Crear serie</button>
</form>
<h2>Bot de Telegram</h2>
<p class="meta">Conéctalo una vez, después de configurar TELEGRAM_BOT_TOKEN en Netlify.</p>
<form method="post" action="/admin/telegram/conectar"><button class="btn ghost" type="submit">Conectar bot de Telegram</button></form>
<h2>Series (${list.length})</h2>
<ul class="rows">${rows || '<li><span>No hay series todavía.</span></li>'}</ul>
<form method="post" action="/admin/salir" class="out"><button class="btn ghost" type="submit">Cerrar sesión</button></form>`
  );
}

function adminSeriePage(req, s, note, bad) {
  if (!isAdmin(req)) return loginPage(note, bad);
  const eps = [...(s.episodes || [])].sort((a, b) => a.n - b.n);
  const rows = eps
    .map(
      (e) => `<li class="col">
  <strong>Episodio ${e.n}${e.title ? ' · ' + esc(e.title) : ''}</strong>
  <div class="srvs">${e.servers
    .map(
      (v, i) => `<form method="post" action="/admin/serie/${esc(s.id)}/episodio/${e.n}/servidor/${i}/borrar"><button class="btn ghost" type="submit" title="Quitar este servidor">${esc(v.name)} ✕</button></form>`
    )
    .join('')}</div>
  <div class="srvs"><a class="btn ghost" href="/admin/serie/${esc(s.id)}/episodio/${e.n}/editar">Editar episodio</a><form method="post" action="/admin/serie/${esc(s.id)}/episodio/${e.n}/borrar"><button class="btn ghost" type="submit">Eliminar episodio</button></form></div>
</li>`
    )
    .join('');
  return adminShell(
    s.title,
    `<a class="back" href="/admin">Volver al panel</a>
<h1>${esc(s.title)}</h1>
<p class="meta"><a href="/media/${esc(s.slug)}">Ver en el sitio</a></p>
${noteHtml(note, bad)}
<h2>Episodios (${eps.length})</h2>
<ul class="rows">${rows || '<li><span>No hay episodios todavía.</span></li>'}</ul>
<h2>Agregar episodio o servidores</h2>
<form class="form" method="post" action="/admin/serie/${esc(s.id)}/episodio" enctype="multipart/form-data">
  <label>Número<input name="n" inputmode="numeric" maxlength="4" placeholder="Vacío = el siguiente">
    <small>Si el número ya existe, los enlaces se suman como servidores de ese episodio.</small></label>
  <label>Título del episodio (opcional)<input name="title" maxlength="120"></label>
  <label>Enlaces del video, uno por línea
    <textarea name="urls" rows="5" required placeholder="https://mega.nz/file/...&#10;https://voe.sx/...&#10;Mi servidor | https://..."></textarea>
    <small>Mega, YouTube, Drive, Vimeo, Dropbox, .mp4 y .m3u8 se reconocen solos. Para Voe, Upload, Streamtape y similares usa el enlace de insertar (embed). Para poner un nombre propio: Nombre | enlace.</small>
  </label>
  <label>Imagen del episodio (opcional)
    <input type="file" name="thumbfile" accept="image/*" data-resize>
    <input name="thumb" type="url" placeholder="o pega un enlace https://...">
  </label>
  <button class="btn" type="submit">Guardar</button>
</form>
<h2>Datos de la serie</h2>
<form class="form" method="post" action="/admin/serie/guardar" enctype="multipart/form-data">
  ${serieFields(s)}
  <button class="btn" type="submit">Guardar cambios</button>
</form>
<form method="post" action="/admin/serie/${esc(s.id)}/borrar" class="out"><button class="btn ghost" type="submit">Eliminar serie completa</button></form>`
  );
}

function adminEpisodePage(req, s, e, note, bad) {
  if (!isAdmin(req)) return loginPage(note, bad);
  const lines = e.servers.map((v) => `${v.name} | ${v.embed}`).join('\n');
  return adminShell(
    `${s.title} episodio ${e.n}`,
    `<a class="back" href="/admin/serie/${esc(s.id)}">Volver a ${esc(s.title)}</a>
<h1>Editar episodio ${e.n}</h1>
${noteHtml(note, bad)}
<form class="form" method="post" action="/admin/serie/${esc(s.id)}/episodio/${e.n}/guardar" enctype="multipart/form-data">
  <label>Número<input name="n" inputmode="numeric" maxlength="4" required value="${e.n}"></label>
  <label>Título del episodio (opcional)<input name="title" maxlength="120" value="${esc(e.title || '')}"></label>
  <label>Servidores, uno por línea
    <textarea name="urls" rows="7" required>${esc(lines)}</textarea>
    <small>Formato: Nombre | enlace. Puedes cambiar el nombre, el enlace, el orden, quitar líneas o agregar nuevas. El primero es el que se abre por defecto.</small>
  </label>
  <label>Imagen del episodio (opcional)
    <input type="file" name="thumbfile" accept="image/*" data-resize>
    <input name="thumb" type="url" value="${esc(e.thumb || '')}" placeholder="o pega un enlace https://...">
  </label>
  <button class="btn" type="submit">Guardar cambios</button>
</form>`
  );
}

/* ---------- estilos y script del cliente ---------- */

const CSS = `
:root{--bg:#1b1530;--surface:#261e42;--line:#3a2f5e;--text:#f4f0ff;--muted:#a89fc8;--accent:#ffb454;--bad:#ff7a7a}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.55 'Figtree',system-ui,sans-serif}
a{color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
h1,h2,h3{font-family:'Bricolage Grotesque',sans-serif;line-height:1.15;margin:0}
h1{font-size:clamp(1.8rem,4vw,2.6rem);font-weight:800;letter-spacing:-.02em}
h2{font-size:1.35rem;margin:40px 0 16px}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding:12px clamp(16px,4vw,40px);background:rgba(27,21,48,.94);border-bottom:1px solid var(--line)}
.brand{font:800 1.35rem 'Bricolage Grotesque',sans-serif;text-decoration:none;letter-spacing:-.01em}
.nav{display:flex;gap:18px}
.nav a{color:var(--muted);text-decoration:none}
.nav a:hover{color:var(--text)}
.sbox{margin-left:auto;flex:0 1 280px}
.wrap{max-width:1240px;margin:0 auto;padding:24px clamp(16px,4vw,40px) 70px}
.foot{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:24px clamp(16px,4vw,40px);border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}
.foot a{text-decoration:none}
input,textarea,select{width:100%;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:11px 14px;font:inherit}
input::placeholder,textarea::placeholder{color:#7d74a0}
.btn{display:inline-block;align-self:flex-start;background:var(--accent);color:#2a1d05;border:0;border-radius:8px;padding:11px 20px;font:600 1rem 'Figtree',sans-serif;cursor:pointer;text-decoration:none}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line);padding:7px 14px;font-size:.9rem}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent)}
.empty{color:var(--muted);padding:32px 0}
.empty a{color:var(--accent)}
.badge{position:absolute;top:8px;left:8px;background:var(--accent);color:#2a1d05;font-style:normal;font-weight:600;font-size:.72rem;padding:2px 9px;border-radius:999px}
.ph{display:grid;place-items:center;height:100%;font:800 3rem 'Bricolage Grotesque',sans-serif;color:var(--line)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.tag{border:1px solid var(--line);border-radius:999px;padding:2px 12px;font-size:.85rem;color:var(--muted);text-decoration:none;background:rgba(27,21,48,.6)}
.tag:hover{color:var(--text);border-color:var(--accent)}
.hero{position:relative;border-radius:14px;overflow:hidden;border:1px solid var(--line)}
.slides{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}
.slides::-webkit-scrollbar{display:none}
.slide{position:relative;flex:0 0 100%;scroll-snap-align:start;height:clamp(300px,50vw,460px);background:var(--surface)}
.slide .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(27,21,48,.96) 0%,rgba(27,21,48,.65) 55%,rgba(27,21,48,.1) 100%)}
.info{position:absolute;left:0;bottom:0;max-width:600px;padding:clamp(16px,4vw,40px);display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.info h2{margin:0;font-size:clamp(1.5rem,3.6vw,2.4rem);font-weight:800}
.sub{margin:0;color:var(--muted)}
.syn{margin:0;color:#ddd6f5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dots{position:absolute;right:16px;bottom:14px;display:flex;gap:6px}
.dots button{width:10px;height:10px;border-radius:50%;border:0;background:var(--line);padding:0;cursor:pointer}
.dots button.on{background:var(--accent)}
.sh{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.sh h2{margin:40px 0 16px}
.sh a{color:var(--muted);text-decoration:none;font-size:.95rem}
.sh a:hover{color:var(--accent)}
.eps{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:20px 14px}
.ep{display:block;text-decoration:none}
.eimg,.pimg,.scover{position:relative;overflow:hidden;background:var(--surface);border:1px solid var(--line);border-radius:10px}
.eimg{aspect-ratio:16/9}
.eimg img,.pimg img,.scover img{width:100%;height:100%;object-fit:cover;display:block}
.ep strong{display:block;margin-top:6px;font-size:.95rem}
.ep span{display:block;color:var(--muted);font-size:.85rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.posters{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:22px 16px}
.poster{display:block;text-decoration:none}
.pimg{aspect-ratio:2/3}
.poster h3{font-size:.95rem;font-weight:600;margin-top:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ep:hover .eimg,.poster:hover .pimg,.ep:focus-visible .eimg,.poster:focus-visible .pimg{border-color:var(--accent)}
.head{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.count{color:var(--muted)}
.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:28px}
.filters .btn{width:100%}
.pager{display:flex;justify-content:center;align-items:center;gap:20px;margin-top:36px;color:var(--muted)}
.pager a{color:var(--accent)}
.sheet{display:grid;grid-template-columns:220px 1fr;gap:28px;align-items:start}
.scover{aspect-ratio:2/3}
.sinfo{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.syn2{margin:0;max-width:70ch;color:#ddd6f5}
.eplist{list-style:none;margin:0;padding:0;max-width:820px}
.eplist a{display:flex;align-items:center;gap:14px;padding:12px 10px;border-bottom:1px solid var(--line);text-decoration:none}
.eplist a:hover{background:var(--surface)}
.eplist .num{flex:0 0 38px;height:38px;display:grid;place-items:center;border-radius:8px;background:var(--surface);border:1px solid var(--line);font-weight:600}
.eplist .et{flex:1}
.eplist em{font-style:normal;color:var(--muted);font-size:.85rem}
.eplist li.on a{background:var(--surface)}
.eplist li.on .num{background:var(--accent);color:#2a1d05;border-color:var(--accent)}
.back{display:inline-block;color:var(--muted);text-decoration:none;margin-bottom:14px;font-size:.95rem}
.back:hover{color:var(--text)}
.player{aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.player iframe,.player video{width:100%;height:100%;border:0;display:block}
.vt{font-size:clamp(1.4rem,3.4vw,2rem);margin-top:18px}
.meta{color:var(--muted);margin:6px 0 0}
.epnav{display:flex;gap:10px;margin-top:16px}
.form{display:flex;flex-direction:column;gap:16px;max-width:600px}
.form.narrow{max-width:360px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
label{display:flex;flex-direction:column;gap:6px;font-weight:500}
label.check{flex-direction:row;align-items:center;gap:10px}
label.check input{width:auto}
small{color:var(--muted);font-weight:400}
.note{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px 14px;max-width:600px}
.note.bad{border-color:var(--bad);color:var(--bad)}
.rows{list-style:none;margin:0;padding:0;max-width:760px}
.rows li{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
.rows span{display:block;color:var(--muted);font-size:.9rem}
.out{margin-top:32px}
.servers{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px;color:var(--muted)}
.srv{border:1px solid var(--line);border-radius:8px;padding:6px 14px;text-decoration:none;color:var(--text);background:var(--surface)}
.srv:hover{border-color:var(--accent)}
.srv.on{background:var(--accent);border-color:var(--accent);color:#2a1d05;font-weight:600}
.rows li.col{flex-direction:column;align-items:flex-start;gap:8px}
.srvs{display:flex;flex-wrap:wrap;gap:6px}
.gate{max-width:460px;margin:0 auto;padding:18vh 24px 40px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:18px}
.gate p{color:var(--muted);margin:0}
.gate .leave{color:var(--muted);font-size:.9rem}
@media (max-width:640px){.eps{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:18px 12px}.sheet{grid-template-columns:1fr}.scover{max-width:200px}.sbox{flex-basis:100%;margin-left:0}.nav{margin-left:auto}}
@media (prefers-reduced-motion:no-preference){.eimg,.pimg{transition:border-color .15s}}
`;

const CLIENT_JS = `
(function () {
  var inputs = document.querySelectorAll('input[type=file][data-resize]');
  Array.prototype.forEach.call(inputs, function (input) {
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f || f.type.indexOf('image/') !== 0 || f.size < 1500000 || !window.createImageBitmap) return;
      createImageBitmap(f).then(function (bmp) {
        var k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        var c = document.createElement('canvas');
        c.width = Math.round(bmp.width * k);
        c.height = Math.round(bmp.height * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        c.toBlob(function (b) {
          if (!b) return;
          var nf = new File([b], 'imagen.jpg', { type: 'image/jpeg' });
          var dt = new DataTransfer();
          dt.items.add(nf);
          input.files = dt.files;
        }, 'image/jpeg', 0.88);
      });
    });
  });
})();
(function () {
  var v = document.querySelector('video[data-hls]');
  if (!v) return;
  var src = v.getAttribute('data-hls');
  if (window.Hls && window.Hls.isSupported()) {
    var h = new window.Hls();
    h.loadSource(src);
    h.attachMedia(v);
  } else {
    v.src = src;
  }
})();
(function () {
  var sl = document.getElementById('slides');
  if (!sl) return;
  var slides = Array.prototype.slice.call(sl.children);
  var dots = document.getElementById('dots');
  var cur = 0;
  var paused = false;
  function mark() {
    if (!dots) return;
    Array.prototype.forEach.call(dots.children, function (b, k) { b.className = k === cur ? 'on' : ''; });
  }
  function go(k) {
    cur = k;
    sl.scrollTo({ left: k * sl.clientWidth, behavior: 'smooth' });
    mark();
  }
  if (dots) {
    slides.forEach(function (_, k) {
      var b = document.createElement('button');
      b.setAttribute('aria-label', 'Ir a la imagen ' + (k + 1));
      b.addEventListener('click', function () { paused = true; go(k); });
      dots.appendChild(b);
    });
    mark();
  }
  sl.addEventListener('scroll', function () {
    var k = Math.round(sl.scrollLeft / sl.clientWidth);
    if (k !== cur) { cur = k; mark(); }
  });
  sl.addEventListener('pointerdown', function () { paused = true; });
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && slides.length > 1) {
    setInterval(function () { if (!paused) go((cur + 1) % slides.length); }, 7000);
  }
})();
`;

/* ---------- bot de Telegram ---------- */

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_OWNERS = [
  ...new Set(
    ['8608744395', ...(process.env.TELEGRAM_OWNER_IDS || '').split(','), ...(process.env.TELEGRAM_ADMIN_IDS || '').split(',')]
      .map((x) => x.trim())
      .filter(Boolean)
  ),
];
const tgSecret = () => crypto.createHmac('sha256', SECRET || 'sin-clave').update('telegram').digest('hex').slice(0, 48);

async function tg(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch {
    return { ok: false, description: 'sin conexión con Telegram' };
  }
}

const stKey = (chat) => `tg-${chat}`;
async function getState(chat) {
  try {
    return await getStore('videoteca').get(stKey(chat), { type: 'json' });
  } catch {
    return null;
  }
}
const setState = (chat, st) => getStore('videoteca').setJSON(stKey(chat), st);
async function clearState(chat) {
  try {
    await getStore('videoteca').delete(stKey(chat));
  } catch {
    /* sin estado */
  }
}

const B = (text, data) => ({ text, callback_data: data });
async function getAccess() {
  try {
    const d = await getStore('videoteca').get('tg-access', { type: 'json' });
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}
const setAccess = (list) => getStore('videoteca').setJSON('tg-access', list);

async function roleOf(userId) {
  const id = String(userId);
  if (TG_OWNERS.includes(id)) return 'owner';
  const list = await getAccess();
  return list.some((x) => x.id === id) ? 'premium' : null;
}

async function ownerCommand(c, text) {
  const m = text.match(/^\/(premium|quitarpremium|premiums)(?:@\w+)?(?:\s+(\S+))?/i);
  const cmd = m[1].toLowerCase();
  const raw = (m[2] || '').replace(/^\+/, '');
  const list = await getAccess();
  const fmt = (x) => `• ${esc(x.id)}${x.label ? ' · ' + esc(x.label) : ''} (${x.id.startsWith('-') ? 'grupo' : 'usuario'})`;
  if (cmd === 'premiums' || !raw) {
    return show(
      c,
      `<b>Acceso premium</b>\n${list.length ? list.map(fmt).join('\n') : 'Nadie por ahora.'}\n\n/premium ID: dar acceso a un usuario o grupo\n/quitarpremium ID: quitar el acceso\n/premiums: ver la lista`
    );
  }
  if (!/^-?\d{5,20}$/.test(raw)) return show(c, 'Escribe un ID numérico. Ejemplo: /premium 123456789');
  if (cmd === 'quitarpremium') {
    if (!list.some((x) => x.id === raw)) return show(c, 'Ese ID no está en la lista premium.');
    await setAccess(list.filter((x) => x.id !== raw));
    return show(c, `✅ Acceso quitado a ${esc(raw)}.`);
  }
  if (TG_OWNERS.includes(raw)) return show(c, 'Ese ID ya es dueño.');
  if (list.some((x) => x.id === raw)) return show(c, 'Ese ID ya tiene acceso.');
  const info = await tg('getChat', { chat_id: Number(raw) });
  const r = info.ok && info.result ? info.result : {};
  const label = String(r.title || [r.first_name, r.last_name].filter(Boolean).join(' ') || (r.username ? '@' + r.username : '')).slice(0, 40);
  const item = { id: raw, label, addedAt: new Date().toISOString() };
  list.push(item);
  await setAccess(list);
  if (!raw.startsWith('-')) await tg('sendMessage', { chat_id: Number(raw), text: 'Ya tienes acceso al bot. Escribe /start para empezar.' });
  const nota = raw.startsWith('-')
    ? '\nSus miembros podrán usar el bot dentro del grupo con /menu. En privado solo responde a quien tenga su propio ID premium.\nEl bot debe estar en el grupo y con el modo privado desactivado en BotFather (/setprivacy, Disable).'
    : '';
  return show(c, `✅ Acceso dado a ${fmt(item)}.${nota}`);
}

const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

async function show(c, text, rows) {
  const payload = { chat_id: c.chat, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (rows) payload.reply_markup = { inline_keyboard: rows };
  if (c.msgId) {
    const r = await tg('editMessageText', { ...payload, message_id: c.msgId });
    if (r.ok || /not modified/i.test(r.description || '')) return;
  }
  await tg('sendMessage', payload);
}

async function mutate(sid, fn) {
  const list = await load();
  const s = list.find((x) => x.id === sid);
  if (!s) return null;
  await fn(s, list);
  await save(list);
  return s;
}

/* ---------- pantallas ---------- */

async function showMain(c, note = '') {
  const owner = c.role === 'owner' && !c.group ? '\n\nDueño: /premium ID · /quitarpremium ID · /premiums' : '';
  await show(c, `${note ? note + '\n\n' : ''}<b>${esc(SITE_NAME)}</b>\nElige una opción:${owner}`, [
    [B('➕ Nueva serie', 'ns')],
    [B('📚 Mis series', 'ls:0')],
    [{ text: '🌐 Ver el sitio', url: c.origin }],
  ]);
}

async function showSeriesList(c, page) {
  const list = (await load()).sort(byNew);
  if (!list.length) return show(c, 'Aún no hay series.', [[B('➕ Nueva serie', 'ns')], [B('⬅️ Menú', 'm')]]);
  const per = 8;
  const pages = Math.ceil(list.length / per);
  const pg = Math.min(Math.max(page, 0), pages - 1);
  const rows = list.slice(pg * per, pg * per + per).map((s) => [B(trunc(s.title, 48), `s:${s.id}`)]);
  const nav = [];
  if (pg > 0) nav.push(B('◀️', `ls:${pg - 1}`));
  if (pg < pages - 1) nav.push(B('▶️', `ls:${pg + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([B('⬅️ Menú', 'm')]);
  return show(c, `<b>Series</b> (${list.length}) · página ${pg + 1} de ${pages}`, rows);
}

async function showSeries(c, sid, note = '') {
  const s = (await load()).find((x) => x.id === sid);
  if (!s) return showMain(c, 'Esa serie ya no existe.');
  const text = `${note ? note + '\n\n' : ''}<b>${esc(s.title)}</b>
${esc(meta(s))}
Géneros: ${esc((s.genres || []).join(', ') || '—')}
Episodios: ${(s.episodes || []).length}
En el carrusel: ${s.featured ? 'sí' : 'no'}`;
  return show(c, text, [
    [B('➕ Agregar episodio', `ae:${sid}`), B('🎞 Episodios', `le:${sid}`)],
    [B('✏️ Editar datos', `ed:${sid}`)],
    [{ text: '🌐 Ver en el sitio', url: `${c.origin}/media/${s.slug}` }],
    [B('🗑 Eliminar serie', `ds:${sid}`)],
    [B('⬅️ Series', 'ls:0')],
  ]);
}

async function showEditMenu(c, sid) {
  const s = (await load()).find((x) => x.id === sid);
  if (!s) return showMain(c, 'Esa serie ya no existe.');
  return show(c, `<b>Editar ${esc(s.title)}</b>\n¿Qué quieres cambiar?`, [
    [B('Título', `es:${sid}:t`), B('Tipo', `es:${sid}:ty`)],
    [B('Estado', `es:${sid}:st`), B('Año', `es:${sid}:y`)],
    [B('Géneros', `es:${sid}:g`), B('Sinopsis', `es:${sid}:sy`)],
    [B('Portada', `es:${sid}:c`), B('Imagen ancha', `es:${sid}:b`)],
    [B(s.featured ? 'Quitar del carrusel' : 'Poner en el carrusel', `tf:${sid}`)],
    [B('⬅️ Volver', `s:${sid}`)],
  ]);
}

async function showEpisodes(c, sid) {
  const s = (await load()).find((x) => x.id === sid);
  if (!s) return showMain(c, 'Esa serie ya no existe.');
  const eps = [...s.episodes].sort((a, b) => a.n - b.n);
  const rows = [];
  for (let i = 0; i < eps.length; i += 4) rows.push(eps.slice(i, i + 4).map((e) => B(`Ep ${e.n}`, `e:${sid}:${e.n}`)));
  rows.push([B('➕ Agregar episodio', `ae:${sid}`)], [B('⬅️ Volver', `s:${sid}`)]);
  return show(c, `<b>${esc(s.title)}</b>\n${eps.length ? 'Elige un episodio:' : 'Todavía no hay episodios.'}`, rows);
}

async function showEpisode(c, sid, n, note = '') {
  const s = (await load()).find((x) => x.id === sid);
  const e = s && s.episodes.find((x) => x.n === n);
  if (!e) return showEpisodes(c, sid);
  const srv = e.servers.map((v, i) => `${i + 1}. ${esc(v.name)}`).join('\n');
  const text = `${note ? note + '\n\n' : ''}<b>${esc(s.title)} · Episodio ${e.n}</b>
Título: ${esc(e.title || '—')}
Imagen: ${e.thumb ? 'sí' : 'no'}
Servidores:
${srv}`;
  return show(c, text, [
    [B('🔢 Número', `ee:${sid}:${n}:n`), B('✏️ Título', `ee:${sid}:${n}:t`)],
    [B('🖼 Imagen', `ee:${sid}:${n}:i`)],
    [B('♻️ Reemplazar servidores', `ee:${sid}:${n}:u`)],
    [B('➕ Agregar servidores', `ee:${sid}:${n}:a`), B('➖ Quitar uno', `rs:${sid}:${n}`)],
    [{ text: '▶️ Ver episodio', url: `${c.origin}/media/${s.slug}/${n}` }],
    [B('🗑 Eliminar episodio', `de:${sid}:${n}`)],
    [B('⬅️ Episodios', `le:${sid}`)],
  ]);
}

/* ---------- asistentes paso a paso ---------- */

const SERIE_KINDS = { title: 'text', type: 'choice', status: 'choice', year: 'year', genres: 'genres', synopsis: 'text', cover: 'image', backdrop: 'image', featured: 'yesno' };
const SERIE_ASK = {
  title: 'Escribe el <b>título</b> de la serie.',
  type: '¿Qué <b>tipo</b> es?',
  status: '¿En qué <b>estado</b> está?',
  year: 'Escribe el <b>año</b> (4 cifras).',
  genres: 'Escribe los <b>géneros</b> separados por coma.\nEjemplo: Comedia, Acción',
  synopsis: 'Escribe la <b>sinopsis</b>.',
  cover: 'Envía la <b>portada</b>: una foto o un enlace de imagen.',
  backdrop: 'Envía la <b>imagen ancha</b> del carrusel: una foto o un enlace.',
  featured: '¿Mostrarla en el carrusel de la portada?',
};
const NEW_ORDER = Object.keys(SERIE_KINDS);
const EP_KINDS = { n: 'epnum', title: 'text', urls: 'servers', thumb: 'image', add: 'servers' };
const EP_ASK = {
  n: 'Escribe el <b>número</b> del episodio.',
  title: 'Escribe el <b>título</b> del episodio.',
  urls: 'Envía los <b>enlaces de video</b>. Si son varios, uno por línea; el servidor se detecta solo.',
  thumb: 'Envía la <b>imagen del episodio</b>: una foto o un enlace.',
  add: 'Envía los <b>enlaces</b> que quieres agregar. Si son varios, uno por línea.',
};
const EP_ORDER = ['n', 'title', 'urls', 'thumb'];
const SERIE_CODES = { t: 'title', ty: 'type', st: 'status', y: 'year', g: 'genres', sy: 'synopsis', c: 'cover', b: 'backdrop' };
const EP_CODES = { n: 'n', t: 'title', i: 'thumb', u: 'urls', a: 'add' };

const optsOf = (k) => (k === 'type' ? TYPES : k === 'status' ? STATUSES : null);

function stepOf(st) {
  if (st.flow === 'new') {
    const k = NEW_ORDER[st.i];
    return k ? { k, kind: SERIE_KINDS[k], ask: SERIE_ASK[k], skip: k !== 'title', opts: optsOf(k) } : null;
  }
  if (st.flow === 'edit') {
    const k = st.k;
    return { k, kind: SERIE_KINDS[k], ask: SERIE_ASK[k], skip: false, clear: ['year', 'genres', 'synopsis', 'cover', 'backdrop'].includes(k), opts: optsOf(k) };
  }
  if (st.flow === 'addep') {
    const k = EP_ORDER[st.i];
    return k ? { k, kind: EP_KINDS[k], ask: EP_ASK[k], skip: k !== 'urls', skipLabel: k === 'n' ? 'Siguiente número' : 'Omitir' } : null;
  }
  if (st.flow === 'editep') {
    const k = st.k;
    const ask = k === 'urls' ? 'Envía los <b>enlaces nuevos</b>, uno por línea. Reemplazan a los actuales.' : EP_ASK[k];
    return { k, kind: EP_KINDS[k], ask, skip: false, clear: k === 'title' || k === 'thumb' };
  }
  return null;
}

async function promptStep(c, st, note = '') {
  const step = stepOf(st);
  if (!step) return showMain(c);
  let rows = [];
  if (step.kind === 'choice') rows = step.opts.map((o, i) => [B(o, `w:c:${i}`)]);
  else if (step.kind === 'yesno') rows = [[B('Sí', 'w:y:1'), B('No', 'w:y:0')]];
  else if (step.skip) rows = [[B(step.skipLabel || 'Omitir', 'w:sk')]];
  rows.push([B('✖ Cancelar', 'w:cx')]);
  const hint = step.clear ? '\nEnvía - para dejarlo vacío.' : '';
  await show(c, `${note ? note + '\n\n' : ''}${step.ask}${hint}`, rows);
}

async function imageFrom(msg) {
  let fileId = '';
  if (Array.isArray(msg.photo) && msg.photo.length) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document && String(msg.document.mime_type || '').startsWith('image/')) fileId = msg.document.file_id;
  if (fileId) {
    const info = await tg('getFile', { file_id: fileId });
    if (!info.ok) throw new Error('No pude leer la imagen de Telegram.');
    const path = String(info.result.file_path || '');
    const res = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${path}`);
    if (!res.ok) throw new Error('No pude descargar la imagen de Telegram.');
    const type = /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg';
    return uploadImage(new Blob([await res.arrayBuffer()], { type }));
  }
  return cleanUrl(String(msg.text || '').trim());
}

async function parseValue(step, msg) {
  const text = String(msg.text || '').trim();
  if (step.kind === 'image') {
    if (step.clear && text === '-') return { value: '' };
    const img = await imageFrom(msg);
    return img ? { value: img } : { error: 'Envía una foto o un enlace de imagen.' };
  }
  if (!text) return { error: 'Envíalo como texto.' };
  if (step.clear && text === '-') return { value: step.kind === 'genres' ? [] : '' };
  if (step.kind === 'text') return { value: text.slice(0, 1500) };
  if (step.kind === 'year') return /^\d{4}$/.test(text) ? { value: text } : { error: 'Escribe un año de 4 cifras.' };
  if (step.kind === 'genres') {
    const g = parseGenres(text);
    return g.length ? { value: g } : { error: 'Escribe al menos un género.' };
  }
  if (step.kind === 'epnum') {
    const n = parseInt(text, 10);
    return /^\d{1,4}$/.test(text) && n >= 1 ? { value: n } : { error: 'Escribe un número válido, por ejemplo 5.' };
  }
  if (step.kind === 'servers') {
    const r = parseServers(text);
    if (r.error) return { error: r.error };
    return r.servers.length ? { value: r } : { error: 'Envía al menos un enlace.' };
  }
  return { error: 'No entendí eso.' };
}

async function startNew(c) {
  await setState(c.key, { flow: 'new', i: 0, d: {} });
  await promptStep(c, { flow: 'new', i: 0, d: {} });
}

async function startEdit(c, sid, code) {
  const k = SERIE_CODES[code];
  if (!k) return showEditMenu(c, sid);
  const st = { flow: 'edit', sid, k };
  await setState(c.key, st);
  await promptStep(c, st);
}

async function startAddEp(c, sid) {
  const st = { flow: 'addep', sid, i: 0, d: {} };
  await setState(c.key, st);
  await promptStep(c, st);
}

async function startEditEp(c, sid, n, code) {
  const k = EP_CODES[code];
  if (!k) return showEpisode(c, sid, n);
  const st = { flow: 'editep', sid, n, k };
  await setState(c.key, st);
  await promptStep(c, st);
}

async function finishNew(c, st) {
  const d = st.d;
  const list = await load();
  const s = {
    id: crypto.randomUUID().slice(0, 8),
    slug: uniqueSlug(list, d.title),
    episodes: [],
    createdAt: new Date().toISOString(),
    title: String(d.title).slice(0, 140),
    type: d.type || TYPES[0],
    status: d.status || STATUSES[0],
    year: d.year || '',
    genres: d.genres || [],
    synopsis: d.synopsis || '',
    cover: d.cover || '',
    backdrop: d.backdrop || '',
    featured: Boolean(d.featured),
  };
  list.unshift(s);
  await save(list);
  await clearState(c.key);
  await showSeries(c, s.id, '✅ Serie creada. Ahora puedes agregar sus episodios.');
}

async function finishAddEp(c, st) {
  const d = st.d;
  let finalN = 0;
  const s = await mutate(st.sid, (s) => {
    let n = d.n;
    if (!(n >= 1 && n <= 9999)) n = Math.max(0, ...s.episodes.map((e) => e.n)) + 1;
    finalN = n;
    const thumb = d.thumb || d.thumbAuto || '';
    const ex = s.episodes.find((e) => e.n === n);
    if (ex) {
      ex.servers = [...ex.servers, ...d.servers].slice(0, 12);
      if (!ex.thumb && thumb) ex.thumb = thumb;
      if (d.title) ex.title = d.title;
    } else {
      s.episodes.push({ n, title: d.title || '', thumb, servers: d.servers, createdAt: new Date().toISOString() });
      s.episodes.sort((a, b) => a.n - b.n);
    }
  });
  await clearState(c.key);
  if (!s) return showMain(c, 'Esa serie ya no existe.');
  await showEpisode(c, st.sid, finalN, '✅ Episodio guardado.');
}

// value === undefined significa "omitir este paso"
async function applyValue(c, st, step, value) {
  if (st.flow === 'new') {
    if (value !== undefined) st.d[step.k] = value;
    st.i += 1;
    if (NEW_ORDER[st.i]) {
      await setState(c.key, st);
      return promptStep(c, st);
    }
    return finishNew(c, st);
  }

  if (st.flow === 'edit') {
    await mutate(st.sid, (s) => {
      s[st.k] = st.k === 'title' ? String(value).slice(0, 140) : value;
    });
    await clearState(c.key);
    return showSeries(c, st.sid, '✅ Guardado.');
  }

  if (st.flow === 'addep') {
    if (value !== undefined) {
      if (step.k === 'urls') {
        st.d.servers = value.servers;
        if (value.thumb) st.d.thumbAuto = value.thumb;
      } else if (step.k === 'title') st.d.title = String(value).slice(0, 120);
      else st.d[step.k] = value;
    }
    st.i += 1;
    if (EP_ORDER[st.i]) {
      await setState(c.key, st);
      return promptStep(c, st);
    }
    return finishAddEp(c, st);
  }

  if (st.flow === 'editep') {
    let err = '';
    let nn = st.n;
    await mutate(st.sid, (s) => {
      const e = s.episodes.find((x) => x.n === st.n);
      if (!e) return;
      if (st.k === 'n') {
        if (value !== e.n && s.episodes.some((x) => x.n === value)) {
          err = 'Ya existe otro episodio con ese número.';
          return;
        }
        e.n = value;
        nn = value;
        s.episodes.sort((a, b) => a.n - b.n);
      } else if (st.k === 'title') e.title = String(value).slice(0, 120);
      else if (st.k === 'thumb') e.thumb = value;
      else if (st.k === 'urls') {
        e.servers = value.servers;
        if (!e.thumb && value.thumb) e.thumb = value.thumb;
      } else if (st.k === 'add') e.servers = [...e.servers, ...value.servers].slice(0, 12);
    });
    if (err) return promptStep(c, st, err);
    await clearState(c.key);
    return showEpisode(c, st.sid, nn, '✅ Guardado.');
  }
}

async function onInput(c, st, msg) {
  const step = stepOf(st);
  if (!step) {
    await clearState(c.key);
    return showMain(c);
  }
  if (step.kind === 'choice' || step.kind === 'yesno') return promptStep(c, st, 'Usa los botones para elegir.');
  const r = await parseValue(step, msg);
  if (r.error) return promptStep(c, st, r.error);
  return applyValue(c, st, step, r.value);
}

async function onWizard(c, parts) {
  const st = await getState(c.key);
  if (!st) return showMain(c);
  const [a, b] = parts;
  if (a === 'cx') {
    await clearState(c.key);
    if (st.sid && st.n) return showEpisode(c, st.sid, st.n);
    if (st.sid) return showSeries(c, st.sid);
    return showMain(c);
  }
  const step = stepOf(st);
  if (!step) return showMain(c);
  if (a === 'sk') return step.skip ? applyValue(c, st, step, undefined) : promptStep(c, st);
  if (a === 'c' && step.opts && step.opts[Number(b)] !== undefined) return applyValue(c, st, step, step.opts[Number(b)]);
  if (a === 'y' && step.kind === 'yesno') return applyValue(c, st, step, b === '1');
  return promptStep(c, st);
}

/* ---------- botones y mensajes ---------- */

async function onCallback(c, data) {
  const [op, x, y, z] = data.split(':');

  if (op === 'w') return onWizard(c, [x, y]);

  if (op === 'm') {
    await clearState(c.key);
    return showMain(c);
  }
  if (op === 'ls') return showSeriesList(c, Number(x) || 0);
  if (op === 'ns') return startNew(c);
  if (op === 's') {
    await clearState(c.key);
    return showSeries(c, x);
  }
  if (op === 'ed') return showEditMenu(c, x);
  if (op === 'es') return startEdit(c, x, y);
  if (op === 'tf') {
    const s = await mutate(x, (s) => {
      s.featured = !s.featured;
    });
    return s ? showEditMenu(c, x) : showMain(c, 'Esa serie ya no existe.');
  }
  if (op === 'ds') {
    const s = (await load()).find((v) => v.id === x);
    if (!s) return showMain(c, 'Esa serie ya no existe.');
    return show(c, `¿Eliminar <b>${esc(s.title)}</b> con todos sus episodios?`, [[B('Sí, eliminar', `dsy:${x}`)], [B('Cancelar', `s:${x}`)]]);
  }
  if (op === 'dsy') {
    await save((await load()).filter((v) => v.id !== x));
    return showSeriesList(c, 0);
  }
  if (op === 'ae') return startAddEp(c, x);
  if (op === 'le') return showEpisodes(c, x);
  if (op === 'e') return showEpisode(c, x, Number(y));
  if (op === 'ee') return startEditEp(c, x, Number(y), z);
  if (op === 'rs') {
    const s = (await load()).find((v) => v.id === x);
    const e = s && s.episodes.find((v) => v.n === Number(y));
    if (!e) return showEpisodes(c, x);
    const rows = e.servers.map((v, i) => [B(`✕ ${trunc(v.name, 40)}`, `rsx:${x}:${y}:${i}`)]);
    rows.push([B('⬅️ Volver', `e:${x}:${y}`)]);
    return show(c, '¿Qué servidor quieres quitar?', rows);
  }
  if (op === 'rsx') {
    let gone = false;
    await mutate(x, (s) => {
      const e = s.episodes.find((v) => v.n === Number(y));
      if (!e) return;
      e.servers = e.servers.filter((_, i) => i !== Number(z));
      if (!e.servers.length) {
        s.episodes = s.episodes.filter((v) => v !== e);
        gone = true;
      }
    });
    return gone ? showEpisodes(c, x) : showEpisode(c, x, Number(y), '✅ Servidor quitado.');
  }
  if (op === 'de') {
    return show(c, `¿Eliminar el episodio ${esc(y)}?`, [[B('Sí, eliminar', `dey:${x}:${y}`)], [B('Cancelar', `e:${x}:${y}`)]]);
  }
  if (op === 'dey') {
    await mutate(x, (s) => {
      s.episodes = s.episodes.filter((v) => v.n !== Number(y));
    });
    return showEpisodes(c, x);
  }
  return showMain(c);
}

async function onMessage(c, msg) {
  const text = String(msg.text || '').trim();
  if (/^\/(premium|quitarpremium|premiums)\b/i.test(text)) {
    if (c.group) return;
    if (c.role === 'owner') return ownerCommand(c, text);
    return show(c, 'Ese comando es solo para el dueño.');
  }
  if (/^\/(start|menu|cancelar|cancel)\b/i.test(text)) {
    await clearState(c.key);
    return showMain(c);
  }
  const st = await getState(c.key);
  if (!st) return c.group ? undefined : showMain(c, 'Usa los botones para administrar el sitio.');
  return onInput(c, st, msg);
}

async function onUpdate(u, origin) {
  const cb = u.callback_query;
  const msg = cb ? cb.message : u.message;
  if (!msg || !msg.chat) return;
  const from = (cb ? cb.from : msg.from) || {};
  const isOwner = TG_OWNERS.includes(String(from.id));
  const isGroup = msg.chat.type !== 'private';
  const text = String(msg.text || '').trim();
  const c = {
    chat: msg.chat.id,
    key: `${msg.chat.id}-${from.id}`,
    origin,
    msgId: cb ? msg.message_id : 0,
    group: isGroup,
    role: null,
  };

  if (isGroup) {
    // el dueño agrega o quita el grupo escribiendo el comando dentro de él
    const m = text.match(/^\/(premium|quitarpremium)(?:@\w+)?$/i);
    if (!cb && isOwner && m) return ownerCommand({ ...c, role: 'owner' }, `/${m[1].toLowerCase()} ${msg.chat.id}`);
    const allowed = isOwner || (await getAccess()).some((x) => x.id === String(msg.chat.id));
    if (!allowed) return;
    c.role = isOwner ? 'owner' : 'premium';
  } else {
    c.role = await roleOf(from.id);
    if (!c.role) {
      if (cb) {
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
      } else {
        await tg('sendMessage', {
          chat_id: c.chat,
          text: `No tienes permiso para usar este bot.\nTu ID de Telegram es ${from.id}. Pídele al dueño que te dé acceso con /premium ${from.id}.`,
        });
      }
      return;
    }
  }

  try {
    if (cb) {
      await tg('answerCallbackQuery', { callback_query_id: cb.id });
      await onCallback(c, String(cb.data || ''));
    } else {
      await onMessage(c, msg);
    }
  } catch (err) {
    await tg('sendMessage', { chat_id: c.chat, text: `Ocurrió un error: ${(err && err.message) || 'intenta de nuevo'}` });
  }
}

async function handleTelegram(req) {
  if (!TG_TOKEN) return new Response('apagado', { status: 404 });
  if (req.headers.get('x-telegram-bot-api-secret-token') !== tgSecret()) return new Response('no', { status: 403 });
  let u;
  try {
    u = await req.json();
  } catch {
    return new Response('ok');
  }
  try {
    await onUpdate(u, new URL(req.url).origin);
  } catch (err) {
    console.error('telegram', err && err.message);
  }
  return new Response('ok');
}

/* ---------- respuestas ---------- */

const SECURITY = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    'img-src * data:',
    'media-src * blob:',
    'connect-src *',
    'worker-src blob:',
    'frame-src https:',
    "form-action 'self'",
    "base-uri 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const send = (body, type, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': type, ...SECURITY, ...extra } });
const page = (html, status = 200, extra = {}) => send(html, 'text/html; charset=utf-8', status, extra);
const go = (req, to, extra = {}) =>
  new Response(null, { status: 303, headers: { Location: new URL(to, req.url).href, ...extra } });
const notFound = (msg) =>
  page(layout({ title: 'No encontrado', body: `<h1>${esc(msg)}</h1><p class="empty"><a href="/">Volver al inicio</a></p>` }), 404);

const safeNext = (n) => (/^\/(?![\/\\])/.test(String(n || '')) ? String(n) : '/');
const isBadMsg = (k) => k === 'mal' || k === 'muchos' || k === 'falta';

/* ---------- rutas ---------- */

export default async (req, context) => {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const isGet = req.method === 'GET' || req.method === 'HEAD';

  if (isGet) {
    if (p === '/estilos.css') return send(CSS, 'text/css; charset=utf-8', 200, { 'Cache-Control': 'public, max-age=300' });
    if (p === '/app.js') return send(CLIENT_JS, 'application/javascript; charset=utf-8', 200, { 'Cache-Control': 'public, max-age=300' });
    if (p === '/salud') return send('ok', 'text/plain');
  }

  if (req.method === 'POST' && p === '/telegram/hook') return handleTelegram(req);

  let form = null;
  let fd = null;
  if (req.method === 'POST') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) return send('Solicitud rechazada', 'text/plain', 403);
    if ((req.headers.get('content-type') || '').startsWith('multipart/form-data')) {
      if (Number(req.headers.get('content-length') || 0) > 5.5 * 1024 * 1024) return send('La imagen es demasiado grande (máximo 5 MB).', 'text/plain', 413);
      try {
        fd = await req.formData();
      } catch {
        return send('Solicitud no válida', 'text/plain', 400);
      }
      form = { get: (k) => (typeof fd.get(k) === 'string' ? fd.get(k) : null) };
    } else {
      const raw = await req.text();
      if (raw.length > 30000) return send('Solicitud demasiado grande', 'text/plain', 413);
      form = new URLSearchParams(raw);
    }
  } else if (!isGet) {
    return send('Método no permitido', 'text/plain', 405);
  }

  /* confirmación de mayoría de edad */
  if (req.method === 'POST' && p === '/mayor') {
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    return go(req, safeNext(form.get('next')), {
      'Set-Cookie': `mayor=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 365}${secure}`,
    });
  }

  /* panel */
  if (p === '/admin' || p.startsWith('/admin/')) {
    const list = await load();

    if (isGet) {
      if (p === '/admin') {
        const k = url.searchParams.get('m');
        return page(adminPage(req, list, MESSAGES[k] || '', isBadMsg(k)));
      }
      const m = p.match(/^\/admin\/serie\/([\w-]+)$/);
      if (m) {
        const s = list.find((x) => x.id === m[1]);
        if (!s) return notFound('Serie no encontrada');
        const k = url.searchParams.get('m');
        return page(adminSeriePage(req, s, MESSAGES[k] || '', isBadMsg(k)));
      }
      const me = p.match(/^\/admin\/serie\/([\w-]+)\/episodio\/(\d+)\/editar$/);
      if (me) {
        const s = list.find((x) => x.id === me[1]);
        const e = s && s.episodes.find((x) => x.n === Number(me[2]));
        if (!e) return notFound('Episodio no encontrado');
        return page(adminEpisodePage(req, s, e, '', false));
      }
      return notFound('Página no encontrada');
    }

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

    if (!isAdmin(req)) return go(req, '/admin');

    if (p === '/admin/serie/guardar') {
      const title = String(form.get('title') || '').trim().slice(0, 140);
      if (!title) return go(req, '/admin?m=falta');
      let coverUp = '';
      let backUp = '';
      try {
        coverUp = await uploadImage(fd && fd.get('coverfile'));
        backUp = await uploadImage(fd && fd.get('backdropfile'));
      } catch (err) {
        const cur = form.get('id') ? list.find((x) => x.id === form.get('id')) : null;
        return page(cur ? adminSeriePage(req, cur, err.message, true) : adminPage(req, list, err.message, true));
      }
      const year = String(form.get('year') || '').trim();
      const data = {
        title,
        type: TYPES.includes(form.get('type')) ? form.get('type') : TYPES[0],
        status: STATUSES.includes(form.get('status')) ? form.get('status') : STATUSES[0],
        year: /^\d{4}$/.test(year) ? year : '',
        genres: parseGenres(form.get('genres')),
        synopsis: String(form.get('synopsis') || '').trim().slice(0, 1500),
        cover: coverUp || cleanUrl(form.get('cover')),
        backdrop: backUp || cleanUrl(form.get('backdrop')),
        featured: form.get('featured') === '1',
      };
      let s = form.get('id') ? list.find((x) => x.id === form.get('id')) : null;
      if (s) {
        Object.assign(s, data);
      } else {
        s = {
          id: crypto.randomUUID().slice(0, 8),
          slug: uniqueSlug(list, title),
          episodes: [],
          createdAt: new Date().toISOString(),
          ...data,
        };
        list.unshift(s);
      }
      await save(list);
      return go(req, `/admin/serie/${s.id}?m=serieok`);
    }

    const del = p.match(/^\/admin\/serie\/([\w-]+)\/borrar$/);
    if (del) {
      await save(list.filter((x) => x.id !== del[1]));
      return go(req, '/admin?m=seriebor');
    }

    const add = p.match(/^\/admin\/serie\/([\w-]+)\/episodio$/);
    if (add) {
      const s = list.find((x) => x.id === add[1]);
      if (!s) return notFound('Serie no encontrada');
      const parsed = parseServers(form.get('urls') || form.get('url') || '');
      if (parsed.error) return page(adminSeriePage(req, s, parsed.error, true));
      if (!parsed.servers.length) return page(adminSeriePage(req, s, 'Pega al menos un enlace de video.', true));
      let n = parseInt(form.get('n'), 10);
      if (!(n >= 1 && n <= 9999)) n = Math.max(0, ...s.episodes.map((e) => e.n)) + 1;
      let up = '';
      try {
        up = await uploadImage(fd && fd.get('thumbfile'));
      } catch (err) {
        return page(adminSeriePage(req, s, err.message, true));
      }
      const thumb = up || cleanUrl(form.get('thumb')) || parsed.thumb || '';
      const ex = s.episodes.find((e) => e.n === n);
      if (ex) {
        ex.servers = [...ex.servers, ...parsed.servers].slice(0, 12);
        if (!ex.thumb && thumb) ex.thumb = thumb;
        const t = String(form.get('title') || '').trim().slice(0, 120);
        if (t) ex.title = t;
      } else {
        s.episodes.push({
          n,
          title: String(form.get('title') || '').trim().slice(0, 120),
          thumb,
          servers: parsed.servers,
          createdAt: new Date().toISOString(),
        });
        s.episodes.sort((a, b) => a.n - b.n);
      }
      await save(list);
      return go(req, `/admin/serie/${s.id}?m=epok`);
    }

    if (p === '/admin/telegram/conectar') {
      if (!TG_TOKEN) return page(adminPage(req, list, 'Falta la variable TELEGRAM_BOT_TOKEN en Netlify.', true));
      const r = await tg('setWebhook', {
        url: `${url.origin}/telegram/hook`,
        secret_token: tgSecret(),
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
      if (!r.ok) return page(adminPage(req, list, `Telegram no aceptó la conexión: ${r.description || 'error'}`, true));
      await tg('setMyCommands', { commands: [{ command: 'menu', description: 'Abrir el menú' }] });
      return page(adminPage(req, list, 'Bot conectado. Abre tu bot en Telegram y escribe /start.', false));
    }

    const saveEp = p.match(/^\/admin\/serie\/([\w-]+)\/episodio\/(\d+)\/guardar$/);
    if (saveEp) {
      const s = list.find((x) => x.id === saveEp[1]);
      const e = s && s.episodes.find((x) => x.n === Number(saveEp[2]));
      if (!e) return notFound('Episodio no encontrado');
      const parsed = parseServers(form.get('urls'));
      if (parsed.error) return page(adminEpisodePage(req, s, e, parsed.error, true));
      if (!parsed.servers.length) return page(adminEpisodePage(req, s, e, 'Deja al menos un servidor.', true));
      const n = parseInt(form.get('n'), 10);
      if (!(n >= 1 && n <= 9999)) return page(adminEpisodePage(req, s, e, 'El número no es válido.', true));
      if (n !== e.n && s.episodes.some((x) => x.n === n)) return page(adminEpisodePage(req, s, e, 'Ya existe otro episodio con ese número.', true));
      let up = '';
      try {
        up = await uploadImage(fd && fd.get('thumbfile'));
      } catch (err) {
        return page(adminEpisodePage(req, s, e, err.message, true));
      }
      e.n = n;
      e.title = String(form.get('title') || '').trim().slice(0, 120);
      e.thumb = up || cleanUrl(form.get('thumb')) || parsed.thumb || '';
      e.servers = parsed.servers;
      s.episodes.sort((a, b) => a.n - b.n);
      await save(list);
      return go(req, `/admin/serie/${s.id}?m=epok`);
    }

    const delSrv = p.match(/^\/admin\/serie\/([\w-]+)\/episodio\/(\d+)\/servidor\/(\d+)\/borrar$/);
    if (delSrv) {
      const s = list.find((x) => x.id === delSrv[1]);
      if (!s) return notFound('Serie no encontrada');
      const e = s.episodes.find((x) => x.n === Number(delSrv[2]));
      if (e) {
        e.servers = e.servers.filter((_, i) => i !== Number(delSrv[3]));
        if (!e.servers.length) s.episodes = s.episodes.filter((x) => x !== e);
        await save(list);
      }
      return go(req, `/admin/serie/${s.id}?m=epbor`);
    }

    const delEp = p.match(/^\/admin\/serie\/([\w-]+)\/episodio\/(\d+)\/borrar$/);
    if (delEp) {
      const s = list.find((x) => x.id === delEp[1]);
      if (!s) return notFound('Serie no encontrada');
      s.episodes = s.episodes.filter((e) => e.n !== Number(delEp[2]));
      await save(list);
      return go(req, `/admin/serie/${s.id}?m=epbor`);
    }

    return notFound('Página no encontrada');
  }

  /* sitio público */
  if (!isGet) return notFound('Página no encontrada');
  if (!isAdult(req)) return page(gatePage(url.pathname + url.search));

  const list = await load();

  if (p === '/') return page(homePage(list));
  if (p === '/catalogo') return page(catalogPage(list, url.searchParams));

  const m = p.match(/^\/media\/([\w-]+)(?:\/(\d+))?$/);
  if (m) {
    const s = list.find((x) => x.slug === m[1]);
    if (!s) return notFound('No encontrado');
    if (!m[2]) return page(seriePage(s));
    const e = (s.episodes || []).find((x) => x.n === Number(m[2]));
    if (!e || !e.servers.length) return notFound('Episodio no encontrado');
    const idx = Math.min(Math.max(parseInt(url.searchParams.get('s'), 10) || 1, 1), e.servers.length) - 1;
    return page(episodePage(s, e, idx));
  }

  return notFound('Página no encontrada');
};

export const config = { path: '/*' };
