// Juejin (稀土掘金) article publish: fill the title + feed raw Markdown into the editor's
// CodeMirror (Bytemd, markdown-native — NO HTML rendering needed).
//
// Default = PREPARE (fill only, stay on the page for human review, do NOT publish).
// Add --post to run the real publish flow (irreversible / public — use with care).
//
// Usage:
//   node juejin_publish.cjs --content-file /abs/article.md                 # PREPARE: fill title+body, no publish
//   node juejin_publish.cjs --content-file /abs/article.md --post          # real publish (opens drawer → 确定并发布)
//   Optional: --title "自定义标题"  --category "人工智能"  --tags "机器学习"  --summary "50-100 字摘要"  --column "我的专栏"
//
// Juejin editor is markdown-native: we strip frontmatter and feed the body Markdown verbatim.
const { chromium } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.JUEJIN_USER_DATA_DIR || path.join(ROOT, '.juejin-browser'));
function arg(n, d) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }
const POST = process.argv.includes('--post');
const EDITOR_URL = 'https://juejin.cn/editor/drafts/new';
const ORIGIN = 'https://juejin.cn';

// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
const { attachPublishTrace } = require('../../_publish_core/request_trace.cjs');
function log(s) { fs.appendFileSync(path.join(OUT, 'juejin_publish.txt'), s + '\n'); }
const NOTIFY = path.resolve(ROOT, '..', '..', 'wechat-mp-publish', 'scripts', 'notify_lark.cjs');
function notifyLark(msg) { try { execFileSync('node', [NOTIFY, msg], { timeout: 30000, stdio: 'ignore' }); } catch (_) {} }
function charLen(s) { return Array.from(s || '').length; }
function clipChars(s, n) { return Array.from(s || '').slice(0, n).join(''); }
// Pull `title` out of YAML frontmatter, then strip the whole frontmatter block from the body.
function parseFM(md) { const m = md.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/); const a = {}; if (m) for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/); if (mm) a[mm[1].toLowerCase()] = mm[2].trim().replace(/^["']|["']$/g, ''); } return a; }
function stripFM(md) { return md.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, ''); }

(async () => {
  fs.writeFileSync(path.join(OUT, 'juejin_publish.txt'), 'JUEJIN PUBLISH (' + (POST ? 'POST' : 'PREPARE') + ')\n');
  const file = arg('--content-file');
  if (!file || !fs.existsSync(file)) { log('ERROR: --content-file <md> 必填且要存在'); process.exit(1); }
  const raw = fs.readFileSync(file, 'utf-8');
  const attrs = parseFM(raw);
  const body = stripFM(raw).replace(/^\s+/, ''); // markdown body, frontmatter removed
  let title = arg('--title', attrs.title || '');
  title = title.slice(0, 100); // keep titles sane (Juejin allows long titles; 100 is a safe cap)
  const category = arg('--category', '');
  let tags = (arg('--tags', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (tags.length > 1) {
    log(`WARN: Juejin only accepts one stable tag in this workflow; using first tag "${tags[0]}" and ignoring ${JSON.stringify(tags.slice(1))}`);
    tags = tags.slice(0, 1);
  }
  let summary = (arg('--summary', '') || '').trim();
  if (charLen(summary) > 100) {
    summary = clipChars(summary, 100);
    log('WARN: summary truncated to 100 chars for Juejin');
  }
  if (POST && charLen(summary) < 50) {
    log(`ERROR: Juejin --post requires --summary with at least 50 chars; got ${charLen(summary)}.`);
    process.exit(2);
  }
  const column = arg('--column', '');
  log(`title="${title}" titleLen=${title.length} mdBytes=${body.length} category="${category}" tags=${JSON.stringify(tags)} column="${column}" summaryLen=${charLen(summary)}`);

  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 }, executablePath: exe() });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN }).catch(() => {});
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (POST) attachPublishTrace(page, { outDir: OUT, basename: 'juejin_publish_requests', hostPattern: /juejin\.cn/i, log });
  await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  log('url=' + page.url());

  // Login check: the editor must show a 标题 input; otherwise not logged in.
  const titleBox = page.locator('input[placeholder*="标题"], textarea[placeholder*="标题"]').first();
  if (!(await titleBox.isVisible().catch(() => false))) {
    log('NOT LOGGED IN —— 先跑 node juejin_login.cjs 扫码。url=' + page.url());
    await page.screenshot({ path: path.join(OUT, 'juejin_pub_notlogged.png') }).catch(() => {});
    await ctx.close(); process.exit(2);
  }

  // 1) Title
  try { await titleBox.click(); await titleBox.fill(title); log('title filled'); } catch (e) { log('title err ' + e.message); }

  // 2) Body -> CodeMirror. Three strategies, strongest first:
  //    (a) CodeMirror 5 API: the DOM node `.CodeMirror` carries its JS instance -> setValue() (cleanest, fires change events).
  //    (b) Clipboard paste of text/plain markdown (grant clipboard perms -> click -> Meta+v).
  //    (c) keyboard.type fallback (chunked, slow).
  const cmInfo = async () => page.evaluate(() => { const cm = document.querySelector('.CodeMirror'); const v = cm && cm.CodeMirror ? cm.CodeMirror.getValue() : ((cm && cm.innerText) || ''); return { len: (v || '').length }; }).catch(() => ({ len: 0 }));
  let bodyOk = false;
  // (a) setValue via CM5 instance
  try {
    const r = await page.evaluate((md) => { const cm = document.querySelector('.CodeMirror'); if (cm && cm.CodeMirror) { cm.CodeMirror.setValue(md); cm.CodeMirror.refresh(); return true; } return false; }, body);
    await page.waitForTimeout(800);
    const info = await cmInfo();
    log('body(a) setValue=' + r + ' len=' + info.len);
    if (r && info.len > Math.min(100, body.length * 0.5)) bodyOk = true;
  } catch (e) { log('body(a) err ' + e.message); }
  // (b) clipboard paste
  if (!bodyOk) {
    try {
      const cmArea = page.locator('.CodeMirror').first();
      await cmArea.click();
      await page.waitForTimeout(300);
      await page.evaluate(async (md) => { await navigator.clipboard.writeText(md); }, body);
      await page.keyboard.press('Meta+v');
      await page.waitForTimeout(1500);
      const info = await cmInfo();
      log('body(b) paste len=' + info.len);
      if (info.len > Math.min(100, body.length * 0.5)) bodyOk = true;
    } catch (e) { log('body(b) err ' + e.message); }
  }
  // (c) keyboard.type fallback
  if (!bodyOk) {
    try {
      const cmArea = page.locator('.CodeMirror').first();
      await cmArea.click();
      await page.keyboard.type(body.slice(0, 20000), { delay: 0 });
      await page.waitForTimeout(800);
      const info = await cmInfo();
      log('body(c) type len=' + info.len);
      bodyOk = info.len > 0;
    } catch (e) { log('body(c) err ' + e.message); }
  }
  log('body filled ok=' + bodyOk);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, 'juejin_pub_ready.png'), fullPage: true }).catch(() => {});

  if (!POST) {
    log('RESULT: PREPARED (已填标题+正文，未发布) —— 审核 OK 后用 --post 发布');
    await page.waitForTimeout(4000);
    await ctx.close();
    return;
  }

  // ====== POST: real publish ======
  // Flow: click top-right 「发布」 -> drawer (category REQUIRED / tags / cover / summary / column) -> 「确定并发布」.
  const isPosted = async () => {
    const u = page.url();
    const tt = await page.locator('body').innerText().catch(() => '');
    return /发布成功/.test(tt) || /juejin\.cn\/post\/\d+/.test(u);
  };

  // 3.1) open the publish drawer
  try {
    const trigger = page.getByRole('button', { name: '发布', exact: true }).first();
    if (await trigger.isVisible().catch(() => false)) await trigger.click();
    else await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find((e) => /^发布$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0); if (b) b.click(); });
    await page.waitForTimeout(2500);
    log('drawer opened');
  } catch (e) { log('open drawer err ' + e.message); }

  // 3.2) category (REQUIRED to publish): pick the matching one, else fall back to the first item.
  try {
    const picked = await page.evaluate((cat) => {
      const items = [...document.querySelectorAll('.category-list *')].filter((e) => e.children.length === 0 && (e.innerText || '').trim());
      if (!items.length) return 'no-list';
      let target = null;
      if (cat) target = items.find((e) => (e.innerText || '').trim() === cat) || items.find((e) => (e.innerText || '').trim().includes(cat));
      if (!target) target = items[0]; // best-effort: first category so publish can proceed
      target.click();
      return (target.innerText || '').trim();
    }, category);
    log('category picked: ' + picked);
    await page.waitForTimeout(600);
  } catch (e) { log('category err ' + e.message); }

  // 3.3) tags (byte-select): click placeholder -> type -> pick first matching option
  for (const tag of tags) {
    try {
      const ph = page.locator('[class*="byte-select__placeholder"], [class*="byte-select"] input').first();
      await ph.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.keyboard.type(tag, { delay: 40 });
      await page.waitForTimeout(1500);
      const ok = await page.evaluate((t) => { const opt = [...document.querySelectorAll('li[class*="byte-select-option"], [class*="byte-select-option"]')].find((e) => (e.innerText || '').trim().includes(t)); if (opt) { opt.click(); return true; } return false; }, tag);
      log('tag "' + tag + '" added=' + ok);
      await page.waitForTimeout(500);
    } catch (e) { log('tag err ' + e.message); }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  // 3.4) summary (optional): 摘要 textarea
  if (summary) {
    try {
      const sm = page.locator('textarea[placeholder*="摘要"], textarea[class*="byte-input__textarea"]').first();
      if (await sm.isVisible().catch(() => false)) { await sm.fill(summary.slice(0, 200)); log('summary filled'); }
    } catch (e) { log('summary err ' + e.message); }
  }

  // 3.5) column (optional, best-effort — 待登录后核对): open 收录至专栏 selector and pick by text
  if (column) {
    try {
      await page.getByText(/专栏|收录至专栏/, { exact: false }).first().click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(800);
      const ok = await page.evaluate((c) => { const opt = [...document.querySelectorAll('li,[class*="option"],[class*="item"]')].find((e) => (e.innerText || '').trim().includes(c)); if (opt) { opt.click(); return true; } return false; }, column);
      log('column "' + column + '" picked=' + ok);
    } catch (e) { log('column err ' + e.message); }
  }

  await page.screenshot({ path: path.join(OUT, 'juejin_pub_ready.png'), fullPage: true }).catch(() => {});

  // 3.6) confirm: 「确定并发布」 — locator -> coord -> human (notifyLark + poll 300s)
  let posted = false;
  // A) locator / evaluate-click by text
  try {
    const btn = page.getByRole('button', { name: '确定并发布', exact: false }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click(); log('locator click 确定并发布'); }
    else await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find((e) => /确定并发布/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0); if (b) b.click(); });
    await page.waitForTimeout(3000);
    posted = await isPosted();
    log('A(locator) posted: ' + posted);
  } catch (e) { log('A err ' + e.message); }

  // B) coordinate click near the drawer's bottom-right confirm button
  if (!posted && process.env.JUEJIN_COORD_CLICK !== '0') {
    const vw = page.viewportSize() || { width: 1440, height: 900 };
    const domBox = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button, [role="button"]')]
        .filter((e) => /确定并发布/.test((e.innerText || e.textContent || '').trim()))
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }).catch(() => null);
    const points = domBox ? [domBox] : [];
    points.push([vw.width - 150, vw.height - 68], [vw.width - 90, vw.height - 40], [vw.width - 120, vw.height - 55]);
    for (const [x, y] of points) {
      try { await page.mouse.click(x, y); log(`coord-click (${x},${y})`); } catch (_) {}
      await page.waitForTimeout(2500);
      if (await isPosted()) { posted = true; break; }
    }
    log('B(coord) posted: ' + posted);
  }

  // C) keep the window open for the user to click 「确定并发布」 (poll up to 300s)
  if (!posted) {
    log('A/B 未成功 —— 保持窗口打开，请在窗口里手动点「确定并发布」(最多等 300 秒)。');
    notifyLark('【掘金·待发布】文章已填好，请去点发布：https://juejin.cn/editor/drafts/new');
    for (let i = 0; i < 150 && !posted; i += 1) { await page.waitForTimeout(2000); if (await isPosted()) posted = true; }
  }
  await page.screenshot({ path: path.join(OUT, 'juejin_pub_result.png') }).catch(() => {});
  log('RESULT: ' + (posted ? 'POSTED 发布成功' : 'TIMEOUT 未检测到发布成功') + ' url=' + page.url());
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
