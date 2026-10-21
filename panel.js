import { extractOperations, formatGraphQLHTML, formatGraphQLText, escapeHTML } from './lib/graphql.js';
import { highlightJSON, renderJsonTree, setTreeExpanded } from './lib/json-view.js';
import { toCurl } from './lib/curl.js';
import { about } from './about.js';

const devtools = globalThis.chrome?.devtools;

const $ = (sel) => document.querySelector(sel);
const els = {
  main: $('#main'),
  rows: $('#rows'),
  empty: $('#empty'),
  count: $('#count'),
  filter: $('#filter'),
  preserve: $('#preserve'),
  clear: $('#clear'),
  detail: $('#detail'),
  detailBody: $('#detail-body'),
  resizer: $('#resizer'),
  list: $('#list'),
};

const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`gql-inspector:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`gql-inspector:${key}`, JSON.stringify(value));
    } catch {}
  },
};

const state = {
  requests: [],
  selected: null, // { reqId, opIndex }
  filter: '',
  typeFilter: 'all',
  preserve: storage.get('preserve', false),
  tab: storage.get('tab', 'request'),
  collapsedSections: new Set(),
};

let nextId = 1;

/* ---------- Request model ---------- */

function fetchName(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * Classifies a request: GraphQL operations, or a plain fetch/XHR call when `allowFetch` is set.
 * Returns { kind, batched, ops } or null.
 */
function describeRequest({ method, url, bodyText, allowFetch }) {
  const gql = extractOperations({ method, url, bodyText });
  if (gql) return { kind: 'graphql', ...gql };
  if (!allowFetch || /^(chrome-extension|data|blob):/.test(url)) return null;
  return { kind: 'fetch', batched: false, ops: [{ index: 0, type: 'fetch', name: fetchName(url) }] };
}

function createRequest({ url, method, bodyText, parsed }) {
  return {
    id: nextId++,
    kind: parsed.kind,
    url,
    method,
    bodyText,
    batched: parsed.batched,
    ops: parsed.ops,
    pending: true,
    failed: false,
    error: null,
    status: null,
    statusText: '',
    size: null,
    time: null,
    startedAt: Date.now(),
    requestHeaders: [],
    responseHeaders: [],
    responseText: null,
    responseJSON: undefined,
    harMatched: false,
    webRequestId: null,
    version: 0,
  };
}

// Where headers came from; a better source replaces a worse one, never the other way round.
const HEADER_SOURCE_RANK = { page: 1, network: 2, devtools: 3 };

function setHeaders(req, kind, headers, source) {
  if (!headers?.length) return;
  const sourceKey = `${kind}HeadersSource`;
  if ((HEADER_SOURCE_RANK[req[sourceKey]] ?? 0) > HEADER_SOURCE_RANK[source]) return;
  req[`${kind}Headers`] = headers;
  req[sourceKey] = source;
}

function touch(req) {
  req.version++;
  scheduleRender();
}

function opResponse(req, op) {
  const json = req.responseJSON;
  if (json === undefined) return undefined;
  if (req.batched && Array.isArray(json)) return json[op.index];
  return json;
}

function hasGraphQLErrors(req, op) {
  if (req.kind !== 'graphql') return false;
  const res = opResponse(req, op);
  return Boolean(res && Array.isArray(res.errors) && res.errors.length);
}

function decodeContent(content, encoding) {
  if (content == null) return '';
  if (encoding !== 'base64') return content;
  try {
    const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return content;
  }
}

function setResponseText(req, text) {
  req.responseText = text;
  try {
    req.responseJSON = JSON.parse(text);
  } catch {
    req.responseJSON = undefined;
  }
  touch(req);
}

/* ---------- Diagnostics ---------- */

const diagnostics = [];
function diag(event, data) {
  diagnostics.push({ t: new Date().toISOString().slice(11, 23), event, ...data });
  if (diagnostics.length > 300) diagnostics.shift();
}

function canonicalJSON(text) {
  if (text == null) return null;
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/** Finds the webRequest-created row that corresponds to a finished DevTools entry. */
function findPendingMatch(method, url, bodyText) {
  const candidates = state.requests.filter((r) => !r.harMatched && r.method === method);
  const sameUrl = candidates.filter((r) => r.url === url);
  const exact = sameUrl.find((r) => (r.bodyText ?? null) === bodyText);
  if (exact) return { req: exact, how: 'exact' };
  const canonical = canonicalJSON(bodyText);
  const normalized = sameUrl.find((r) => canonicalJSON(r.bodyText) === canonical);
  if (normalized) return { req: normalized, how: 'normalized-body' };
  // The looser strategies below only make sense for GraphQL, where many operations share one URL.
  const sameUrlGql = sameUrl.filter((r) => r.kind === 'graphql');
  const names = extractOperations({ method, url, bodyText })?.ops.map((op) => op.name).join(',');
  const sameOps = names && sameUrlGql.find((r) => r.ops.map((op) => op.name).join(',') === names);
  if (sameOps) return { req: sameOps, how: 'operation-name' };
  // DevTools sometimes omits/mangles the request body – fall back to the oldest open request to the same URL.
  if (!bodyText || !extractOperations({ method, url, bodyText })) {
    if (sameUrlGql[0]) return { req: sameUrlGql[0], how: 'url-only' };
  }
  return null;
}

function handleHarEntry(entry) {
  const { request, response } = entry;
  const bodyText = request.postData?.text ?? null;
  const allowFetch = entry._resourceType === 'fetch' || entry._resourceType === 'xhr';
  const parsed = describeRequest({ method: request.method, url: request.url, bodyText, allowFetch });
  const match = parsed || allowFetch ? findPendingMatch(request.method, request.url, bodyText) : null;

  if (parsed?.kind === 'graphql' || match?.req.kind === 'graphql') {
    diag('har', {
      method: request.method,
      url: request.url,
      status: response.status,
      hasPostData: Boolean(request.postData),
      bodyLength: bodyText?.length ?? 0,
      parsed: Boolean(parsed),
      matched: match?.how ?? 'new',
    });
  }
  if (!parsed && !match) return;

  let req = match?.req;
  if (!req) {
    req = createRequest({ url: request.url, method: request.method, bodyText, parsed });
    state.requests.push(req);
  }

  const transfer = response._transferSize ?? -1;
  Object.assign(req, {
    harMatched: true,
    pending: false,
    status: response.status,
    statusText: response.statusText,
    failed: response.status === 0,
    error: response._error || req.error,
    size: transfer > 0 ? transfer : response.bodySize > 0 ? response.bodySize : response.content?.size ?? null,
    time: entry.time,
    startedAt: entry.startedDateTime ? Date.parse(entry.startedDateTime) : req.startedAt,
  });
  setHeaders(req, 'request', request.headers, 'devtools');
  setHeaders(req, 'response', response.headers, 'devtools');
  touch(req);

  req.missingHar = false;
  if (typeof entry.getContent === 'function') {
    entry.getContent((content, encoding) => {
      diag('content', { url: request.url, length: content?.length ?? null, encoding: encoding || null });
      // Keep the body captured by the page hook if DevTools has none.
      if (content || req.responseText == null) setResponseText(req, decodeContent(content, encoding));
    });
  } else if (response.content?.text != null) {
    setResponseText(req, decodeContent(response.content.text, response.content.encoding));
  }
}

// How long to wait for DevTools to report a request that webRequest saw finishing.
const HAR_GRACE_MS = 5000;

function handleBackgroundMessage(msg) {
  diag(`bg:${msg.type}`, {
    requestId: msg.requestId,
    ...(msg.type === 'start' ? { method: msg.method, url: msg.url, bodyLength: msg.body?.length ?? 0 } : {}),
    ...(msg.type === 'end' ? { status: msg.statusCode, responseHeaders: msg.responseHeaders?.length ?? 0 } : {}),
    ...(msg.type === 'headers' ? { requestHeaders: msg.requestHeaders?.length ?? 0 } : {}),
    ...(msg.type === 'error' ? { error: msg.error } : {}),
    ...(msg.type === 'page'
      ? { method: msg.method, url: msg.url, status: msg.status, responseLength: msg.responseText?.length ?? null, error: msg.error }
      : {}),
  });

  if (msg.type === 'page') {
    handlePageReport(msg);
    return;
  }
  if (msg.type === 'hook-ready') {
    checkHook?.();
    return;
  }

  if (msg.type === 'start') {
    const parsed = describeRequest({
      method: msg.method,
      url: msg.url,
      bodyText: msg.body,
      allowFetch: msg.resourceType === 'xmlhttprequest',
    });
    if (!parsed) return;
    const req = createRequest({ url: msg.url, method: msg.method, bodyText: msg.body, parsed });
    req.webRequestId = msg.requestId;
    req.startedAt = msg.timeStamp;
    state.requests.push(req);
    touch(req);
    return;
  }

  const req = state.requests.find((r) => r.webRequestId === msg.requestId);
  if (!req) return;
  if (msg.type === 'headers') {
    setHeaders(req, 'request', msg.requestHeaders, 'network');
    touch(req);
    return;
  }
  if (msg.type === 'end') setHeaders(req, 'response', msg.responseHeaders, 'network');
  if (req.harMatched) {
    touch(req);
    return;
  }
  if (msg.type === 'end') {
    req.status = msg.statusCode;
    if (!req.statusText && msg.statusLine) req.statusText = msg.statusLine.replace(/^HTTP\/\S+\s+\d+\s*/, '');
    req.time = msg.timeStamp - req.startedAt;
    setTimeout(() => {
      if (req.harMatched || req.pageMatched) return;
      diag('har-missing', { requestId: req.webRequestId, url: req.url });
      req.pending = false;
      req.missingHar = true;
      touch(req);
    }, HAR_GRACE_MS);
  } else if (msg.type === 'error') {
    req.pending = false;
    req.failed = true;
    req.error = msg.error;
    req.time = msg.timeStamp - req.startedAt;
  }
  touch(req);
}

// Max difference between start times when pairing a page-hook report with an existing row.
const PAGE_MATCH_WINDOW_MS = 10000;

/** A finished request reported by the in-page fetch/XHR hook – carries the response body. */
function handlePageReport(msg) {
  const bodyText = msg.body ?? null;
  const canonical = canonicalJSON(bodyText);
  let req = state.requests.find(
    (r) =>
      !r.pageMatched &&
      r.method === msg.method &&
      r.url === msg.url &&
      (msg.bodyOpaque || canonicalJSON(r.bodyText) === canonical) &&
      Math.abs(r.startedAt - msg.startedAt) < PAGE_MATCH_WINDOW_MS,
  );
  if (!req) {
    const parsed = describeRequest({ method: msg.method, url: msg.url, bodyText, allowFetch: true });
    if (!parsed) return;
    req = createRequest({ url: msg.url, method: msg.method, bodyText, parsed });
    req.startedAt = msg.startedAt;
    state.requests.push(req);
  }

  req.pageMatched = true;
  req.pending = false;
  setHeaders(req, 'request', msg.requestHeaders, 'page');
  setHeaders(req, 'response', msg.responseHeaders, 'page');
  req.missingHar = false;
  if (msg.error && !req.harMatched) {
    req.failed = true;
    req.error = msg.error;
  }
  if (req.status == null && msg.status) req.status = msg.status;
  if (req.time == null) req.time = msg.duration;
  if (req.size == null && msg.responseText) req.size = new TextEncoder().encode(msg.responseText).length;

  if (msg.responseText != null && !req.responseText) setResponseText(req, msg.responseText);
  else touch(req);
}

function clearRequests() {
  state.requests = [];
  state.selected = null;
  scheduleRender();
}

/* ---------- Formatting helpers ---------- */

function formatSize(bytes) {
  if (bytes == null || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms) {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function statusInfo(req, op) {
  if (req.failed) return { cls: 'error', label: req.error ? `(failed) ${req.error}` : '(failed)' };
  if (req.pending && req.status == null) return { cls: '', label: '(pending)' };
  const gqlErrors = req.responseJSON !== undefined && hasGraphQLErrors(req, op);
  const code = req.status;
  if (code >= 400) return { cls: 'error', label: `${code}${gqlErrors ? ' · errors' : ''}` };
  if (gqlErrors) return { cls: 'error', label: `${code} · errors` };
  if (req.pending) return { cls: 'warn', label: `${code}` };
  return { cls: 'ok', label: `${code}` };
}

const TYPE_LETTER = { query: 'Q', mutation: 'M', subscription: 'S' };

/* ---------- List rendering ---------- */

function visibleRows() {
  const needle = state.filter.trim().toLowerCase();
  const rows = [];
  for (const req of state.requests) {
    for (const op of req.ops) {
      const f = state.typeFilter;
      if (f === 'errors') {
        if (!req.failed && !(req.status >= 400) && !hasGraphQLErrors(req, op)) continue;
      } else if (f === 'graphql' || f === 'fetch') {
        if (req.kind !== f) continue;
      } else if (f !== 'all' && op.type !== f) continue;
      if (needle && !op.name.toLowerCase().includes(needle) && !req.url.toLowerCase().includes(needle)) continue;
      rows.push({ req, op });
    }
  }
  return rows;
}

function isSelected(req, op) {
  return state.selected?.reqId === req.id && state.selected?.opIndex === op.index;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const rows = visibleRows();
  const stickToBottom = els.list.scrollTop + els.list.clientHeight >= els.list.scrollHeight - 4;

  els.rows.innerHTML = rows
    .map(({ req, op }) => {
      const status = statusInfo(req, op);
      const batch = req.batched ? `<span class="op-batch">batch #${op.index + 1}</span>` : '';
      const badge =
        req.kind === 'fetch'
          ? `<span class="method" title="${req.method} (fetch / XHR)">${escapeHTML(req.method)}</span>`
          : `<span class="badge ${op.type}" title="GraphQL ${op.type}">${TYPE_LETTER[op.type] || '?'}</span>`;
      const classes = [`kind-${req.kind}`, isSelected(req, op) ? 'selected' : ''].join(' ');
      return `<tr data-req="${req.id}" data-op="${op.index}" class="${classes}">
        <td class="col-name"><div class="op">${badge}<span class="op-name" title="${escapeHTML(op.name)}">${escapeHTML(op.name)}</span>${batch}</div></td>
        <td class="col-status"><span class="status ${status.cls}" title="${escapeHTML(status.label)}"><span class="dot"></span>${escapeHTML(status.label)}</span></td>
        <td class="col-size">${formatSize(req.size)}</td>
        <td class="col-time">${req.pending && req.time == null ? '…' : formatTime(req.time)}</td>
        <td class="col-url" title="${escapeHTML(req.url)}">${escapeHTML(req.url)}</td>
      </tr>`;
    })
    .join('');

  els.empty.hidden = state.requests.length > 0;
  const total = state.requests.reduce((n, r) => n + r.ops.length, 0);
  els.count.textContent = total ? (rows.length === total ? `${total} requests` : `${rows.length} / ${total} requests`) : '';

  if (stickToBottom) els.list.scrollTop = els.list.scrollHeight;
  renderDetail();
}

