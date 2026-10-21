# Chrome Web Store listing – GraphQL Network Monitor

Copy-paste values for the Developer Dashboard (https://chrome.google.com/webstore/devconsole).

## Package

- Upload: `dist/graphql-network-monitor-<version>.zip` (build with `./package.sh`)

## Store listing

**Name:** GraphQL Network Monitor

**Summary (max 132 chars):**

> DevTools panel for GraphQL & fetch traffic: formatted queries, variables, JSON responses, GraphQL errors and Copy as cURL.

**Category:** Developer Tools

**Language:** English

**Description:**

```
GraphQL Network Monitor adds a "GraphQL Monitor" panel to Chrome DevTools that makes API traffic easy to read.

GraphQL operations
• Every query, mutation and subscription listed by operation name with a Q / M / S badge
• Queries pretty-printed and syntax-highlighted, variables and extensions as formatted JSON
• Batched requests split into one row per operation, GET and persisted queries supported
• GraphQL "errors" highlighted in the list and shown on top of the response

Fetch / XHR requests
• Plain REST and JSON calls listed next to GraphQL, clearly marked with their HTTP method
• Query parameters, request body and response at a glance

For every request
• Collapsible JSON tree for responses, plus the raw response
• Request and response headers
• Status, size and timing, in-flight requests shown as "(pending)"
• Copy Query, Copy Variables, Copy Body and Copy as cURL
• Filter by name or URL, by GraphQL / Fetch, by operation type or errors
• Preserve log across navigations, keyboard navigation, light and dark theme

Works even when DevTools does not report a response: responses are captured from the page while the panel is open.

Privacy: everything stays in your browser. No servers, no analytics, no data collection.

How to use: open DevTools (F12) → "GraphQL Monitor" tab, then use the page or reload it.
```

## Graphics (`store/`)

| Field | File |
| --- | --- |
| Store icon (128×128) | `icons/icon-128.png` |
| Screenshots (1280×800) | `screenshot-1-request.png`, `screenshot-2-response-dark.png`, `screenshot-3-graphql-error.png`, `screenshot-4-fetch.png`, `screenshot-5-headers-dark.png` |
| Small promo tile (440×280) | `promo-small-440x280.png` |
| Marquee promo tile (1400×560, optional) | `promo-marquee-1400x560.png` |

## Privacy practices tab

**Single purpose description:**

> Shows the GraphQL operations and fetch/XHR requests of the inspected page in a Chrome DevTools panel, with formatted queries, variables, headers and responses, to help developers debug their web applications.

**Permission justifications:**

- **webRequest:**
  > Used to show requests that are still in flight as "(pending)" and to read request/response headers of the inspected tab, which Chrome DevTools does not always report. Only requests of tabs with the extension's DevTools panel open are processed; nothing is blocked or modified.
- **scripting:**
  > While the DevTools panel is open, the extension injects a small script into the inspected page that observes fetch/XHR calls to read their response bodies (some requests are never reported by the DevTools network API). The script is registered only for the site of the tab being inspected, never on Chrome Web Store or Google account pages, and is unregistered when the panel is closed. It does not modify requests or page content.
- **Host permission (`<all_urls>`):**
  > The extension is a debugging tool for any website the developer inspects (localhost, staging and production environments on arbitrary domains), so the hosts cannot be listed in advance. Access is only used for the site of the tab inspected in DevTools, and only while the panel is open.

**Remote code:** No, I am not using remote code. (All JavaScript is included in the package.)

**Data usage – data types collected:** none of the categories should be checked. The extension processes web traffic, headers and authentication tokens of the inspected page only locally to display them to the user; nothing is transmitted or stored outside the DevTools panel.

> If the dashboard requires you to declare handled data anyway, choose **Website content** and **Authentication information** and state that it is used only locally for the extension's single purpose, never transferred.

**Certifications (all checked):**

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://jjarcik.github.io/graphql-network-monitor/

(Source: `docs/index.html`, published by GitHub Pages from the `docs/` folder on `main`.)

## Distribution

- **Visibility:** Public, Unlisted (only people with the link – good for sharing with a team) or Private (trusted testers / your Google Workspace domain).
- **Regions:** All regions.
- **Pricing:** Free.
