// Tracks in-flight requests via webRequest so the panel can show "(pending)" rows.
// chrome.devtools.network only reports requests once they have finished.

const portsByTab = new Map(); // tabId -> Set<Port>

/* ---------- Page hook injection ----------
 * hook.js (MAIN world) + relay.js run only on the site(s) of tabs that have the GraphQL Monitor panel open.
 * Other tabs – e.g. a payment page in another tab – never get the hook. */

const HOOK_SCRIPTS = [
  { id: 'gql-hook', js: ['hook.js'], world: 'MAIN' },
  { id: 'gql-relay', js: ['relay.js'], world: 'ISOLATED' },
];
// Pages where wrapping fetch/XHR is never wanted.
const EXCLUDED_PATTERNS = [
  'https://chrome.google.com/webstore/*',
  'https://chromewebstore.google.com/*',
  'https://accounts.google.com/*',
];
// Grace period before unregistering, so a service-worker restart (panels reconnect) does not flap.
const UNREGISTER_DELAY_MS = 3000;

const patternByTab = new Map(); // inspected tabId -> match pattern of its current site
let unregisterTimer = null;
let syncQueue = Promise.resolve();

/** Match pattern for the site of `url` (ports are ignored by match patterns), or null when not injectable. */
function sitePattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const pattern = `${u.protocol}//${u.hostname}/*`;
    const excluded = EXCLUDED_PATTERNS.some((p) => (u.origin + u.pathname).startsWith(p.replace('/*', '')));
    return excluded ? null : pattern;
  } catch {
    return null;
  }
}

async function applyRegistration() {
  const matches = [...new Set([...patternByTab.values()].filter(Boolean))];
  const ids = HOOK_SCRIPTS.map((s) => s.id);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (matches.length === 0) {
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: registered.map((r) => r.id) });
    return;
  }
  const scripts = HOOK_SCRIPTS.map((s) => ({
    ...s,
    matches,
    excludeMatches: EXCLUDED_PATTERNS,
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: false,
  }));
  const toUpdate = scripts.filter((s) => registered.some((r) => r.id === s.id));
  const toRegister = scripts.filter((s) => !registered.some((r) => r.id === s.id));
  if (toUpdate.length) await chrome.scripting.updateContentScripts(toUpdate);
  if (toRegister.length) await chrome.scripting.registerContentScripts(toRegister);
}

function syncRegistration() {
  clearTimeout(unregisterTimer);
  syncQueue = syncQueue
    .then(applyRegistration)
    .catch((error) => console.warn('GraphQL Network Monitor: cannot register page hook', error));
  return syncQueue;
}

function scheduleSyncAfterGrace() {
  clearTimeout(unregisterTimer);
  unregisterTimer = setTimeout(syncRegistration, UNREGISTER_DELAY_MS);
}

/** Injects the hook into the page already loaded in the inspected tab (top frame), so capture starts without a reload. */
async function injectIntoTab(tabId) {
  if (!patternByTab.get(tabId)) return;
  for (const { js, world } of HOOK_SCRIPTS) {
    await chrome.scripting
      .executeScript({ target: { tabId }, files: js, world, injectImmediately: true })
      .catch(() => {}); // restricted pages (chrome://, …)
  }
}

async function trackTab(tabId, url) {
  const pattern = sitePattern(url);
  const changed = patternByTab.get(tabId) !== pattern;
  patternByTab.set(tabId, pattern);
  if (changed) await syncRegistration();
  await injectIntoTab(tabId);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gql-panel') return;
  let tabId = null;

  port.onMessage.addListener((msg) => {
    if (msg?.type !== 'init') return;
    tabId = msg.tabId;
    if (!portsByTab.has(tabId)) portsByTab.set(tabId, new Set());
    portsByTab.get(tabId).add(port);
    chrome.tabs
      .get(tabId)
      .then((tab) => trackTab(tabId, tab.url))
      .catch(() => {})
      .then(() => {
        try {
          port.postMessage({ type: 'hook-ready' });
        } catch {}
      });
  });

  port.onDisconnect.addListener(() => {
    const set = portsByTab.get(tabId);
    if (!set) return;
    set.delete(port);
    if (set.size > 0) return;
    portsByTab.delete(tabId);
    patternByTab.delete(tabId);
    scheduleSyncAfterGrace();
  });
});

// The inspected tab navigated (possibly to another site): follow it.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && portsByTab.has(tabId)) trackTab(tabId, changeInfo.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!patternByTab.delete(tabId)) return;
  portsByTab.delete(tabId);
  syncRegistration();
});

// A fresh service worker has no panels yet; drop leftovers if none reconnect.
scheduleSyncAfterGrace();

function broadcast(tabId, message) {
  const set = portsByTab.get(tabId);
  if (!set) return false;
  for (const port of set) {
    try {
      port.postMessage(message);
    } catch {
      set.delete(port);
    }
  }
  return true;
}

// Finished requests reported by the page hook (hook.js → relay.js), including response bodies.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'gql-page' || !sender.tab) return;
  const { __gqlInspector, ...payload } = msg.payload || {};
  broadcast(sender.tab.id, { type: 'page', ...payload });
});

const MAX_BODY = 1024 * 1024;

function decodeBody(requestBody) {
  if (requestBody?.formData) {
    const params = new URLSearchParams();
    for (const [key, values] of Object.entries(requestBody.formData)) for (const v of values) params.append(key, v);
    return params.toString();
  }
  if (!requestBody?.raw) return null;
  const chunks = requestBody.raw.filter((part) => part.bytes).map((part) => new Uint8Array(part.bytes));
  if (chunks.length === 0) return null;
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  if (total > MAX_BODY) return null;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder('utf-8').decode(merged);
}

function looksLikeGraphQL(method, url, body) {
  if (body) return /"(query|extensions|operationName)"\s*:/.test(body);
  if (method === 'GET') return /[?&](query|extensions)=/.test(url);
  return false;
}

const tracked = new Set(); // webRequest requestIds forwarded to a panel

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !portsByTab.has(details.tabId)) return;
    // CORS preflights become visible to extensions with 'extraHeaders' – they are noise here.
    if (details.method === 'OPTIONS') return;
    const body = decodeBody(details.requestBody);
    // fetch/XHR are always forwarded (the panel also lists plain fetch calls); 'other' only when it is GraphQL.
    if (details.type !== 'xmlhttprequest' && !looksLikeGraphQL(details.method, details.url, body)) return;

    tracked.add(details.requestId);
    broadcast(details.tabId, {
      type: 'start',
      requestId: details.requestId,
      url: details.url,
      method: details.method,
      body,
      resourceType: details.type,
      timeStamp: details.timeStamp,
    });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
  ['requestBody'],
);

const normalizeHeaders = (headers = []) => headers.map(({ name, value }) => ({ name, value: value ?? '' }));

// Headers come straight from the network stack, so they are available even when DevTools does not report the request.
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!tracked.has(details.requestId)) return;
    broadcast(details.tabId, {
      type: 'headers',
      requestId: details.requestId,
      requestHeaders: normalizeHeaders(details.requestHeaders),
    });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
  ['requestHeaders', 'extraHeaders'],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!tracked.delete(details.requestId)) return;
    broadcast(details.tabId, {
      type: 'end',
      requestId: details.requestId,
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      responseHeaders: normalizeHeaders(details.responseHeaders),
      timeStamp: details.timeStamp,
    });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
  ['responseHeaders', 'extraHeaders'],
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!tracked.delete(details.requestId)) return;
    broadcast(details.tabId, {
      type: 'error',
      requestId: details.requestId,
      error: details.error,
      timeStamp: details.timeStamp,
    });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
);
