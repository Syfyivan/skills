// CSDN blog publish: fill the title + pour the raw Markdown into CSDN's markdown-native
// editor. CSDN's editor (cledit) is markdown source on the left + live preview on the right,
// so we feed it the *raw markdown* (no wenyan/HTML render needed) — just strip frontmatter.
//
// Default is PREPARE (fill only, DO NOT publish) so a human can review. Pass --post to
// actually open the "发布文章" panel and publish (irreversible — confirm first).
//
// Usage:
//   node csdn_publish.cjs --content-file /abs/article.md                       # PREPARE (fill, no publish)
//   node csdn_publish.cjs --content-file /abs/article.md --post               # real publish
// Options:
//   --title "..."        title override (default = frontmatter `title`)
//   --tags a,b,c         comma-separated article tags (best-effort, --post only)
//   --column "专栏名"     category column name (best-effort, --post only)
//   --summary "摘要"      article summary (best-effort, --post only)
//
// Env:
//   DIAG_OUT             where screenshots/logs land (default: this dir)
//   CSDN_USER_DATA_DIR   persistent browser profile (default: ./.csdn-browser)
//   CSDN_PREPARE_HOLD    PREPARE: seconds to keep the window open for review (default 300)
//   CSDN_COORD_CLICK=0   disable the coordinate-click fallback for the final publish button
const { chromium } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.CSDN_USER_DATA_DIR || path.join(ROOT, '.csdn-browser'));
const WRITE_URL = 'https://editor.csdn.net/md/';
const ORIGIN = 'https://editor.csdn.net';

function arg(n, d) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }
const POST = process.argv.includes('--post');

// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
function log(s) { fs.appendFileSync(path.join(OUT, 'csdn_publish.txt'), s + '\n'); }

// Lark fallback notifier (CC-only bot, sends a clickable card to the operator).
const NOTIFY = path.resolve(ROOT, '..', '..', 'wechat-mp-publish', 'scripts', 'notify_lark.cjs');
function notifyLark(msg) { try { execFileSync('node', [NOTIFY, msg], { timeout: 30000, stdio: 'ignore' }); } catch (_) {} }

// Parse the leading YAML frontmatter block (only need `title`); strip it from the body.
function parseFM(md) {
  const m = md.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  const a = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/); if (mm) a[mm[1].toLowerCase()] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return a;
}
function stripFM(md) { return md.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, ''); }

// Current length of text in the markdown source editor (used to verify the paste landed).
async function bodyLen(page) {
  return page.evaluate(() => { const e = document.querySelector('.editor') || document.querySelector('.cledit-section'); return e ? (e.innerText || '').length : 0; }).catch(() => 0);
}

// Pour raw markdown into the contenteditable cledit editor.
// Primary: clipboard paste of text/plain markdown. Fallback: keyboard.insertText (instant).
async function fillBody(page, body) {
  const ed = page.locator('.cledit-section').first();
  const target = (await ed.count()) ? ed : page.locator('.editor [contenteditable="true"], .editor').first();
  await target.click({ timeout: 5000 }).catch((e) => log('editor click err ' + e.message));
  await page.waitForTimeout(300);
  // Clear any restored draft / template so only our article remains.
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);

  let ok = false;
  // Primary: write raw markdown to clipboard, then paste (CSDN editor is markdown-native).
  try {
    await page.evaluate(async (md) => { await navigator.clipboard.writeText(md); }, body);
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(1500);
    ok = (await bodyLen(page)) > Math.min(50, Math.floor(body.length * 0.3));
  } catch (e) { log('paste err ' + e.message); }

  // Fallback: insertText fires a single input event (no per-char typing, no md auto-format storms).
  if (!ok) {
    try {
      await target.click();
      await page.keyboard.press('Meta+a');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText(body);
      await page.waitForTimeout(800);
      ok = (await bodyLen(page)) > 0;
    } catch (e) { log('insertText err ' + e.message); }
  }
  return ok;
}

async function openTitleInput(page) {
  const input = page.locator('input[placeholder*="请输入文章标题"], input[placeholder*="标题"], input.article-bar__title--input').first();
  if (await input.isVisible().catch(() => false)) return input;
  const display = page.locator('.article-bar__title-display, .article-bar__input-box').first();
  if (await display.isVisible().catch(() => false)) {
    await display.click().catch((e) => log('title display click err ' + e.message));
    await page.waitForTimeout(300);
  }
  return input;
}

async function hasWriteEditor(page) {
  const titleInput = await page.locator('input[placeholder*="请输入文章标题"], input[placeholder*="标题"], input.article-bar__title--input').first().isVisible().catch(() => false);
  const titleDisplay = await page.locator('.article-bar__title-display, .article-bar__input-box').first().isVisible().catch(() => false);
  const editor = await page.locator('.cledit-section, .editor__inner[contenteditable="true"], .editor').first().isVisible().catch(() => false);
  return (titleInput || titleDisplay) && editor && !/passport\.csdn\.net|\/login/i.test(page.url());
}

