// 知乎写文章页：扫码登录一次，持久化到 .zhihu-browser；登录后抓写文章页结构。
const { chromium } = require('playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.ZHIHU_USER_DATA_DIR || path.join(ROOT, '.zhihu-browser'));
// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
function log(s) { fs.appendFileSync(path.join(OUT, 'zhihu_login.txt'), s + '\n'); }

(async () => {
  fs.writeFileSync(path.join(OUT, 'zhihu_login.txt'), 'ZHIHU LOGIN\n');
  fs.mkdirSync(userDataDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 }, executablePath: exe() });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://zhuanlan.zhihu.com/write', { waitUntil: 'domcontentloaded' }).catch((e) => log('goto err ' + e.message));
  await page.waitForTimeout(3000);
  log('start url: ' + page.url());

  // wait up to 180s for login: write editor shows a 标题 input.
  let loggedIn = false;
  for (let i = 0; i < 120; i += 1) {
    const titleVisible = await page.locator('textarea[placeholder*="标题"], input[placeholder*="标题"]').first().isVisible().catch(() => false);
    const txt = await page.locator('body').innerText().catch(() => '');
    if (titleVisible && !/登录|扫码|注册/.test(txt.slice(0, 40))) { loggedIn = true; break; }
    if (i % 8 === 0) log(`waiting login... url=${page.url()}`);
    await page.waitForTimeout(1500);
  }
  log('loggedIn: ' + loggedIn + ' url=' + page.url());
  await page.screenshot({ path: path.join(OUT, 'zhihu_write.png') }).catch(() => {});

  if (loggedIn) {
    const fields = await page.evaluate(() => {
      const out = { titleInputs: [], editables: [], fileInputs: 0, buttons: [] };
      document.querySelectorAll('textarea,input[type="text"]').forEach((el) => { const ph = el.getAttribute('placeholder'); if (ph) out.titleInputs.push({ ph, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50) }); });
      document.querySelectorAll('[contenteditable="true"]').forEach((el) => out.editables.push({ ph: el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || null, cls: (el.className || '').toString().slice(0, 60) }));
      out.fileInputs = document.querySelectorAll('input[type="file"]').length;
      document.querySelectorAll('button').forEach((el) => { const t = (el.innerText || '').trim(); if (t && t.length <= 8) out.buttons.push(t); });
      return out;
    }).catch((e) => ({ err: e.message }));
    log('[fields] ' + JSON.stringify(fields));
  }
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
