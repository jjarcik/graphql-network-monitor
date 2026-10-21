import { escapeHTML } from './graphql.js';

/** Syntax-highlighted, pretty-printed JSON as an HTML string. */
export function highlightJSON(value) {
  const json = JSON.stringify(value, null, 2) ?? 'undefined';
  return escapeHTML(json).replace(
    /(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|(?!&quot;).)*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, lit, num) => {
      if (str) return colon ? `<span class="json-key">${str}</span>${colon}` : `<span class="json-str">${str}</span>`;
      if (lit) return `<span class="json-${lit === 'null' ? 'null' : 'bool'}">${lit}</span>`;
      if (num) return `<span class="json-num">${num}</span>`;
      return match;
    },
  );
}

function summary(value) {
  if (Array.isArray(value)) return { open: '[', close: ']', count: `${value.length} item${value.length === 1 ? '' : 's'}` };
  const n = Object.keys(value).length;
  return { open: '{', close: '}', count: `${n} item${n === 1 ? '' : 's'}` };
}

function primitive(value) {
  const span = document.createElement('span');
  if (value === null) {
    span.className = 'json-null';
    span.textContent = 'null';
  } else if (typeof value === 'string') {
    span.className = 'json-str';
    span.textContent = JSON.stringify(value);
  } else if (typeof value === 'number') {
    span.className = 'json-num';
    span.textContent = String(value);
  } else if (typeof value === 'boolean') {
    span.className = 'json-bool';
    span.textContent = String(value);
  } else {
    span.className = 'json-null';
    span.textContent = String(value);
  }
  return span;
}

function keyLabel(key) {
  const span = document.createElement('span');
  span.className = 'json-key';
  span.textContent = typeof key === 'number' ? String(key) : key;
  return span;
}

function buildNode(key, value, depth, expandDepth) {
  const node = document.createElement('div');
  node.className = 'jt-node';
  const row = document.createElement('div');
  row.className = 'jt-row';
  node.append(row);

  const isComposite = value !== null && typeof value === 'object';
  const caret = document.createElement('span');
  caret.className = 'jt-caret';
  row.append(caret);

  if (key !== undefined) row.append(keyLabel(key), document.createTextNode(': '));

  if (!isComposite) {
    row.append(primitive(value));
    return node;
  }

  const { open, close, count } = summary(value);
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  const brace = document.createElement('span');
  brace.className = 'jt-brace';
  const meta = document.createElement('span');
  meta.className = 'jt-count';
  meta.textContent = count;
  row.append(brace, meta);

  if (entries.length === 0) {
    brace.textContent = open + close;
    return node;
  }

  caret.classList.add('jt-toggle');
  let children = null;
  let closing = null;

  const setExpanded = (expanded) => {
    node.classList.toggle('jt-expanded', expanded);
    brace.textContent = expanded ? open : `${open}…${close}`;
    if (expanded && !children) {
      children = document.createElement('div');
      children.className = 'jt-children';
      for (const [k, v] of entries) children.append(buildNode(k, v, depth + 1, expandDepth));
      closing = document.createElement('div');
      closing.className = 'jt-close';
      closing.textContent = close;
      node.append(children, closing);
    }
  };

  node._setExpanded = setExpanded;
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    setExpanded(!node.classList.contains('jt-expanded'));
  });
  setExpanded(depth < expandDepth);
  return node;
}

/** Collapsible JSON tree. */
export function renderJsonTree(value, { expandDepth = 3 } = {}) {
  const root = document.createElement('div');
  root.className = 'json-tree';
  root.append(buildNode(undefined, value, 0, expandDepth));
  return root;
}

export function setTreeExpanded(root, expanded) {
  // Expanding builds children lazily, so walk until no new collapsed nodes appear.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of root.querySelectorAll('.jt-node')) {
      if (!node._setExpanded) continue;
      if (node.classList.contains('jt-expanded') !== expanded) {
        node._setExpanded(expanded);
        changed = expanded;
      }
    }
  }
}