// ---- PREPARE: keep the window open so a human can review (break early if they close it) ----
async function holdForReview(ctx, page, seconds) {
  for (let i = 0; i < Math.ceil(seconds / 2); i += 1) {
    if (ctx.pages().length === 0 || page.isClosed()) return;
    try { await page.waitForTimeout(2000); } catch (_) { return; }
  }
}

// ---- POST helpers (all best-effort; never throw, just log) ----

// Tick a category column whose label matches `name` inside the publish modal.
async function pickColumn(page, name) {
  return page.evaluate((col) => {
    const modal = document.querySelector('.modal, [class*="modal"], [role="dialog"]') || document;
    const nodes = [...modal.querySelectorAll('label, .el-checkbox, li, span, div')];
    const hit = nodes.find((n) => { const t = (n.textContent || '').trim(); return t && (t === col || t.includes(col)) && t.length <= col.length + 12; });
    if (!hit) return false;
    const cb = hit.querySelector('input[type="checkbox"]') || (hit.closest('label') && hit.closest('label').querySelector('input[type="checkbox"]'));
    (cb || hit).click();
    return true;
  }, name).catch(() => false);
}

// Open the tag box, add each tag (pick first suggestion, else Enter to create), then close it.
async function addTags(page, tags) {
  const open = page.locator('button.tag__btn-tag, button:has-text("添加文章标签")').first();
  if (await open.isVisible().catch(() => false)) { await open.click(); await page.waitForTimeout(800); }
  const input = page.locator('.mark_selection_box input[placeholder*="搜索"], input[placeholder*="请输入文字搜索"]').first();
  for (const t of tags) {
    if (!(await input.isVisible().catch(() => false))) break;
    await input.fill(t).catch(() => {});
    await page.waitForTimeout(900);
    const picked = await page.evaluate(() => {
      const opt = document.querySelector('.mark_selection_box .tag-list li, .mark_selection_box li, [class*="tag"] [class*="item"]');
      if (opt) { opt.click(); return true; }
      return false;
    }).catch(() => false);
    if (!picked) await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    log('tag added: ' + t + (picked ? ' (suggestion)' : ' (Enter)'));
  }
  await page.locator('.mark_selection_box button[title="关闭"], button[title="关闭"]').first().click().catch(() => {});
}

// Click the modal's confirm "发布文章" (scoped to the modal button bar so it's not the top-bar trigger).
async function clickFinalPublish(page) {
  const btn = page.locator('button.btn-b-red:has-text("发布文章"), .modal__button-bar button:has-text("发布文章"), [class*="modal"] button:has-text("发布文章"), .el-dialog button:has-text("发布文章")').last();
  if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); return true; }
  const box = await page.evaluate(() => {
    const roots = [...document.querySelectorAll('.modal__button-bar, [class*="modal"], .el-dialog, [role="dialog"]')];
    const scope = roots.length ? roots : [document];
    const candidates = scope.flatMap((root) => [...root.querySelectorAll('button, [role="button"]')])
      .filter((e) => /发布文章/.test((e.innerText || e.textContent || '').trim()))
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const b = candidates[0];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }).catch(() => false);
  if (box) {
    await page.mouse.click(box.x, box.y).catch(() => {});
    return true;
  }
  return false;
}

async function fillSummary(page, summary) {
  return page.evaluate((text) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const roots = [...document.querySelectorAll('.desc-box, [role="dialog"], [class*="modal"], .el-dialog')];
    const scope = roots.length ? roots : [document];
    const candidates = scope.flatMap((root) => [...root.querySelectorAll('textarea')])
      .filter(visible)
      .filter((el) => /摘要|展现列表|正文前256/.test(`${el.placeholder || ''} ${el.closest('.desc-box')?.innerText || ''}`));
    const ta = candidates[0];
    if (!ta) return false;
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, text);
    else ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, summary).catch(() => false);
}

