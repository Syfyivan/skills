// CSDN write page: scan-to-login once, persist the session into .csdn-browser,
// then dump the write-page DOM so the publish script's selectors can be verified.
//
// Usage:
//   node csdn_login.cjs        # opens editor.csdn.net/md/, wait up to 180s for QR login
//
// Login uses a real QR scan (CSDN App), so this almost always needs a human.
const { chromium } = require('playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.CSDN_USER_DATA_DIR || path.join(ROOT, '.csdn-browser'));
// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
function log(s) { fs.appendFileSync(path.join(OUT, 'csdn_login.txt'), s + '\n'); }

// CSDN markdown editor (write-article page). mp.csdn.net is the creation hub that links here.
const WRITE_URL = 'https://editor.csdn.net/md/';

(async () => {
  fs.writeFileSync(path.join(OUT, 'csdn_login.txt'), 'CSDN LOGIN\n');
  fs.mkdirSync(userDataDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 }, executablePath: exe() });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(WRITE_URL, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto err ' + e.message));
  await page.waitForTimeout(3000);
  log('start url: ' + page.url());

  // Wait up to 180s for login: the write page shows a title <input> and we are no longer
  // on the passport/login page. (Logged-out users get bounced to passport.csdn.net.)
  let loggedIn = false;
  for (let i = 0; i < 120; i += 1) {
    const titleVisible = await page.locator('input[placeholder*="请输入文章标题"], input[placeholder*="标题"]').first().isVisible().catch(() => false);
    const onLogin = /passport\.csdn\.net|\/login/i.test(page.url());
    if (titleVisible && !onLogin) { loggedIn = true; break; }
    if (i % 8 === 0) log(`waiting login... url=${page.url()}`);
    await page.waitForTimeout(1500);
  }
  log('loggedIn: ' + loggedIn + ' url=' + page.url());
  await page.screenshot({ path: path.join(OUT, 'csdn_write.png') }).catch(() => {});

  if (loggedIn) {
    // Dump the key controls so the publish-script selectors can be checked after a real login.
    const fields = await page.evaluate(() => {
      const out = { titleInputs: [], editors: [], fileInputs: 0, buttons: [], publishBtn: null };
      // Title input (and any other placeholdered text inputs / textareas).
      document.querySelectorAll('input[type="text"],input:not([type]),textarea').forEach((el) => {
        const ph = el.getAttribute('placeholder');
        if (ph) out.titleInputs.push({ ph, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60) });
      });
      // Body editor: CSDN uses a contenteditable "cledit" markdown editor (div.editor > .cledit-section).
      document.querySelectorAll('.editor, .cledit-section, [contenteditable="true"]').forEach((el) => {
        out.editors.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 80), editable: el.getAttribute('contenteditable') });
      });
      out.fileInputs = document.querySelectorAll('input[type="file"]').length;
      document.querySelectorAll('button').forEach((el) => { const t = (el.innerText || '').trim(); if (t && t.length <= 10) out.buttons.push({ t, cls: (el.className || '').toString().slice(0, 50) }); });
      // The top-bar "发布文章" trigger (opens the publish modal).
      const pb = [...document.querySelectorAll('button')].find((e) => /发布文章/.test(e.innerText || ''));
      if (pb) out.publishBtn = { cls: (pb.className || '').toString(), text: (pb.innerText || '').trim() };
      return out;
    }).catch((e) => ({ err: e.message }));
    log('[fields] ' + JSON.stringify(fields));
  } else {
    log('NOT LOGGED IN within 180s — re-run and scan the QR with the CSDN App.');
  }
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