/* ---------- Detail rendering ---------- */

let renderedDetailKey = null;

function selectedEntry() {
  if (!state.selected) return null;
  const req = state.requests.find((r) => r.id === state.selected.reqId);
  const op = req?.ops.find((o) => o.index === state.selected.opIndex);
  return req && op ? { req, op } : null;
}

function renderDetail(force = false) {
  const entry = selectedEntry();
  const open = Boolean(entry);
  els.detail.hidden = !open;
  els.resizer.hidden = !open;
  els.main.classList.toggle('has-detail', open);
  if (!open) {
    renderedDetailKey = null;
    return;
  }

  const { req, op } = entry;
  const key = `${req.id}:${op.index}:${req.version}:${state.tab}`;
  if (!force && key === renderedDetailKey) return;
  renderedDetailKey = key;

  for (const btn of document.querySelectorAll('.tabs [data-tab]')) {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  }

  const scrollTop = els.detailBody.scrollTop;
  els.detailBody.replaceChildren(...TAB_RENDERERS[state.tab](req, op));
  els.detailBody.scrollTop = scrollTop;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function copyText(text) {
  const ta = el('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  if (!ok) navigator.clipboard?.writeText(text).catch(() => {});
}

function copyButton(label, getText) {
  const btn = el('button', {
    class: 'btn',
    text: label,
    onclick: () => {
      copyText(getText());
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove('copied');
      }, 1200);
    },
  });
  return btn;
}