(async () => {
  fs.writeFileSync(path.join(OUT, 'csdn_publish.txt'), 'CSDN PUBLISH (' + (POST ? 'POST' : 'PREPARE') + ')\n');
  const file = arg('--content-file');
  if (!file || !fs.existsSync(file)) { log('ERROR: --content-file <md> is required and must exist'); process.exit(1); }
  const raw = fs.readFileSync(file, 'utf-8');
  const attrs = parseFM(raw);
  const body = stripFM(raw);
  let title = arg('--title', attrs.title || '');
  title = title.slice(0, 100); // CSDN article-title practical cap ≈ 100 chars.
  const tags = (arg('--tags', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const column = arg('--column', '');
  const summary = arg('--summary', '');
  log(`title="${title}" titleLen=${title.length} bodyBytes=${body.length} tags=[${tags.join('|')}] column="${column}" summaryLen=${summary.length}`);

  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 }, executablePath: exe() });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN }).catch(() => {});
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(WRITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  log('url=' + page.url());

  // Login check: the write page must show the title area and markdown editor. New CSDN
  // renders the title as a display div until clicked, then swaps in an input.
  if (!(await hasWriteEditor(page))) {
    log('NOT LOGGED IN — run `node csdn_login.cjs` and scan the QR first. url=' + page.url());
    await page.screenshot({ path: path.join(OUT, 'csdn_pub_notlogged.png') }).catch(() => {});
    await ctx.close();
    process.exit(2);
  }

  // 1) Title.
  try {
    const titleBox = await openTitleInput(page);
    await titleBox.click();
    await titleBox.fill(title);
    log('title filled');
  } catch (e) { log('title err ' + e.message); }

  // 2) Body (raw markdown into the cledit editor).
  const bodyOk = await fillBody(page, body);
  log('body filled: ' + bodyOk + ' len=' + (await bodyLen(page)));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'csdn_pub_ready.png'), fullPage: true }).catch(() => {});

  if (!POST) {
    const hold = parseInt(process.env.CSDN_PREPARE_HOLD || '300', 10);
    log(`RESULT: PREPARED (title+body filled, NOT published). Holding window ${hold}s for review — review OK then re-run with --post.`);
    await holdForReview(ctx, page, hold);
    await ctx.close();
    return;
  }

  // ====== POST: real publish ======
  // Flow: click top-bar 发布文章 -> the publish modal opens -> best-effort column/tags/summary
  // (article type 原创 + visibility 全部可见 are left at their defaults) -> click modal 发布文章.
  const isPosted = async () => {
    const u = page.url();
    if (/blog\.csdn\.net\/.+\/article\/details\/\d+/.test(u)) return true;
    if (/mp\.csdn\.net\/.*(success|creation)/.test(u)) return true;
    const t = await page.locator('body').innerText().catch(() => '');
    return /发布成功|发表成功/.test(t);
  };

  // Open the publish modal via the top-bar trigger.
  let opened = false;
  try {
    const trigger = page.locator('button.btn-publish:has-text("发布文章"), button:has-text("发布文章")').first();
    if (await trigger.isVisible().catch(() => false)) { await trigger.click(); opened = true; }
  } catch (e) { log('open-modal err ' + e.message); }
  if (!opened) {
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /发布文章/.test(e.innerText || '')); if (b) b.click(); }).catch(() => {});
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, 'csdn_pub_panel.png') }).catch(() => {});

  // Best-effort modal fields.
  if (column) { const c = await pickColumn(page, column); log('column "' + column + '" picked: ' + c); }
  if (tags.length) { try { await addTags(page, tags); } catch (e) { log('tags err ' + e.message); } }
  if (summary) {
    try {
      const done = await fillSummary(page, summary);
      log('summary filled: ' + done);
    } catch (e) { log('summary err ' + e.message); }
  }
  await page.waitForTimeout(500);

  let posted = false;

  // A) Click the modal's confirm 发布文章 (real DOM button).
  try {
    const clicked = await clickFinalPublish(page);
    log('A(locator) clicked: ' + clicked);
    await page.waitForTimeout(3000);
    // A possible secondary confirm dialog.
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /^(确定|确认|继续发布|发布)$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0); if (b) b.click(); }).catch(() => {});
    await page.waitForTimeout(2500);
    posted = await isPosted();
    log('A posted: ' + posted);
  } catch (e) { log('A err ' + e.message); }

  // B) Coordinate-click fallback (modal confirm sits bottom-right of the modal; coords APPROXIMATE — verify after first login).
  if (!posted && process.env.CSDN_COORD_CLICK !== '0') {
    const vw = page.viewportSize() || { width: 1440, height: 900 };
    for (const [x, y] of [[Math.round(vw.width * 0.62), Math.round(vw.height * 0.86)], [Math.round(vw.width * 0.7), Math.round(vw.height * 0.86)], [vw.width - 180, vw.height - 90]]) {
      try { await page.mouse.click(x, y); log(`coord-click (${x},${y})`); } catch (_) {}
      await page.waitForTimeout(2500);
      if (await isPosted()) { posted = true; break; }
    }
    log('B(coord) posted: ' + posted);
  }

  // C) Human fallback: notify the operator and keep the window open to click 发布文章 (poll ≤300s).
  if (!posted) {
    log('A/B failed — keeping window open for a human to click 发布文章 (wait up to 300s).');
    notifyLark('【CSDN·待发布】文章已填好，请去点发布：https://editor.csdn.net/md/');
    for (let i = 0; i < 150 && !posted; i += 1) { await page.waitForTimeout(2000); if (await isPosted()) posted = true; }
  }

  await page.screenshot({ path: path.join(OUT, 'csdn_pub_result.png') }).catch(() => {});
  log('RESULT: ' + (posted ? 'POSTED 发布成功' : 'TIMEOUT 未检测到发布成功') + ' url=' + page.url());
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
