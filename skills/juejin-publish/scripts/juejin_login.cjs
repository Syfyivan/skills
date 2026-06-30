// Juejin (稀土掘金) writer page: scan QR once, persist login state to .juejin-browser,
// then dump the editor's key selectors (title / CodeMirror body / publish trigger) and,
// best-effort, the publish drawer fields (category / tags / cover / summary / column).
//
// Opening the publish drawer is safe: it does NOT publish anything — only clicking
// 「确定并发布」 publishes, which this script never does (it presses Escape to close).
const { chromium } = require('playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.JUEJIN_USER_DATA_DIR || path.join(ROOT, '.juejin-browser'));
// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
const EDITOR_URL = 'https://juejin.cn/editor/drafts/new';
function log(s) { fs.appendFileSync(path.join(OUT, 'juejin_login.txt'), s + '\n'); }

(async () => {
  fs.writeFileSync(path.join(OUT, 'juejin_login.txt'), 'JUEJIN LOGIN\n');
  fs.mkdirSync(userDataDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 }, executablePath: exe() });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto err ' + e.message));
  await page.waitForTimeout(3000);
  log('start url: ' + page.url());

  // Wait up to 180s for login: the editor shows a 标题 input AND we are not on a login screen.
  let loggedIn = false;
  for (let i = 0; i < 120; i += 1) {
    const titleVisible = await page.locator('input[placeholder*="标题"], textarea[placeholder*="标题"]').first().isVisible().catch(() => false);
    const head = (await page.locator('body').innerText().catch(() => '')).slice(0, 60);
    if (titleVisible && !/登录|扫码|注册|验证/.test(head)) { loggedIn = true; break; }
    if (i % 8 === 0) log(`waiting login... url=${page.url()}`);
    await page.waitForTimeout(1500);
  }
  log('loggedIn: ' + loggedIn + ' url=' + page.url());
  await page.screenshot({ path: path.join(OUT, 'juejin_write.png') }).catch(() => {});

  if (loggedIn) {
    // --- editor page selectors ---
    const fields = await page.evaluate(() => {
      const out = { titleInputs: [], codeMirror: 0, cmHasInstance: false, fileInputs: 0, topButtons: [] };
      document.querySelectorAll('input[type="text"],input:not([type]),textarea').forEach((el) => { const ph = el.getAttribute('placeholder'); if (ph) out.titleInputs.push({ ph, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50) }); });
      const cm = document.querySelector('.CodeMirror');
      out.codeMirror = document.querySelectorAll('.CodeMirror').length;
      out.cmHasInstance = !!(cm && cm.CodeMirror); // CodeMirror 5 exposes its instance on the DOM node
      out.fileInputs = document.querySelectorAll('input[type="file"]').length;
      document.querySelectorAll('button,[class*="btn"]').forEach((el) => { const t = (el.innerText || '').trim(); if (t && t.length <= 6) out.topButtons.push(t); });
      return out;
    }).catch((e) => ({ err: e.message }));
    log('[editor] ' + JSON.stringify(fields));

    // --- best-effort: open the publish drawer to dump its fields, then Escape (no publish) ---
    try {
      const trigger = page.getByRole('button', { name: '发布', exact: true }).first();
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click();
      } else {
        await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find((e) => /^发布$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0); if (b) b.click(); });
      }
      await page.waitForTimeout(2500);
      const drawer = await page.evaluate(() => {
        const q = (s) => document.querySelectorAll(s).length;
        const txt = (document.body.innerText || '');
        const cats = [...document.querySelectorAll('.category-list *')].filter((e) => e.children.length === 0 && (e.innerText || '').trim()).map((e) => (e.innerText || '').trim()).slice(0, 30);
        return {
          categoryList: q('.category-list'),
          categories: cats,
          byteSelect: q('[class*="byte-select"]'),
          tagPlaceholder: q('[class*="byte-select__placeholder"]'),
          fileInputs: q('input[type="file"]'),
          textareas: q('textarea, [class*="byte-input__textarea"]'),
          hasColumnText: /专栏|收录/.test(txt),
          hasConfirm: [...document.querySelectorAll('button')].some((b) => /确定并发布/.test((b.innerText || '').trim())),
        };
      }).catch((e) => ({ err: e.message }));
      log('[publish-drawer] ' + JSON.stringify(drawer));
      await page.screenshot({ path: path.join(OUT, 'juejin_publish_drawer.png') }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    } catch (e) { log('drawer dump err ' + e.message); }
  }
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