function section(id, title, actions, content) {
  const wrap = el('div', { class: `section${state.collapsedSections.has(id) ? ' collapsed' : ''}` });
  const toggle = el('button', {
    class: 'section-title',
    text: title,
    onclick: () => {
      wrap.classList.toggle('collapsed');
      if (wrap.classList.contains('collapsed')) state.collapsedSections.add(id);
      else state.collapsedSections.delete(id);
    },
  });
  wrap.append(el('div', { class: 'section-head' }, [toggle, el('div', { class: 'actions' }, actions)]));
  wrap.append(el('div', { class: 'section-content' }, [content]));
  return wrap;
}

function opBodyText(req, op) {
  return req.batched ? JSON.stringify(op.payload) : req.bodyText;
}

function curlFor(req, op) {
  return toCurl({ url: req.url, method: req.method, headers: req.requestHeaders, body: opBodyText(req, op) });
}

function noBodyMessage(req) {
  if (req.pending) return 'Waiting for response…';
  if (req.missingHar) {
    return 'The request finished, but DevTools did not report its response, so the body is not available. Use "Copy diagnostics" in About to see what was captured.';
  }
  return 'No response body.';
}

function kvTable(pairs) {
  if (!pairs.length) return el('div', { class: 'note', text: 'None' });
  return el(
    'table',
    { class: 'kv' },
    pairs.map(([k, v]) => el('tr', {}, [el('td', { text: k }), el('td', { text: v ?? '' })])),
  );
}

