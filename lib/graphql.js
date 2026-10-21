// Minimal GraphQL tokenizer, operation detection and pretty-printer with syntax highlighting.

const OPERATION_KEYWORDS = new Set(['query', 'mutation', 'subscription']);
const LITERALS = new Set(['true', 'false', 'null']);

export function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];

    if (c === ',' || c === '﻿' || /\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('"""', i)) {
      let j = i + 3;
      while (j < n && !src.startsWith('"""', j)) j += src.startsWith('\\"""', j) ? 4 : 1;
      j = Math.min(n, j + 3);
      tokens.push({ t: 'str', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(n, j + 1);
      tokens.push({ t: 'str', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if (c === '$' || c === '@') {
      let j = i + 1;
      while (j < n && /\w/.test(src[j])) j++;
      tokens.push({ t: c === '$' ? 'var' : 'dir', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /\w/.test(src[j])) j++;
      tokens.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      const m = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
      m.lastIndex = i;
      const match = m.exec(src);
      if (match) {
        tokens.push({ t: 'num', v: match[0] });
        i += match[0].length;
        continue;
      }
    }
    tokens.push({ t: 'punct', v: c });
    i++;
  }
  return tokens;
}

/** Returns top-level operations as [{ type, name }]. */
export function findOperations(query) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const tokens = tokenize(query);
  const ops = [];
  let depth = 0;
  let parenDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const atTop = depth === 0 && parenDepth === 0;

    if (atTop && tok.t === 'name' && OPERATION_KEYWORDS.has(tok.v)) {
      const next = tokens[i + 1];
      ops.push({ type: tok.v, name: next?.t === 'name' ? next.v : null });
    } else if (atTop && tok.v === '{' && (i === 0 || tokens[i - 1].v === '}')) {
      ops.push({ type: 'query', name: null }); // shorthand `{ ... }`
    }

    if (tok.t !== 'punct') continue;
    if (tok.v === '{') depth++;
    else if (tok.v === '}') depth = Math.max(0, depth - 1);
    else if (tok.v === '(') parenDepth++;
    else if (tok.v === ')') parenDepth = Math.max(0, parenDepth - 1);
  }
  return ops;
}

function tryParseJSON(text) {
  if (text == null || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Detects GraphQL operations in an HTTP request.
 * Returns { batched, ops: [{ index, type, name, query, variables, extensions, payload }] } or null.
 */
export function extractOperations({ method, url, bodyText }) {
  let payload = null;

  if (bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return null;
    }
  } else if (method === 'GET') {
    try {
      const params = new URL(url).searchParams;
      if (!params.has('query') && !params.has('extensions')) return null;
      payload = {
        query: params.get('query') ?? undefined,
        operationName: params.get('operationName') ?? undefined,
        variables: tryParseJSON(params.get('variables')),
        extensions: tryParseJSON(params.get('extensions')),
      };
    } catch {
      return null;
    }
  }

  if (!payload || typeof payload !== 'object') return null;
  const batched = Array.isArray(payload);
  const items = batched ? payload : [payload];
  const ops = [];

  items.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const query = typeof item.query === 'string' ? item.query : '';
    const found = findOperations(query);
    const persisted = Boolean(item.extensions?.persistedQuery);
    if (found.length === 0 && !persisted) return;

    const op =
      (item.operationName && found.find((o) => o.name === item.operationName)) || found[0] || { type: 'query', name: null };

    ops.push({
      index,
      type: op.type,
      name: item.operationName || op.name || '(anonymous)',
      query,
      persisted,
      variables: item.variables ?? null,
      extensions: item.extensions ?? null,
      payload: item,
    });
  });

  return ops.length ? { batched, ops } : null;
}

/** Pretty-prints a GraphQL document. Returns [{ text, cls }] segments for highlighting. */
export function formatGraphQL(src) {
  const tokens = tokenize(src);
  const parts = [];
  const stack = ['doc']; // doc | sel | vars | args | obj | list
  let last = '';
  let indent = 0;
  let afterBlockClose = false;

  const top = () => stack[stack.length - 1];
  const write = (text, cls) => {
    if (!text) return;
    parts.push({ text, cls });
    last = text[text.length - 1];
  };
  const newline = () => write('\n' + '  '.repeat(indent));
  const space = () => {
    if (last && !/[\s([]/.test(last)) write(' ');
  };
  const endsValue = (tok) =>
    tok && (['name', 'var', 'str', 'num'].includes(tok.t) || [')', ']', '}', '!'].includes(tok.v));

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const ctx = top();
    const inValues = ctx === 'args' || ctx === 'obj' || ctx === 'list' || ctx === 'vars';

    if (afterBlockClose) {
      afterBlockClose = false;
      if (tok.v !== '}') {
        if (indent === 0) write('\n\n');
        else newline();
      }
    }

    // Spaces are only written right before a token, so a trailing space/newline means "at line start".
    const atLineStart = last === ' ' || last === '\n';

    const startsItem = ['name', 'var', 'str', 'num'].includes(tok.t) || tok.v === '{' || tok.v === '[';
    if (inValues && startsItem && endsValue(prev) && !atLineStart) {
      if (ctx === 'vars') newline();
      else write(', ');
    }

    if (ctx === 'sel' && (tok.t === 'name' || tok.v === '...') && prev && !atLineStart) {
      const afterSpreadOn = prev.v === 'on' && tokens[i - 2]?.v === '...';
      if (!['{', ':', '...'].includes(prev.v) && !afterSpreadOn) newline();
    }

    if (tok.t === 'punct') {
      switch (tok.v) {
        case '{':
          if (inValues) {
            space();
            write('{ ');
            stack.push('obj');
          } else {
            space();
            write('{');
            stack.push('sel');
            indent++;
            newline();
          }
          continue;
        case '}':
          if (ctx === 'obj') {
            write(last === ' ' ? '}' : ' }');
            stack.pop();
          } else {
            stack.pop();
            indent = Math.max(0, indent - 1);
            newline();
            write('}');
            afterBlockClose = true;
          }
          continue;
        case '(':
          if (ctx === 'doc' && prev?.t === 'name') {
            write('(');
            stack.push('vars');
            indent++;
            newline();
          } else {
            write('(');
            stack.push('args');
          }
          continue;
        case ')':
          if (ctx === 'vars') {
            indent = Math.max(0, indent - 1);
            newline();
          }
          stack.pop();
          write(')');
          continue;
        case '[':
          space();
          write('[');
          stack.push('list');
          continue;
        case ']':
          stack.pop();
          write(']');
          continue;
        case ':':
          write(':');
          continue;
        case '!':
          write('!');
          continue;
        case '...':
          space();
          write('...', 'kw');
          continue;
        default:
          space();
          write(tok.v);
          continue;
      }
    }

    if (!(prev?.v === '...' && tok.v !== 'on')) space();
    write(tok.v, classify(tok, prev, next, ctx, tokens[i - 2]));
  }

  return parts;
}

function classify(tok, prev, next, ctx, prevPrev) {
  switch (tok.t) {
    case 'var':
      return 'var';
    case 'dir':
      return 'dir';
    case 'str':
      return 'str';
    case 'num':
      return 'num';
  }
  const v = tok.v;
  if (ctx === 'doc') {
    if (OPERATION_KEYWORDS.has(v) || v === 'fragment' || v === 'on') return 'kw';
    if (prev && (OPERATION_KEYWORDS.has(prev.v) || prev.v === 'fragment')) return 'op';
    if (prev?.v === 'on') return 'type';
    return null;
  }
  if (ctx === 'vars') return LITERALS.has(v) ? 'lit' : 'type';
  if (ctx === 'args' || ctx === 'obj' || ctx === 'list') {
    if (next?.v === ':') return 'arg';
    return LITERALS.has(v) ? 'lit' : 'enum';
  }
  if (ctx === 'sel') {
    if (next?.v === ':') return 'alias';
    if (prev?.v === '...') return v === 'on' ? 'kw' : 'frag';
    if (prev?.v === 'on' && prevPrev?.v === '...') return 'type';
  }
  return null;
}

export function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function formatGraphQLText(src) {
  try {
    return formatGraphQL(src).map((p) => p.text).join('');
  } catch {
    return src;
  }
}

export function formatGraphQLHTML(src) {
  try {
    return formatGraphQL(src)
      .map((p) => (p.cls ? `<span class="gql-${p.cls}">${escapeHTML(p.text)}</span>` : escapeHTML(p.text)))
      .join('');
  } catch {
    return escapeHTML(src);
  }
}
