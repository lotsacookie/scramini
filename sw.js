const PROXY_PREFIX = '/proxy/';
const WISP_LIST_URL = 'https://cdn.jsdelivr.net/gh/lotsacookie/kstuff@main/Assets/json/wss.json';
const EPOXY_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-tls/+esm';
const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT = 30000;

let epoxyBindings = null;
let epoxyClient = null;
let wispUrls = [];
let wispIndex = 0;

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
  epoxyClient = await new EpoxyClient(server, opts);
  return epoxyClient;
}

function resetClient() {
  const old = epoxyClient;
  epoxyClient = null;
  wispIndex = (wispIndex + 1) % Math.max(1, wispUrls.length);
  if (old) setTimeout(() => { try { old.free && old.free(); } catch (e) {} }, 10000);
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function rawFetch(url, opts) {
  const client = await withTimeout(getClient(), 15000);
  try {
    return await withTimeout(client.fetch(url, opts), REQUEST_TIMEOUT);
  } catch (e) {
    if (/websocket|closed|reset|panic|wasm|not ready/i.test(e.message || '')) resetClient();
    throw e;
  }
}

async function fetchFollowingRedirects(url, opts) {
  let currentUrl = url;
  let currentOpts = opts;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const resp = await rawFetch(currentUrl, currentOpts);
    const status = resp.status;
    if (status >= 300 && status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return { resp, finalUrl: currentUrl };
      const nextUrl = new URL(loc, currentUrl).href;
      if (status === 303 || ((status === 301 || status === 302) && currentOpts.method !== 'GET' && currentOpts.method !== 'HEAD')) {
        currentOpts = { ...currentOpts, method: 'GET', body: null };
      }
      currentUrl = nextUrl;
      continue;
    }
    return { resp, finalUrl: currentUrl };
  }
  throw new Error('too many redirects');
}

function encodeProxyUrl(url) {
  return PROXY_PREFIX + encodeURIComponent(url);
}

function rewriteUrl(url, base) {
  try {
    if (!url) return url;
    const trimmed = url.trim();
    if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(trimmed)) return url;
    if (trimmed.startsWith('/proxy/')) return url;
    const abs = new URL(trimmed, base).href;
    return encodeProxyUrl(abs);
  } catch (e) {
    return url;
  }
}

function rewriteSrcset(value, base) {
  return value.split(',').map(part => {
    const trimmed = part.trim();
    const m = trimmed.match(/^(\S+)(\s+.*)?$/);
    if (!m) return part;
    return rewriteUrl(m[1], base) + (m[2] || '');
  }).join(', ');
}

function injectedScript(origin) {
  return '<script>' +
    '(function(){' +
    'var ORIGIN = ' + JSON.stringify(origin) + ';' +
    'function toProxy(u) {' +
    'try {' +
    'if (!u) return u;' +
    'var t = u.trim();' +
    'if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(t)) return u;' +
    'if (t.indexOf("/proxy/") === 0) return u;' +
    'var abs = new URL(t, document.baseURI).href;' +
    'return ORIGIN + "/proxy/" + encodeURIComponent(abs);' +
    '} catch(e) { return u; }' +
    '}' +
    'var _xopen = XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open = function(method, url) {' +
    'var args = Array.prototype.slice.call(arguments);' +
    'args[1] = toProxy(url);' +
    'return _xopen.apply(this, args);' +
    '};' +
    'var _fetch = window.fetch;' +
    'window.fetch = function(input, init) {' +
    'try {' +
    'var url = typeof input === "string" ? input : input.url;' +
    'var proxied = toProxy(url);' +
    'input = typeof input === "string" ? proxied : new Request(proxied, input);' +
    '} catch(e) {}' +
    'return _fetch.call(window, input, init);' +
    '};' +
    'var _winOpen = window.open;' +
    'window.open = function(url) {' +
    'var args = Array.prototype.slice.call(arguments);' +
    'args[0] = toProxy(url);' +
    'return _winOpen.apply(window, args);' +
    '};' +
    'document.addEventListener("click", function(e) {' +
    'var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;' +
    'if (!a) return;' +
    'var href = a.getAttribute("href");' +
    'if (!href || /^(javascript:|#|mailto:|tel:)/i.test(href)) return;' +
    'var proxied = toProxy(href);' +
    'if (proxied !== href) {' +
    'e.preventDefault();' +
    'window.top.location.href = proxied;' +
    '}' +
    '}, true);' +
    'document.addEventListener("submit", function(e) {' +
    'var f = e.target;' +
    'if (!f || f.tagName !== "FORM") return;' +
    'var action = f.getAttribute("action") || document.baseURI;' +
    'f.setAttribute("action", toProxy(action));' +
    '}, true);' +
    '})();' +
    '<\/script>';
}