function fetchRequestSections(req, op) {
  const out = [];
  let params = [];
  try {
    params = [...new URL(req.url).searchParams.entries()];
  } catch {}
  if (params.length) out.push(section('params', 'Query Parameters', [], kvTable(params)));

  let bodyContent;
  if (req.bodyText) {
    try {
      bodyContent = el('pre', { class: 'code', html: highlightJSON(JSON.parse(req.bodyText)) });
    } catch {
      bodyContent = el('pre', { class: 'code wrap', text: req.bodyText });
    }
  } else {
    bodyContent = el('div', { class: 'note', text: req.method === 'GET' ? 'GET request – no body.' : 'No request body captured.' });
  }
  const actions = [copyButton('Copy as cURL', () => curlFor(req, op))];
  if (req.bodyText) actions.push(copyButton('Copy Body', () => req.bodyText));
  out.push(section('body', 'Request Body', actions, bodyContent));
  return out;
}

const TAB_RENDERERS = {
  headers(req, op) {
    const status = statusInfo(req, op);
    const general = [
      ['Request URL', req.url],
      ['Request Method', req.method],
      ['Status', req.pending && req.status == null ? '(pending)' : `${req.status ?? ''} ${req.statusText || ''}`.trim() || status.label],
      req.kind === 'graphql' ? ['Operation', `${op.type} ${op.name}`] : ['Type', 'fetch / XHR'],
    ];
    if (req.batched) general.push(['Batch', `operation ${op.index + 1} of ${req.ops.length}`]);
    if (req.error) general.push(['Error', req.error]);
    if (req.time != null) general.push(['Time', formatTime(req.time)]);
    if (req.size != null) general.push(['Size', formatSize(req.size)]);

    const headerPairs = (list) =>
      [...list].sort((a, b) => a.name.localeCompare(b.name)).map((h) => [h.name, h.value]);
    const SOURCE_HINT = {
      network: 'Captured from the network stack (DevTools did not report this request).',
      page: 'Captured in the page – for cross-origin responses only CORS-exposed headers are visible.',
    };
    const headersContent = (kind) => {
      const list = req[`${kind}Headers`];
      if (!list.length) {
        return el('div', { class: 'note', text: req.pending ? 'Available once the request finishes.' : 'No headers captured.' });
      }
      const hint = SOURCE_HINT[req[`${kind}HeadersSource`]];
      return el('div', {}, [hint ? el('div', { class: 'note', text: hint }) : '', kvTable(headerPairs(list))]);
    };

    return [
      section('general', 'General', [copyButton('Copy as cURL', () => curlFor(req, op))], kvTable(general)),
      section('req-headers', 'Request Headers', [], headersContent('request')),
      section('res-headers', 'Response Headers', [], headersContent('response')),
    ];
  },

  request(req, op) {
    if (req.kind === 'fetch') return fetchRequestSections(req, op);
    const actions = [
      copyButton('Copy Query', () => formatGraphQLText(op.query)),
      copyButton('Copy as cURL', () => curlFor(req, op)),
      copyButton('Copy Vars', () => JSON.stringify(op.variables ?? {}, null, 2)),
    ];
    const queryContent = op.query
      ? el('pre', { class: 'code', html: formatGraphQLHTML(op.query) })
      : el('div', { class: 'note', text: 'Persisted query – the query text was not sent with this request.' });

    const out = [
      section('query', 'Query', actions, queryContent),
      section('variables', 'Variables', [], el('pre', { class: 'code', html: highlightJSON(op.variables ?? {}) })),
    ];
    if (op.extensions) {
      out.push(section('extensions', 'Extensions', [], el('pre', { class: 'code', html: highlightJSON(op.extensions) })));
    }
    return out;
  },

  response(req, op) {
    if (req.failed && req.responseText == null) {
      return [el('div', { class: 'error-box', text: `Request failed${req.error ? `: ${req.error}` : ''}` })];
    }
    if (req.responseText == null) {
      return [el('div', { class: 'note', text: noBodyMessage(req) })];
    }

    const res = opResponse(req, op);
    if (res === undefined) {
      if (req.kind === 'fetch') return TAB_RENDERERS.raw(req);
      return [el('div', { class: 'note', text: 'Response is not valid JSON – see Response (Raw).' })];
    }

    const out = [];
    if (req.kind === 'graphql' && Array.isArray(res?.errors) && res.errors.length) {
      const messages = res.errors.map((e) => `• ${e?.message ?? JSON.stringify(e)}${e?.path ? `  (${e.path.join('.')})` : ''}`);
      out.push(el('div', { class: 'error-box', text: messages.join('\n') }));
    }

    const tree = renderJsonTree(res);
    const actions = [
      el('button', { class: 'btn', text: 'Expand all', onclick: () => setTreeExpanded(tree, true) }),
      el('button', { class: 'btn', text: 'Collapse all', onclick: () => setTreeExpanded(tree, false) }),
      copyButton('Copy', () => JSON.stringify(res, null, 2)),
    ];
    out.push(el('div', { class: 'section-head' }, [el('div', { class: 'actions' }, actions)]), tree);
    return out;
  },

  raw(req) {
    if (req.responseText == null) {
      return [el('div', { class: 'note', text: noBodyMessage(req) })];
    }
    return [
      el('div', { class: 'section-head' }, [el('div', { class: 'actions' }, [copyButton('Copy', () => req.responseText)])]),
      el('pre', { class: 'code wrap', text: req.responseText }),
    ];
  },
};

