#!/usr/bin/env node
// Render Markdown -> 公众号-ready inline-styled HTML using @wenyan-md/core.
//
// Usage:
//   node render_wenyan.mjs <markdown-file>      # render a file to stdout
//   node render_wenyan.mjs                      # render markdown from stdin
//   node render_wenyan.mjs --list-themes        # print available themes as JSON
//
// Theme selection via env (so it propagates through the python -> playwright -> python chain):
//   WECHAT_MP_THEME       公众号 theme id   (default: default; custom themes from ./themes/*.css)
//   WECHAT_MP_HL_THEME    code highlight id (default: github)
//   WECHAT_MP_MAC_STYLE   "0" to disable the mac-window code style (default: on)
//   WECHAT_MP_FOOTNOTE    "1" to convert links into footnote references (default: off)

import {
  createWenyanCore,
  getAllGzhThemes,
  getAllHlThemes,
  getTheme,
  registerTheme,
} from '@wenyan-md/core';
import { renderStyledContent } from '@wenyan-md/core/wrapper';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Register custom themes shipped as ./themes/*.css (each file id = filename). They join
// the built-in registry so they work exactly like a built-in themeId.
function registerCustomThemes() {
  const dir = fileURLToPath(new URL('./themes/', import.meta.url));
  const ids = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.css')) continue;
      const id = f.slice(0, -4);
      const css = fs.readFileSync(path.join(dir, f), 'utf-8');
      registerTheme({
        meta: { id, name: id, description: '自定义主题', appName: 'gzh', author: 'fanyi' },
        getCss: async () => css,
      });
      ids.push(id);
    }
  } catch (_) {
    /* no themes dir is fine */
  }
  return ids;
}

// Convert <img src="file://..."> back into the data-local-src placeholder the
// playwright spec (uploadLocalImages) walks, so 飞书/local images still upload.
function localizeFileImages(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc="(file:\/\/[^"]+)"/i);
    if (!srcMatch) return tag;
    let filePath;
    try {
      filePath = fileURLToPath(srcMatch[1]);
    } catch {
      return tag;
    }
    const altMatch = tag.match(/\balt="([^"]*)"/i);
    const alt = altMatch ? altMatch[1] : '';
    const label = alt || filePath.split('/').pop() || '本地图片';
    return (
      `<span data-local-src="${escAttr(filePath)}" data-local-alt="${escAttr(alt)}"` +
      ` style="display:inline-block;padding:0.9em 1.1em;border:1px dashed #d0d7de;` +
      `border-radius:6px;color:#57606a;font-size:14px;">${escHtml(label)}</span>`
    );
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const customIds = registerCustomThemes();

  if (argv.includes('--list-themes')) {
    const builtin = getAllGzhThemes().map((t) => ({ id: t.meta.id, name: t.meta.name }));
    const seen = new Set(builtin.map((b) => b.id));
    const custom = customIds.filter((id) => !seen.has(id)).map((id) => ({ id, name: `${id} (custom)` }));
    const highlight = getAllHlThemes().map((t) => t.id);
    process.stdout.write(JSON.stringify({ themes: [...builtin, ...custom], highlight }, null, 2) + '\n');
    return;
  }

  const fileArg = argv.find((a) => !a.startsWith('--'));
  const markdown = fileArg ? fs.readFileSync(fileArg, 'utf-8') : fs.readFileSync(0, 'utf-8');
  if (!markdown.trim()) {
    throw new Error('empty markdown input');
  }

  const wantTheme = (process.env.WECHAT_MP_THEME || '').trim() || 'default';
  const wantHl = (process.env.WECHAT_MP_HL_THEME || '').trim() || 'github';
  const macStyle = process.env.WECHAT_MP_MAC_STYLE !== '0';
  const footnote = process.env.WECHAT_MP_FOOTNOTE === '1';

  // getTheme covers built-in + freshly registered custom themes.
  const themeId = getTheme(wantTheme) ? wantTheme : 'default';
  const validHl = new Set(getAllHlThemes().map((t) => t.id));
  const hlThemeId = validHl.has(wantHl) ? wantHl : 'github';

  const core = await createWenyanCore({ isWechat: true });

  // Strip YAML front-matter (Hexo/Jekyll posts start with ---...---).
  let body = markdown;
  try {
    const fm = await core.handleFrontMatter(markdown);
    if (fm && typeof fm.body === 'string' && fm.body.trim()) {
      body = fm.body;
    }
  } catch {
    /* keep raw body if front-matter parsing fails */
  }

  let html = await renderStyledContent(
    body,
    { themeId, hlThemeId, isMacStyle: macStyle, isAddFootnote: footnote },
    core,
  );
  html = localizeFileImages(html);
  process.stdout.write(html);
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
