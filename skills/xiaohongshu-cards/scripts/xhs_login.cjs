// 小红书创作平台：扫码登录一次，持久化到 .xiaohongshu-browser；登录后抓发布页结构。
const { chromium } = require('playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.XHS_USER_DATA_DIR || path.join(ROOT, '.xiaohongshu-browser'));
// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
function log(s) { fs.appendFileSync(path.join(OUT, 'xhs_login.txt'), s + '\n'); }

(async () => {
  fs.writeFileSync(path.join(OUT, 'xhs_login.txt'), 'XHS LOGIN\n');
  fs.mkdirSync(userDataDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 }, executablePath: exe() });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://creator.xiaohongshu.com/', { waitUntil: 'domcontentloaded' }).catch((e) => log('goto err ' + e.message));
  await page.waitForTimeout(3000);
  log('start url: ' + page.url());

  // Wait up to 180s for login (user scans). Logged-in heuristic: URL leaves /login and
  // page no longer shows a 登录/扫码 prompt.
  let loggedIn = false;
  for (let i = 0; i < 120; i += 1) {
    const u = page.url();
    const txt = await page.locator('body').innerText().catch(() => '');
    const looksLogin = /login/i.test(u) || /扫码登录|登录小红书|手机号登录|新建笔记.*登录/.test(txt) === true && /请登录|去登录/.test(txt);
    const hasDash = /创作灵感|发布笔记|数据中心|内容管理|我的主页|发布视频|上传图文/.test(txt) || /publish|creator\.xiaohongshu\.com\/(new|home|publish)/.test(u);
    if (!/\/login/i.test(u) && hasDash) { loggedIn = true; break; }
    if (i === 0 || i % 10 === 0) log(`waiting login... url=${u}`);
    await page.waitForTimeout(1500);
  }
  log('loggedIn: ' + loggedIn + ' url=' + page.url());
  await page.screenshot({ path: path.join(OUT, 'xhs_after_login.png') }).catch(() => {});

  if (loggedIn) {
    // Try to open the 图文 publish page and capture its structure.
    await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official&from=menu', { waitUntil: 'domcontentloaded' }).catch((e) => log('publish goto err ' + e.message));
    await page.waitForTimeout(5000);
    log('\n[publish] url=' + page.url());
    log('[publish text] ' + (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500));
    const fields = await page.evaluate(() => {
      const out = { fileInputs: 0, textInputs: [], editables: [], tabs: [] };
      out.fileInputs = document.querySelectorAll('input[type="file"]').length;
      document.querySelectorAll('input[type="text"],textarea').forEach((el) => out.textInputs.push({ ph: el.getAttribute('placeholder') || null, cls: (el.className || '').toString().slice(0, 50) }));
      document.querySelectorAll('[contenteditable="true"]').forEach((el) => out.editables.push({ ph: el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || null, cls: (el.className || '').toString().slice(0, 50) }));
      document.querySelectorAll('[class*="tab"],[role="tab"]').forEach((el) => { const t = (el.innerText || '').trim(); if (t && t.length < 12) out.tabs.push(t); });
      return out;
    }).catch((e) => ({ err: e.message }));
    log('[publish fields] ' + JSON.stringify(fields));
    await page.screenshot({ path: path.join(OUT, 'xhs_publish.png') }).catch(() => {});
  }
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
