// Runs in the page's MAIN world. Wraps fetch/XHR and reports finished requests
// (including response bodies) so the panel does not depend on DevTools reporting them.
(() => {
  if (window.__gqlInspectorHooked) return;
  window.__gqlInspectorHooked = true;

  const MAX_BODY = 5 * 1024 * 1024;
  const TEXTUAL = /json|text|xml|javascript|graphql|html|csv|x-www-form-urlencoded/i;

  const report = (data) => {
    if (typeof data.responseText === 'string' && data.responseText.length > MAX_BODY) data.responseText = null;
    window.postMessage({ __gqlInspector: 1, ...data }, '*');
  };

  const absoluteUrl = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  };

  /** Request body as text when it can be read synchronously; otherwise marks it as opaque. */
  const describeBody = (body) => {
    if (body == null) return { body: null, bodyOpaque: false };
    if (typeof body === 'string') return { body, bodyOpaque: false };
    if (body instanceof URLSearchParams) return { body: body.toString(), bodyOpaque: false };
    return { body: null, bodyOpaque: true };
  };

  const headerList = (headers) => {
    try {
      return [...new Headers(headers || undefined)].map(([name, value]) => ({ name, value }));
    } catch {
      return [];
    }
  };

  const parseRawHeaders = (raw) =>
    String(raw || '')
      .trim()
      .split(/[\r\n]+/)
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(':');
        return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
      });

  // Streams and binary payloads are skipped – reading them would block or waste memory.
  const isReadable = (contentType) => !contentType || (TEXTUAL.test(contentType) && !/event-stream/i.test(contentType));

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      const promise = originalFetch.apply(this, arguments);
      try {
        const request = input instanceof Request ? input : null;
        const url = absoluteUrl(request ? request.url : input);
        const method = String(init?.method || request?.method || 'GET').toUpperCase();
        const { body, bodyOpaque } =
          init && 'body' in init ? describeBody(init.body) : { body: null, bodyOpaque: Boolean(request?.body) };
        const startedAt = Date.now();
        const requestHeaders = headerList(init?.headers ?? request?.headers);
        const base = { url, method, body, bodyOpaque, startedAt, requestHeaders, transport: 'fetch' };

        promise.then(
          (response) => {
            const duration = Date.now() - startedAt;
            const contentType = response.headers.get('content-type') || '';
            base.responseHeaders = headerList(response.headers);
            if (!isReadable(contentType)) {
              report({ ...base, status: response.status, responseText: null, contentType, duration });
              return;
            }
            response
              .clone()
              .text()
              .then((responseText) => report({ ...base, status: response.status, responseText, contentType, duration }))
              .catch(() => report({ ...base, status: response.status, responseText: null, contentType, duration }));
          },
          (error) => report({ ...base, error: String(error?.message || error), duration: Date.now() - startedAt }),
        );
      } catch {}
      return promise;
    };
  }

  // fetch polyfills (e.g. whatwg-fetch used by cross-fetch / graphql-request) use responseType 'blob'.
  const readXhrResponse = async (xhr, contentType) => {
    if (!isReadable(contentType)) return null;
    try {
      switch (xhr.responseType) {
        case '':
        case 'text':
          return xhr.responseText;
        case 'json':
          return JSON.stringify(xhr.response);
        case 'blob':
          return xhr.response ? await xhr.response.text() : null;
        case 'arraybuffer':
          return xhr.response ? new TextDecoder().decode(xhr.response) : null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  const xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gqlInspector = { method: String(method).toUpperCase(), url: absoluteUrl(url), requestHeaders: [] };
    return xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      this.__gqlInspector?.requestHeaders.push({ name: String(name), value: String(value) });
    } catch {}
    return xhrSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const info = this.__gqlInspector;
      if (info) {
        const startedAt = Date.now();
        const described = describeBody(body);
        this.addEventListener('loadend', () => {
          const duration = Date.now() - startedAt;
          let contentType = '';
          let responseHeaders = [];
          try {
            contentType = this.getResponseHeader('content-type') || '';
            responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
          } catch {}
          readXhrResponse(this, contentType).then((responseText) =>
            report({
              ...info,
              ...described,
              status: this.status,
              responseText,
              contentType,
              responseHeaders,
              error: this.status === 0 ? 'Network error' : undefined,
              startedAt,
              duration,
              transport: 'xhr',
            }),
          );
        });
      }
    } catch {}
    return xhrSend.apply(this, arguments);
  };
})();
