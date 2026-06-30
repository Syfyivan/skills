#!/usr/bin/env node
// Extract the main article from a web page (or raw HTML) and convert to Markdown.
// The Markdown then flows through render_wenyan.mjs to get 公众号 styling.
//
// Usage:
//   node url_to_markdown.mjs --url https://blog.example.com/post   # fetch + extract
//   node url_to_markdown.mjs page.html                             # local HTML file
//   cat page.html | node url_to_markdown.mjs                       # raw HTML on stdin
//
// Output: Markdown on stdout, with a `--- title: ... ---` front-matter line when a
// title was detected (picked up downstream for the article title).

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// curl honors HTTP(S)_PROXY / NO_PROXY (incl. credentials) automatically, which
// Node's global fetch does not — so we prefer curl and fall back to fetch.
function fetchViaCurl(url) {
  const res = spawnSync(
    'curl',
    ['-sSL', '--compressed', '--max-time', '30', '-A', UA, url],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`curl ${url} failed: ${(res.stderr || '').trim() || 'exit ' + res.status}`);
  }
  return res.stdout;
}

async function fetchViaFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  return await res.text();
}

async function loadInput() {
  const url = flagValue('--url');
  if (url) {
    try {
      return { html: fetchViaCurl(url), url };
    } catch (curlErr) {
      try {
        return { html: await fetchViaFetch(url), url };
      } catch {
        throw curlErr;
      }
    }
  }
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (fileArg) return { html: fs.readFileSync(fileArg, 'utf-8'), url: undefined };
  return { html: fs.readFileSync(0, 'utf-8'), url: undefined };
}

function frontMatter(title) {
  const t = (title || '').trim();
  if (!t) return '';
  return `---\ntitle: "${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n---\n\n`;
}

function buildTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  // Preserve figure captions as italic lines under the image.
  td.addRule('figure', {
    filter: 'figure',
    replacement: (_content, node) => {
      const img = node.querySelector('img');
      const cap = node.querySelector('figcaption');
      const src = img ? img.getAttribute('src') || '' : '';
      const alt = img ? img.getAttribute('alt') || '' : '';
      const out = src ? `![${alt}](${src})` : '';
      const caption = cap && cap.textContent.trim() ? `\n\n*${cap.textContent.trim()}*` : '';
      return `\n\n${out}${caption}\n\n`;
    },
  });
  return td;
}

async function main() {
  const { html, url } = await loadInput();
  const dom = new JSDOM(html, url ? { url } : {});
  const doc = dom.window.document;

  let title = (doc.title || '').trim();
  let contentHtml = '';
  try {
    const article = new Readability(doc).parse();
    if (article && article.content) {
      contentHtml = article.content;
      if (article.title) title = article.title.trim();
    }
  } catch {
    /* fall through to body */
  }
  if (!contentHtml) {
    contentHtml = (doc.body && doc.body.innerHTML) || html;
  }

  const markdown = buildTurndown().turndown(contentHtml).trim();
  if (!markdown) throw new Error('未能从页面提取到正文');
  process.stdout.write(frontMatter(title) + markdown + '\n');
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