/* ---------- Interaction ---------- */

function select(reqId, opIndex) {
  state.selected = reqId == null ? null : { reqId, opIndex };
  scheduleRender();
}

els.rows.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-req]');
  if (!tr) return;
  select(Number(tr.dataset.req), Number(tr.dataset.op));
});

document.addEventListener('keydown', (e) => {
  if (e.target === els.filter) return;
  if (e.key === 'Escape') {
    if (!$('#about').hidden) showAbout(false);
    else select(null);
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = visibleRows();
  if (!rows.length) return;
  e.preventDefault();
  let idx = rows.findIndex(({ req, op }) => isSelected(req, op));
  idx = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx === -1 ? rows.length - 1 : idx - 1);
  select(rows[idx].req.id, rows[idx].op.index);
  requestAnimationFrame(() => els.rows.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' }));
});

$('#close-detail').addEventListener('click', () => select(null));

for (const btn of document.querySelectorAll('.tabs [data-tab]')) {
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    storage.set('tab', state.tab);
    renderDetail(true);
  });
}

els.filter.addEventListener('input', () => {
  state.filter = els.filter.value;
  scheduleRender();
});

for (const btn of document.querySelectorAll('.type-filter button')) {
  btn.addEventListener('click', () => {
    state.typeFilter = btn.dataset.type;
    for (const b of document.querySelectorAll('.type-filter button')) b.classList.toggle('active', b === btn);
    scheduleRender();
  });
}

