# GraphQL Network Monitor

Chrome DevTools extension that captures GraphQL operations and plain fetch/XHR requests of the inspected page and shows them in a dedicated **GraphQL Monitor** panel.

## Features

- List of GraphQL operations (type badge Q / M / S, pink stripe) and plain fetch/XHR calls (method badge, grey stripe) with status, size, time and URL
- In-flight requests shown as `(pending)` (via `webRequest`), failed requests and GraphQL `errors` highlighted
- Response bodies captured by an in-page `fetch`/`XMLHttpRequest` hook (`hook.js`), so they show up even when DevTools does not report the request; DevTools data (headers, transfer size) is merged in when available
- The page hook is injected only into the site of the inspected tab while the panel is open (registered via `chrome.scripting`, follows navigation, never on Web Store / Google account pages, removed when the panel closes)
- Headers fall back to `webRequest` (network stack) and then to the page hook when DevTools does not report a request
- Diagnostics log: About → Copy diagnostics
- Batched requests split into one row per operation, GET + persisted queries supported
- Detail tabs: **Headers**, **Request** (pretty-printed + highlighted query, variables, extensions), **Response** (collapsible JSON tree), **Response (Raw)**
- Copy Query / Copy as cURL / Copy Vars / Copy response
- Filter by name or URL, by kind (GraphQL / Fetch), operation type or errors, Preserve log, keyboard navigation (↑ ↓ Esc)
- Follows DevTools light/dark theme

## Install

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open DevTools on any page → **GraphQL Monitor** tab

Requests are captured only while DevTools is open; reload the page to capture everything from the start.
After editing the source, click reload on the extension card and reopen DevTools.

## Development

Opening `panel.html` outside DevTools renders demo data (`demo.js`):

```bash
python3 -m http.server 8765
```

then open http://localhost:8765/panel.html.

## Publishing

- `./package.sh` builds `dist/graphql-network-monitor-<version>.zip` for the Chrome Web Store (bump `version` in `manifest.json` first)
- `store/listing.md` – texts, permission justifications and privacy answers for the Developer Dashboard
- `docs/index.html` – privacy policy, published by GitHub Pages at https://jjarcik.github.io/graphql-network-monitor/
- `store/*.png` – screenshots (1280×800) and promo tiles
