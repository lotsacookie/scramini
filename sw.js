const PROXY_ORIGIN = self.location.origin;
const PROXY_PREFIX = '/proxy/';
const WISP_LIST_URL = 'https://cdn.jsdelivr.net/gh/lotsacookie/kstuff@main/Assets/json/wss.json';
const EPOXY_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-tls/+esm';

let epoxyBindings = null;
let epoxyClient = null;
let wispUrls = [];
let wispIndex = 0;
let clientReady = false;

function base64ToText(b64) {
  const binary = atob(b64.trim());
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function extractWispUrls(decoded) {
  if (Array.isArray(decoded)) {
    return decoded.map(x => (x || '').toString().trim()).filter(x => x.startsWith('wss://') || x.startsWith('ws://'));
  }
  if (decoded && typeof decoded === 'object') {
    for (const value of Object.values(decoded)) {
      const found = extractWispUrls(value);
      if (found.length > 0) return found;
    }
  }
  return [];
}

async function loadWispList() {
  try {
    const r = await fetch(WISP_LIST_URL + '?nocache=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const outer = await r.json();
    let b64 = null;
    if (Array.isArray(outer)) b64 = outer.find(x => typeof x === 'string' && x.trim());
    else if (typeof outer === 'string') b64 = outer;
    if (!b64) throw new Error('no base64 in wisp json');
    const decoded = JSON.parse(base64ToText(b64));
    const list = extractWispUrls(decoded);
    if (!list.length) throw new Error('no ws urls found');
    return list;
  } catch (e) {
    console.error('[sw] wisp list load failed:', e);
    return [];
  }
}

async function getEpoxyBindings() {
  if (epoxyBindings) return epoxyBindings;
  const mod = await import(EPOXY_MODULE_URL);
  if (typeof mod.default === 'function') await mod.default();
  if (!mod.EpoxyClient || !mod.EpoxyClientOptions) throw new Error('epoxy bindings unavailable');
  epoxyBindings = mod;
  return mod;
}

async function getClient() {
  if (epoxyClient) return epoxyClient;
  if (!wispUrls.length) {
    wispUrls = await loadWispList();
    if (!wispUrls.length) throw new Error('no wisp servers');
  }
  const { EpoxyClient, EpoxyClientOptions } = await getEpoxyBindings();
  const opts = new EpoxyClientOptions();
  opts.user_agent = 'Mozilla/5.0 (compatible; ScramProxy/1.0)';
  const server = wispUrls[wispIndex % wispUrls.length];
  console.log('[sw] connecting to wisp:', server);
  epoxyClient = await new EpoxyClient(server, opts);
  clientReady = true;
  console.log('[sw] epoxy client ready');
  return epoxyClient;
}

function resetClient() {
  const old = epoxyClient;
  epoxyClient = null;
  clientReady = false;
  wispIndex = (wispIndex + 1) % Math.max(1, wispUrls.length);
  if (old) setTimeout(() => { try { old.free && old.free(); } catch (e) {} }, 10000);
}

async function proxyFetch(targetUrl, originalRequest) {
  let client;
  try {
    client = await Promise.race([
      getClient(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
    ]);
  } catch (e) {
    resetClient();
    throw e;
  }

  const headers = {};
  for (const [k, v] of originalRequest.headers.entries()) {
    const kl = k.toLowerCase();
    if (kl === 'host' || kl === 'origin' || kl === 'referer') continue;
    headers[k] = v;
  }
  headers['Origin'] = new URL(targetUrl).origin;

  let body = null;
  if (originalRequest.method !== 'GET' && originalRequest.method !== 'HEAD') {
    try { body = await originalRequest.arrayBuffer(); } catch (e) {}
  }

  try {
    const resp = await Promise.race([
      client.fetch(targetUrl, { method: originalRequest.method, headers, body }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('fetch timeout')), 30000))
    ]);

    const contentType = resp.headers.get('content-type') || '';
    const isHtml = contentType.includes('text/html');
    const isCss = contentType.includes('text/css');
    const isJs = contentType.includes('javascript');

    const respHeaders = new Headers();
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Access-Control-Allow-Methods', '*');

    for (const [k, v] of resp.headers.entries()) {
      const kl = k.toLowerCase();
      if (kl === 'content-security-policy' || kl === 'x-frame-options' || kl === 'content-encoding') continue;
      if (kl === 'set-cookie') continue;
      respHeaders.set(k, v);
    }

    if (isHtml || isCss || isJs) {
      const text = await resp.text();
      const base = new URL(targetUrl);
      const rewritten = rewriteContent(text, base, isHtml, isCss, isJs);
      return new Response(rewritten, { status: resp.status, headers: respHeaders });
    }

    const blob = await resp.blob();
    return new Response(blob, { status: resp.status, headers: respHeaders });
  } catch (e) {
    if (e.message && (e.message.includes('websocket') || e.message.includes('closed') || e.message.includes('reset'))) {
      resetClient();
    }
    throw e;
  }
}

function encodeProxyUrl(url) {
  return PROXY_PREFIX + encodeURIComponent(url);
}

function rewriteUrl(url, base) {
  try {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
    if (url.startsWith('/proxy/')) return url;
    const abs = new URL(url, base).href;
    return encodeProxyUrl(abs);
  } catch (e) {
    return url;
  }
}

function rewriteContent(text, base, isHtml, isCss, isJs) {
  if (isCss) {
    return text.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (m, q, u) => {
      return 'url(' + q + rewriteUrl(u.trim(), base) + q + ')');
    }).replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => {
      return '@import ' + q + rewriteUrl(u, base) + q;
    });
  }

  if (isJs) {
    return text;
  }

  if (isHtml) {
    let out = text;
    out = out.replace(/(<[^>]+\s(?:src|href|action)=["'])([^"']+)(["'])/gi, (m, pre, url, post) => {
      return pre + rewriteUrl(url, base) + post;
    });
    out = out.replace(/(<[^>]+\s(?:src|href|action)=)([^\s"'>]+)/gi, (m, pre, url) => {
      return pre + rewriteUrl(url, base);
    });
    out = out.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (m, q, u) => {
      return 'url(' + q + rewriteUrl(u.trim(), base) + q + ')';
    });
    out = out.replace(/<head([^>]*)>/i, (m, attrs) => {
      return '<head' + attrs + '><script>__PROXY_ORIGIN__="' + PROXY_ORIGIN + '";<\/script>';
    });
    return out;
  }

  return text;
}

self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
  loadWispList().then(urls => { wispUrls = urls; });
  getClient().catch(e => console.warn('[sw] initial client setup:', e.message));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith(PROXY_PREFIX)) return;

  const encoded = url.pathname.slice(PROXY_PREFIX.length) + url.search;
  let targetUrl;
  try {
    targetUrl = decodeURIComponent(encoded);
    new URL(targetUrl);
  } catch (err) {
    e.respondWith(new Response('Bad proxy URL', { status: 400 }));
    return;
  }

  e.respondWith(
    proxyFetch(targetUrl, e.request).catch(err => {
      console.error('[sw] proxy error:', err);
      return new Response(
        '<h2 style="font-family:monospace;padding:2rem">Proxy error: ' + err.message + '</h2>',
        { status: 502, headers: { 'content-type': 'text/html' } }
      );
    })
  );
});