els.preserve.checked = state.preserve;
els.preserve.addEventListener('change', () => {
  state.preserve = els.preserve.checked;
  storage.set('preserve', state.preserve);
});

els.clear.addEventListener('click', clearRequests);

// Resizable split between list and detail. Stored as a ratio so it adapts to any panel width.
const MIN_LIST_PX = 120;
const MIN_DETAIL_PX = 200;

function clampListRatio(ratio) {
  const total = els.main.clientWidth || window.innerWidth;
  // On very narrow panels the pixel minimums cannot both be met – fall back to 15 % each side.
  const min = Math.min(MIN_LIST_PX / total, 0.15);
  const max = Math.max(1 - MIN_DETAIL_PX / total, 0.85);
  return Math.min(max, Math.max(min, ratio));
}

function applyListRatio(ratio) {
  els.main.style.setProperty('--list-width', `${(clampListRatio(ratio) * 100).toFixed(2)}%`);
}

let listRatio = storage.get('listRatio', 0.35);
applyListRatio(listRatio);
window.addEventListener('resize', () => applyListRatio(listRatio));

els.resizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  els.resizer.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const mainLeft = els.main.getBoundingClientRect().left;

  const onMove = (ev) => {
    listRatio = clampListRatio((ev.clientX - mainLeft) / els.main.clientWidth);
    applyListRatio(listRatio);
  };
  const onUp = () => {
    els.resizer.removeEventListener('pointermove', onMove);
    els.resizer.removeEventListener('pointerup', onUp);
    els.resizer.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('resizing');
    storage.set('listRatio', listRatio);
  };
  els.resizer.addEventListener('pointermove', onMove);
  els.resizer.addEventListener('pointerup', onUp);
  els.resizer.addEventListener('pointercancel', onUp);
});

