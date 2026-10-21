const SKIPPED_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding']);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function toCurl({ url, method, headers = [], body }) {
  const lines = [`curl ${shellQuote(url)}`];
  if (method && method !== 'GET' && !(method === 'POST' && body)) lines.push(`-X ${method}`);
  for (const { name, value } of headers) {
    if (name.startsWith(':') || SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    lines.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (body) lines.push(`--data-raw ${shellQuote(body)}`);
  lines.push('--compressed');
  return lines.join(' \\\n  ');
}