function rewriteContent(text, base, isHtml, isCss) {
  if (isCss) {
    return text.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (m, q, u) => 'url(' + q + rewriteUrl(u.trim(), base) + q + ')')
      .replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => '@import ' + q + rewriteUrl(u, base) + q);
  }

  if (isHtml) {
    let out = text;
    out = out.replace(/(<[a-z][a-z0-9]*\b[^>]*\ssrcset=["'])([^"']+)(["'])/gi, (m, pre, val, post) => pre + rewriteSrcset(val, base) + post);
    out = out.replace(/(<[a-z][a-z0-9]*\b[^>]*\s(?:href|src|action|formaction|poster|data)=["'])([^"']+)(["'])/gi, (m, pre, url, post) => pre + rewriteUrl(url, base) + post);
    out = out.replace(/(<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]*;\s*url=)([^"']+)(["'])/gi, (m, pre, url, post) => pre + rewriteUrl(url, base) + post);
    out = out.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (m, q, u) => 'url(' + q + rewriteUrl(u.trim(), base) + q + ')');
    const dirBase = new URL('.', base).href;
    out = out.replace(/<head([^>]*)>/i, (m, attrs) => '<head' + attrs + '><base href="' + dirBase + '">' + injectedScript(self.location.origin));
    return out;
  }

  return text;
}

self.addEventListener('install', e => { e.waitUntil(self.skipWaiting()); });

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
  loadWispList().then(urls => { wispUrls = urls; });
  getClient().catch(e => console.warn('[sw] initial client setup:', e.message));
});

async function handleProxyRequest(targetUrl, originalRequest) {
  const headers = {};
  for (const [k, v] of originalRequest.headers.entries()) {
    const kl = k.toLowerCase();
    if (kl === 'host' || kl === 'origin' || kl === 'referer' || kl === 'cookie') continue;
    headers[k] = v;
  }
  headers['Origin'] = new URL(targetUrl).origin;

  let body = null;
  if (originalRequest.method !== 'GET' && originalRequest.method !== 'HEAD') {
    try { body = await originalRequest.arrayBuffer(); } catch (e) {}
  }

  const { resp, finalUrl } = await fetchFollowingRedirects(targetUrl, { method: originalRequest.method, headers, body });

  const contentType = resp.headers.get('content-type') || '';
  const isHtml = contentType.includes('text/html');
  const isCss = contentType.includes('text/css');

  const respHeaders = new Headers();
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', '*');
  for (const [k, v] of resp.headers.entries()) {
    const kl = k.toLowerCase();
    if (kl === 'content-security-policy' || kl === 'x-frame-options' || kl === 'content-encoding' || kl === 'set-cookie' || kl === 'location') continue;
    respHeaders.set(k, v);
  }

  if (isHtml || isCss) {
    const text = await resp.text();
    const rewritten = rewriteContent(text, finalUrl, isHtml, isCss);
    return new Response(rewritten, { status: resp.status, headers: respHeaders });
  }

  const blob = await resp.blob();
  return new Response(blob, { status: resp.status, headers: respHeaders });
}

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
    handleProxyRequest(targetUrl, e.request).catch(err => {
      console.error('[sw] proxy error:', err);
      return new Response(
        '<h2 style="font-family:monospace;padding:2rem">Proxy error: ' + err.message + '</h2>',
        { status: 502, headers: { 'content-type': 'text/html' } }
      );
    })
  );
});