els.resizer.addEventListener('dblclick', () => {
  listRatio = 0.35;
  applyListRatio(listRatio);
  storage.set('listRatio', listRatio);
});

/* ---------- About view ---------- */

function avatar(initials) {
  const box = el('div', { class: 'about-avatar', text: initials });
  if (!about.photo) return box;
  const img = el('img', { src: about.photo, alt: about.name });
  img.addEventListener('load', () => box.replaceChildren(img));
  return box;
}

function renderAbout() {
  const initials = about.name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .slice(0, 2)
    .join('');
  const role = [about.role, about.location].filter(Boolean).join(' · ');
  const links = about.links
    .filter((link) => link.url)
    .map((link) => el('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer', text: link.label }));
  const version = globalThis.chrome?.runtime?.getManifest?.().version;

  const card = el('div', { class: 'about-card' }, [
    el('div', { class: 'about-header' }, [
      avatar(initials),
      el('div', {}, [el('h1', { class: 'about-name', text: about.name }), role ? el('div', { class: 'about-role', text: role }) : '']),
    ]),
    about.bio ? el('p', { class: 'about-bio', text: about.bio }) : '',
    links.length ? el('div', { class: 'about-links' }, links) : '',
    el('div', { class: 'about-footer' }, [
      el('span', {}, [
        el('img', { class: 'about-logo', src: 'icons/icon-32.png', alt: '' }),
        `GraphQL Network Monitor${version ? ` v${version}` : ''}`,
      ]),
      copyButton('Copy diagnostics', diagnosticsReport),
    ]),
  ]);
  $('#about').replaceChildren(card);
}

