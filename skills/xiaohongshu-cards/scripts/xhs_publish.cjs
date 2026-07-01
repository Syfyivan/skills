// 小红书图文发布旧入口：上传卡片图 + 填标题/正文/话题。
//
// 账号已出现“小红书疑似使用第三方工具或脚本自动浏览/查看/发布”的预警，
// 所以默认禁止继续用浏览器自动化打开/上传/发布。保留此脚本只用于受控排障；
// 如确需临时运行，必须显式设置 XHS_ALLOW_BROWSER_AUTOMATION=1。
const { chromium } = require('playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.XHS_USER_DATA_DIR || path.join(ROOT, '.xiaohongshu-browser'));
function arg(n, d) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }
const POST = process.argv.includes('--post');
// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
function log(s) { fs.appendFileSync(path.join(OUT, 'xhs_publish.txt'), s + '\n'); }
const NOTIFY = path.resolve(ROOT, '..', '..', 'wechat-mp-publish', 'scripts', 'notify_lark.cjs');
function notifyLark(msg) { try { execFileSync('node', [NOTIFY, msg], { timeout: 30000, stdio: 'ignore' }); } catch (_) {} }
function parseFrontMatter(md) {
  const m = md.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  if (!m) return {};
  const a = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/); if (mm) a[mm[1].toLowerCase()] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return a;
}

(async () => {
  fs.writeFileSync(path.join(OUT, 'xhs_publish.txt'), 'XHS PUBLISH (' + (POST ? 'POST' : 'PREPARE') + ')\n');
  if (process.env.XHS_ALLOW_BROWSER_AUTOMATION !== '1') {
    log('BLOCKED: 小红书账号已出现第三方工具/脚本预警，默认禁止浏览器自动上传/发布。请只生成卡片图并人工发布。');
    console.error('小红书浏览器自动化已禁用：请使用 gen_cards.mjs 只生成卡片图，再人工上传发布。');
    process.exit(3);
  }
  const file = arg('--content-file');
  const attrs = file ? parseFrontMatter(fs.readFileSync(file, 'utf-8')) : {};
  const fullTitle = arg('--title', attrs.title || '');
  // 小红书 标题 ≤ 20：超长则取「：」后的副标题，再截断。
  let title = fullTitle;
  if (title.length > 20 && /[：:]/.test(title)) title = title.split(/[：:]/).pop().trim();
  title = title.slice(0, 20);
  const series = arg('--series', String(attrs.categories || '').split(/[,\[\]]/).map((s) => s.trim()).filter(Boolean).pop() || '');
  const tags = arg('--tags', '#AI #AIagent #人工智能 #学习笔记 #寓言');
  const body = (arg('--body', attrs.description || '') + '\n\n' + tags).slice(0, 1000);
  const cardsDir = arg('--cards-dir', path.join(OUT, 'xhs-cards'));
  const cards = fs.readdirSync(cardsDir).filter((f) => /^card-\d+\.png$/.test(f)).sort().map((f) => path.join(cardsDir, f));
  log(`title="${title}" series="${series}" cards=${cards.length}`);

  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 }, executablePath: exe() });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official&from=menu', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // 图文 tab
  await page.evaluate(() => {
    const leaves = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.innerText || '').trim() === '上传图文');
    const vis = leaves.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (vis[0]) vis[0].click();
  }).catch(() => {});
  await page.waitForTimeout(3000);

  // upload cards
  const fi = page.locator('input.upload-input[accept*="png"], input[type="file"][accept*="png"]').first();
  await fi.setInputFiles(cards);
  log('uploaded ' + cards.length);
  // wait for title field
  const titleSel = 'input.d-text[placeholder*="标题"], input[placeholder*="标题"]';
  for (let i = 0; i < 30; i += 1) { if (await page.locator(titleSel).first().isVisible().catch(() => false)) break; await page.waitForTimeout(1000); }
  await page.screenshot({ path: path.join(OUT, 'xhs_pub_uploaded.png') }).catch(() => {});

  // fill title
  try { const t = page.locator(titleSel).first(); await t.click(); await t.fill(title); log('title filled'); } catch (e) { log('title err ' + e.message); }
  // fill body (tiptap ProseMirror)
  try {
    const ed = page.locator('div.tiptap.ProseMirror, [contenteditable="true"]').first();
    await ed.click();
    await page.keyboard.type(body, { delay: 4 });
    log('body filled');
  } catch (e) { log('body err ' + e.message); }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'xhs_pub_ready.png'), fullPage: true }).catch(() => {});

  if (POST) {
    // Click the BOTTOM 「发布」 action button (exact text 发布; NOT the sidebar 「发布笔记」 nav).
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'xhs_pub_ready.png') }).catch(() => {});
    const isPosted = async () => {
      const u = page.url();
      const tt = await page.locator('body').innerText().catch(() => '');
      return /发布成功|发布完成|笔记发布成功|已发布/.test(tt) || /notes|note.?manager|笔记管理/i.test(u) || (/creator\.xiaohongshu/.test(u) && !/publish\/publish/.test(u));
    };
    let posted = false;

    // ---- B: best-effort coordinate click on the bottom 发布 button ----
    if (process.env.XHS_COORD_CLICK !== '0') {
      const vw = page.viewportSize() || { width: 1440, height: 900 };
      for (const [x, y] of [[vw.width - 100, vw.height - 45], [752, vw.height - 45], [vw.width - 100, vw.height - 60]]) {
        try { await page.mouse.click(x, y); log(`coord-click (${x},${y})`); } catch (_) {}
        await page.waitForTimeout(2500);
        if (await isPosted()) { posted = true; break; }
        // a confirm dialog may appear after coordinate click
        await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find((e) => /^(确定|确认|继续|发布)$/.test((e.innerText || '').trim()) && e.closest('[class*="dialog"],[class*="modal"]') && e.getBoundingClientRect().width > 0); if (b) b.click(); }).catch(() => {});
        await page.waitForTimeout(2000);
        if (await isPosted()) { posted = true; break; }
      }
      log('B(coord) posted: ' + posted);
    }

    // ---- A: keep window open for manual 发布 (fallback) ----
    if (!posted) {
      log('B 未成功 —— 保持窗口打开，请你在窗口里点底部红色「发布」（最多等 300 秒）。');
      notifyLark('【小红书·待发布】图文已填好，请打开发布页点底部红色「发布」：https://creator.xiaohongshu.com/publish/publish');
      for (let i = 0; i < 150 && !posted; i += 1) { await page.waitForTimeout(2000); if (await isPosted()) posted = true; }
    }
    await page.screenshot({ path: path.join(OUT, 'xhs_pub_result.png') }).catch(() => {});
    log('RESULT: ' + (posted ? 'POSTED 发布成功' : 'TIMEOUT 未检测到发布') + ' url=' + page.url());
  } else {
    log('RESULT: PREPARED (filled, NOT posted) — 审核后用 --post 发布');
  }
  await page.waitForTimeout(POST ? 1500 : 4000);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
