#!/usr/bin/env node
// 文章 Markdown -> 小红书竖版卡片图 (1080x1440 PNG)。
// 纯本地：用 Playwright 自带 Chromium 把 HTML/CSS 卡片截图导出，不需要登录、不开公众号。
//
// Usage:
//   node gen_cards.mjs --content-file post.md [--out dir] [--theme literary]
//                      [--title ...] [--hook ...] [--series ...] [--account 前端x学习笔记]
//
// 输出：<out>/card-01.png（封面）, card-02.png ...（正文，自动分页）, 末页（引流）。

import { marked } from 'marked';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveChromium } from '../../_publish_core/chromium.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function parseFrontMatter(md) {
  const m = md.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  if (!m) return { attrs: {}, body: md };
  const attrs = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
    if (mm) attrs[mm[1].toLowerCase()] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { attrs, body: md.slice(m[0].length) };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PALETTE = {
  literary: { bg: '#faf8f3', ink: '#1d2127', text: '#2d333a', muted: '#6b7480', accent: '#b73a2c', blue: '#3f5d7e', green: '#2f765f', wash: '#eef1ee' },
  blue: { bg: '#f4f7fb', ink: '#16202e', text: '#27313f', muted: '#6b7686', accent: '#3f5d7e', blue: '#3f5d7e', green: '#2f765f', wash: '#e9eef5' },
};

const CARD_CSS = (c) => `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
#stage { width: 1080px; }
.xhs-card { width: 1080px; height: 1440px; background: ${c.bg}; position: relative; overflow: hidden; padding: 88px 84px; display: flex; flex-direction: column; }
.xhs-card::before { content: ''; position: absolute; left: 0; top: 0; width: 100%; height: 14px; background: ${c.accent}; }
.card-kicker { color: ${c.accent}; font-size: 30px; font-weight: 700; letter-spacing: 4px; }
.card-title { color: ${c.ink}; font-size: 74px; font-weight: 800; line-height: 1.24; margin: 38px 0 30px; }
.cover-deco { width: 90px; height: 8px; background: ${c.accent}; margin: 6px 0 38px; border-radius: 4px; }
.card-hook { color: ${c.muted}; font-size: 37px; line-height: 1.75; }
.card-head { display: flex; justify-content: space-between; color: #a6adb4; font-size: 27px; letter-spacing: 1px; }
.card-content { font-size: 38px; line-height: 1.8; color: ${c.text}; flex: 1; margin-top: 30px; }
.card-content.measure { position: absolute; visibility: hidden; width: 912px; margin: 0; }
.card-content h2 { font-size: 47px; color: ${c.ink}; font-weight: 800; border-left: 8px solid ${c.accent}; padding-left: 22px; margin: 6px 0 30px; line-height: 1.3; }
.card-content h3 { font-size: 41px; color: ${c.blue}; font-weight: 700; margin: 26px 0 16px; }
.card-content p { margin: 24px 0; }
.card-content strong { color: ${c.accent}; font-weight: 800; }
.card-content em { font-style: normal; color: ${c.green}; border-bottom: 2px dashed ${c.green}; }
.card-content a { color: ${c.blue}; }
.card-content blockquote { border-left: 6px solid ${c.green}; background: ${c.wash}; padding: 22px 28px; margin: 26px 0; color: ${c.muted}; border-radius: 0 12px 12px 0; }
.card-content ul, .card-content ol { padding-left: 1.5em; margin: 22px 0; }
.card-content li { margin: 14px 0; }
.card-content img { max-width: 100%; border-radius: 12px; }
.card-foot { display: flex; justify-content: space-between; align-items: center; color: #a6adb4; font-size: 28px; margin-top: 26px; }
.card-foot .acct { color: ${c.accent}; font-weight: 700; }
`;