function diagnosticsReport() {
  const requests = state.requests.map((r) => ({
    url: r.url,
    method: r.method,
    kind: r.kind,
    ops: r.ops.map((op) => op.name).join(','),
    status: r.status,
    pending: r.pending,
    harMatched: r.harMatched,
    missingHar: Boolean(r.missingHar),
    viaWebRequest: Boolean(r.webRequestId),
    hasResponse: r.responseText != null,
  }));
  return JSON.stringify(
    {
      version: globalThis.chrome?.runtime?.getManifest?.().version,
      userAgent: navigator.userAgent,
      inDevtools: Boolean(devtools),
      requests,
      events: diagnostics,
    },
    null,
    2,
  );
}

function showAbout(visible) {
  $('#about').hidden = !visible;
  els.main.hidden = visible;
  $('#about-toggle').classList.toggle('active', visible);
  if (visible) renderAbout();
}

$('#about-toggle').addEventListener('click', () => showAbout($('#about').hidden));

/* ---------- Wiring ---------- */

let checkHook = null;

function connectBackground() {
  let port;
  try {
    port = chrome.runtime.connect({ name: 'gql-panel' });
  } catch {
    return; // extension was reloaded; this panel instance is orphaned
  }
  port.postMessage({ type: 'init', tabId: devtools.inspectedWindow.tabId });
  port.onMessage.addListener(handleBackgroundMessage);
  // The MV3 service worker can be suspended, which drops the port – reconnect.
  port.onDisconnect.addListener(() => setTimeout(connectBackground, 500));
}

if (devtools) {
  if (devtools.panels.themeName === 'dark') document.documentElement.classList.add('dark');

  devtools.network.getHAR((har) => {
    for (const entry of har?.entries ?? []) handleHarEntry(entry);
  });
  devtools.network.onRequestFinished.addListener(handleHarEntry);
  // Warn when hook.js is missing from the inspected page (extension not reloaded, restricted site access, …).
  checkHook = () =>
    devtools.inspectedWindow.eval('Boolean(window.__gqlInspectorHooked)', (hooked, error) => {
      const missing = !error && hooked === false;
      $('#hook-warning').hidden = !missing;
      diag('hook-check', { hooked, error: error ? String(error.value || error.description || 'eval failed') : null });
    });
  // The background injects the hook right after the panel connects – give it a moment before warning.
  setTimeout(checkHook, 1500);
  devtools.network.onNavigated.addListener(() => {
    if (!state.preserve) clearRequests();
    setTimeout(checkHook, 1000);
  });
  connectBackground();
} else {
  // Opened outside DevTools (e.g. as a plain page) – show demo data for UI development.
  import('./demo.js').then(({ demoEntries }) => {
    if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark');
    for (const entry of demoEntries()) {
      if (entry.pending) handleBackgroundMessage(entry);
      else handleHarEntry(entry);
    }
  });
}

render();
