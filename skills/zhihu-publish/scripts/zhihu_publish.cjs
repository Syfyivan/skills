// 知乎文章发布：填标题 + 把 wenyan 渲染的 HTML 粘贴进知乎 Draft.js 编辑器。
// 默认 PREPARE(只填不发，给人审核)；加 --post 才进入发布流程(对外不可撤，慎用)。
//
// 用法:
//   node zhihu_publish.cjs --content-file /abs/article.md            # PREPARE：填好标题+正文，不发布
//   node zhihu_publish.cjs --content-file /abs/article.md --post     # 真发布(走发布流程)
//   可选: --title "自定义标题"  --topic "人工智能"   (--topic 仅 --post 时尝试添加话题)
//
// 复用 wechat-mp-publish 的渲染器(会 strip frontmatter，这里再保险 strip 一次后只渲染正文)。
const { chromium } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.ZHIHU_USER_DATA_DIR || path.join(ROOT, '.zhihu-browser'));
const RENDER = path.resolve(ROOT, '..', '..', 'wechat-mp-publish', 'scripts', 'render_wenyan.mjs');
function arg(n, d) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }
const POST = process.argv.includes('--post');

// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
function log(s) { fs.appendFileSync(path.join(OUT, 'zhihu_publish.txt'), s + '\n'); }
const NOTIFY = path.resolve(ROOT, '..', '..', 'wechat-mp-publish', 'scripts', 'notify_lark.cjs');
function notifyLark(msg) { try { execFileSync('node', [NOTIFY, msg], { timeout: 30000, stdio: 'ignore' }); } catch (_) {} }
function parseFM(md) { const m = md.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/); const a = {}; if (m) for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/); if (mm) a[mm[1].toLowerCase()] = mm[2].trim().replace(/^["']|["']$/g, ''); } return a; }
function stripFM(md) { return md.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, ''); }

(async () => {
  fs.writeFileSync(path.join(OUT, 'zhihu_publish.txt'), 'ZHIHU PUBLISH (' + (POST ? 'POST' : 'PREPARE') + ')\n');
  const file = arg('--content-file');
  if (!file || !fs.existsSync(file)) { log('ERROR: --content-file <md> 必填且要存在'); process.exit(1); }
  const raw = fs.readFileSync(file, 'utf-8');
  const attrs = parseFM(raw);
  const body = stripFM(raw);
  let title = arg('--title', attrs.title || '');
  title = title.slice(0, 100); // 知乎标题 ≤100 字
  // 正文 markdown -> 内联样式 HTML(知乎 Draft.js 粘贴时会丢内联样式、保留结构，得到知乎原生排版)。
  const html = execFileSync('node', [RENDER], { input: body, encoding: 'utf-8', maxBuffer: 1 << 24 });
  log(`title="${title}" titleLen=${title.length} htmlBytes=${html.length}`);

  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 }, executablePath: exe() });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://zhuanlan.zhihu.com' });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://zhuanlan.zhihu.com/write', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  log('url=' + page.url());

  // 登录态检查：写文章页应有标题输入框；没有就是没登录。
  const titleBox = page.locator('textarea.Input').first();
  if (!(await titleBox.isVisible().catch(() => false))) {
    log('NOT LOGGED IN —— 先跑 node zhihu_login.cjs 扫码。url=' + page.url());
    await page.screenshot({ path: path.join(OUT, 'zhihu_pub_notlogged.png') }).catch(() => {});
    await ctx.close(); process.exit(2);
  }

  // 1) 填标题
  try { await titleBox.click(); await titleBox.fill(title); log('title filled'); } catch (e) { log('title err ' + e.message); }

  // 2) 填正文：点 Draft.js 编辑器 -> 写剪贴板(text/html) -> Cmd+V 粘贴。失败重试一次。
  const ed = page.locator('.public-DraftEditor-content').first();
  const pasteOnce = async () => {
    await ed.click();
    await page.waitForTimeout(400);
    await page.evaluate(async (h) => {
      const bHtml = new Blob([h], { type: 'text/html' });
      const bText = new Blob([h.replace(/<[^>]+>/g, '')], { type: 'text/plain' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': bHtml, 'text/plain': bText })]);
    }, html);
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(2500);
    return page.evaluate(() => { const e = document.querySelector('.public-DraftEditor-content'); if (!e) return { err: 'no editor', textLen: 0 }; const q = (s) => e.querySelectorAll(s).length; return { textLen: (e.innerText || '').length, h: q('h1,h2,h3'), li: q('li'), a: q('a'), table: q('table') }; });
  };
  let struct = await pasteOnce();
  if (!struct || struct.textLen < 200) { log('paste weak, retry... ' + JSON.stringify(struct)); struct = await pasteOnce(); }
  log('body pasted: ' + JSON.stringify(struct));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, 'zhihu_pub_ready.png'), fullPage: true }).catch(() => {});

  if (!POST) {
    log('RESULT: PREPARED (已填标题+正文，未发布) —— 审核 OK 后用 --post 发布');
    await page.waitForTimeout(4000);
    await ctx.close();
    return;
  }

  // ====== POST：真发布 ======
  // 知乎流程：点底部「发布」→ 通常弹/展开「发布设置」(话题/封面/专栏，话题常为必填)→ 再点最终「发布」。
  // 发布是真实 DOM 按钮(非 canvas/closed-shadow)，优先 locator；不行坐标点；都不行保持窗口人工点。
  const topic = arg('--topic', '');
  const isPosted = async () => {
    const u = page.url();
    const tt = await page.locator('body').innerText().catch(() => '');
    return /发布成功|已发布/.test(tt) || /zhuanlan\.zhihu\.com\/p\/\d+/.test(u);
  };

  // 2.1) 尝试添加话题(可选，话题可能必填)
  if (topic) {
    try {
      await page.getByText('发布设置', { exact: false }).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const addTopic = page.getByText('添加话题', { exact: false }).first();
      if (await addTopic.isVisible().catch(() => false)) {
        await addTopic.click();
        await page.waitForTimeout(800);
        await page.keyboard.type(topic, { delay: 40 });
        await page.waitForTimeout(1500);
        // 选第一个候选话题
        await page.evaluate(() => { const it = [...document.querySelectorAll('[class*="Popover"] *,[class*="AutoComplete"] *,[role="option"]')].find((e) => e.children.length === 0 && (e.innerText || '').trim()); if (it) it.click(); }).catch(() => {});
        await page.waitForTimeout(800);
        log('topic tried: ' + topic);
      }
    } catch (e) { log('topic err ' + e.message); }
  }

  let posted = false;
  // A) locator 点底部蓝色「发布」(exact)。可能有多个含"发布"，取可见的最后一个。
  try {
    const cands = page.getByRole('button', { name: '发布', exact: true });
    const n = await cands.count();
    for (let i = n - 1; i >= 0; i -= 1) { const c = cands.nth(i); if (await c.isVisible().catch(() => false)) { await c.click(); log('locator click 发布 #' + i); break; } }
    await page.waitForTimeout(2500);
    // 可能再弹确认/最终发布
    await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find((e) => /^(发布|确定|确认)$/.test((e.innerText || '').trim()) && e.closest('[class*="Modal"],[class*="modal"],[role="dialog"]') && e.getBoundingClientRect().width > 0); if (b) b.click(); }).catch(() => {});
    await page.waitForTimeout(2500);
    posted = await isPosted();
    log('A(locator) posted: ' + posted);
  } catch (e) { log('A err ' + e.message); }

  // B) 坐标点底部右下「发布」(1440x900 时约 1088,874)
  if (!posted && process.env.ZHIHU_COORD_CLICK !== '0') {
    const vw = page.viewportSize() || { width: 1440, height: 900 };
    for (const [x, y] of [[1088, vw.height - 26], [vw.width - 100, vw.height - 26], [1088, vw.height - 45]]) {
      try { await page.mouse.click(x, y); log(`coord-click (${x},${y})`); } catch (_) {}
      await page.waitForTimeout(2500);
      await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find((e) => /^(发布|确定|确认)$/.test((e.innerText || '').trim()) && e.closest('[class*="Modal"],[class*="modal"],[role="dialog"]') && e.getBoundingClientRect().width > 0); if (b) b.click(); }).catch(() => {});
      await page.waitForTimeout(2000);
      if (await isPosted()) { posted = true; break; }
    }
    log('B(coord) posted: ' + posted);
  }

  // C) 保持窗口让用户人工点「发布」(最多 300s)
  if (!posted) {
    log('A/B 未成功 —— 保持窗口打开，请在窗口里手动完成「发布」(最多等 300 秒)。');
    notifyLark('【知乎·待发布】文章已填好标题+正文，请打开写作页完成「发布」：https://zhuanlan.zhihu.com/write');
    for (let i = 0; i < 150 && !posted; i += 1) { await page.waitForTimeout(2000); if (await isPosted()) posted = true; }
  }
  await page.screenshot({ path: path.join(OUT, 'zhihu_pub_result.png') }).catch(() => {});
  log('RESULT: ' + (posted ? 'POSTED 发布成功' : 'TIMEOUT 未检测到发布成功') + ' url=' + page.url());
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