function coverHtml(d) {
  return `<div class="xhs-card">
    <div class="card-kicker">${esc(d.series || d.account)}</div>
    <div class="card-title">${esc(d.title)}</div>
    <div class="cover-deco"></div>
    <div class="card-hook">${esc(d.hook)}</div>
    <div style="flex:1"></div>
    <div class="card-foot"><span class="acct">${d.account ? '@' + esc(d.account) : ''}</span><span>01</span></div>
  </div>`;
}
function contentHtml(d) {
  return `<div class="xhs-card">
    <div class="card-head"><span>${esc(d.series)}</span><span>${d.page} / ${d.total}</span></div>
    <div class="card-content">${d.inner}</div>
    <div class="card-foot"><span class="acct">${d.account ? '@' + esc(d.account) : ''}</span><span></span></div>
  </div>`;
}
function endHtml(d) {
  // 无任何公众号/跨平台引流（小红书违规）。
  return `<div class="xhs-card" style="text-align:center;">
    <div style="flex:1"></div>
    <div class="card-kicker" style="align-self:center; letter-spacing:6px;">— 全文完 —</div>
    <div class="card-title" style="font-size:54px; margin-top:24px;">${esc(d.series || '系列持续更新')}</div>
    <div class="card-hook" style="margin-top:14px;">喜欢就点赞 · 收藏 · 关注<br/>一起追更后续</div>
    <div style="flex:1"></div>
  </div>`;
}

async function main() {
  const file = arg('--content-file');
  if (!file) throw new Error('需要 --content-file <markdown>');
  const md = fs.readFileSync(file, 'utf-8');
  const { attrs, body } = parseFrontMatter(md);
  const title = arg('--title', attrs.title || path.basename(file));
  const hook = arg('--hook', attrs.description || '');
  const seriesRaw = arg('--series', attrs.categories || '');
  const series = String(seriesRaw).split(/[,\[\]]/).map((s) => s.trim()).filter(Boolean).pop() || '';
  // 小红书禁止跨平台引流（提到公众号=违规广告），默认不放任何账号水印。
  const account = arg('--account', '');
  const themeName = arg('--theme', 'literary');
  const color = PALETTE[themeName] || PALETTE.literary;
  const outDir = arg('--out', path.join(path.dirname(file), 'xhs-cards'));
  fs.mkdirSync(outDir, { recursive: true });

  const bodyHtml = marked.parse(body);

  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CARD_CSS(color)}</style><div id="stage"></div>`, { waitUntil: 'networkidle' });

  // Paginate body blocks by measuring rendered height against the card content budget.
  const pages = await page.evaluate(({ bodyHtml, budget }) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = bodyHtml;
    const blocks = [...tmp.children].map((el) => el.outerHTML);
    const meas = document.createElement('div');
    meas.className = 'card-content measure';
    document.body.appendChild(meas);
    const fits = (html) => { meas.innerHTML = html; return meas.scrollHeight <= budget; };
    const groups = [];
    let cur = [];
    const add = (html) => {
      if (cur.length && !fits([...cur, html].join(''))) { groups.push(cur.join('')); cur = [html]; }
      else cur.push(html);
    };
    const splitLong = (html) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      const el = d.firstElementChild;
      if (!el || el.tagName !== 'P') return [html];
      const parts = el.innerHTML.split(/(?<=[。！？])/);
      const out = [];
      let buf = '';
      for (const s of parts) {
        if (buf && !fits(`<p>${buf + s}</p>`)) { out.push(`<p>${buf}</p>`); buf = s; }
        else buf += s;
      }
      if (buf) out.push(`<p>${buf}</p>`);
      return out;
    };
    for (const b of blocks) {
      if (fits(b)) add(b);
      else for (const sub of splitLong(b)) add(sub);
    }
    if (cur.length) groups.push(cur.join(''));
    meas.remove();
    return groups;
  }, { bodyHtml, budget: 1120 });

  const total = pages.length + 1; // cover counts as 01; content pages numbered 2..; end card
  const files = [];
  let idx = 0;
  const shoot = async (html) => {
    idx += 1;
    await page.evaluate((h) => { document.getElementById('stage').innerHTML = h; }, html);
    const card = page.locator('.xhs-card').first();
    const out = path.join(outDir, `card-${String(idx).padStart(2, '0')}.png`);
    await card.screenshot({ path: out });
    files.push(out);
  };

  await shoot(coverHtml({ title, hook, series, account }));
  for (let i = 0; i < pages.length; i += 1) {
    await shoot(contentHtml({ inner: pages[i], series, account, page: i + 2, total: total + 1 }));
  }
  await shoot(endHtml({ account, series }));

  await browser.close();
  process.stdout.write(JSON.stringify({ outDir, cards: files.length, files }, null, 2) + '\n');
}

main().catch((e) => { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
