const fs = require('node:fs');
const path = require('node:path');

const SENSITIVE = /cookie|authorization|token|secret|csrf|xsrf|signature|passwd|password|session|ticket|key/i;
const INTERESTING = /api|publish|article|post|draft|content|save|submit|release|create|update|editor|creator|column|tag|category/i;

function truncate(s, max = 12000) {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}...<truncated ${s.length - max} chars>` : s;
}

function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      const v = u.searchParams.get(k) || '';
      if (SENSITIVE.test(k)) u.searchParams.set(k, '<redacted>');
      else if (v.length > 160) u.searchParams.set(k, `${v.slice(0, 160)}...<truncated>`);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE.test(k) ? `<redacted:${String(v || '').length}>` : truncate(String(v || ''), 500);
  }
  return out;
}

function sanitizeBody(body) {
  if (!body) return '';
  let s = String(body);
  s = s.replace(/(["']?)([A-Za-z0-9_.-]*(?:token|secret|csrf|xsrf|signature|password|session|ticket|key)[A-Za-z0-9_.-]*)(\1\s*[:=]\s*)(["'])?[^"',&}\]\s]+/gi, '$1$2$3$4<redacted>');
  s = s.replace(/((?:token|secret|csrf|xsrf|signature|password|session|ticket|key)[^=&]{0,40}=)[^&]+/gi, '$1<redacted>');
  return truncate(s);
}

function shouldTrace(req, hostPattern) {
  const url = req.url();
  if (hostPattern && !hostPattern.test(url)) return false;
  if (req.method() !== 'GET') return true;
  return INTERESTING.test(url);
}

function append(file, event) {
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

function attachPublishTrace(page, { outDir, basename, hostPattern, log }) {
  const file = path.join(outDir, `${basename}.jsonl`);
  fs.writeFileSync(file, '');
  const seen = new WeakSet();

  page.on('request', (req) => {
    if (!shouldTrace(req, hostPattern)) return;
    seen.add(req);
    append(file, {
      ts: new Date().toISOString(),
      event: 'request',
      method: req.method(),
      url: sanitizeUrl(req.url()),
      resourceType: req.resourceType(),
      headers: sanitizeHeaders(req.headers()),
      postData: sanitizeBody(req.postData() || ''),
    });
  });

  page.on('response', async (res) => {
    const req = res.request();
    if (!seen.has(req) && !shouldTrace(req, hostPattern)) return;
    const headers = res.headers();
    let body = '';
    const ct = headers['content-type'] || headers['Content-Type'] || '';
    if (/json|text|javascript|html|plain/i.test(ct) || INTERESTING.test(req.url())) {
      body = await res.text().catch(() => '');
    }
    append(file, {
      ts: new Date().toISOString(),
      event: 'response',
      method: req.method(),
      url: sanitizeUrl(req.url()),
      status: res.status(),
      statusText: res.statusText(),
      contentType: ct,
      body: sanitizeBody(body),
    });
  });

  if (log) log(`request trace enabled: ${file}`);
  return file;
}

module.exports = { attachPublishTrace };
