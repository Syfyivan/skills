// 群发已有草稿（复用其封面）。先试群发；若出现扫码/失败，自动回退为「仅发表不推送」。
const { chromium } = require('playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const OUT = process.env.DIAG_OUT || ROOT;
const userDataDir = path.resolve(process.env.WECHAT_MP_USER_DATA_DIR || path.join(ROOT, '.wechat-mp-browser'));
const APPMSGID = process.env.APPMSGID || '100000118';

// Playwright-bundled Chromium resolver (shared module; see _publish_core/chromium.cjs).
const { resolveChromium } = require('../../_publish_core/chromium.cjs');
const exe = resolveChromium;
function log(s) { fs.appendFileSync(path.join(OUT, 'do_publish.txt'), s + '\n'); }
function notifyLark(msg, opts = {}) {
  const args = [path.join(ROOT, 'notify_lark.cjs'), msg];
  if (opts.imagePath) args.push('--image', opts.imagePath);
  try {
    const out = execFileSync('node', args, { timeout: 45000, encoding: 'utf8', maxBuffer: 1 << 20 });
    log('notify_lark ok: ' + out.trim().replace(/\s+/g, ' | '));
    return true;
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || String(e)).toString().trim();
    log('notify_lark failed: ' + detail.slice(0, 500));
    return false;
  }
}
async function shot(page, n) {
  const p = path.join(OUT, n);
  await page.screenshot({ path: p }).catch((e) => log('screenshot failed ' + n + ': ' + e.message));
  return fs.existsSync(p) ? p : '';
}
async function clickVisible(page, sels, t = 12000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) {
    for (const s of sels) {
      const l = page.locator(s);
      const n = await l.count();
      for (let i = 0; i < n; i += 1) {
        const c = l.nth(i);
        if (await c.isVisible().catch(() => false)) { await c.click().catch(() => {}); return s; }
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}
const openDialog = (p) => clickVisible(p, ['#js_send', 'button.mass_send', 'text=发表'], 15000);
const clickConfirm = (p) => clickVisible(p, ['.weui-desktop-dialog .weui-desktop-btn_primary', '.weui-desktop-dialog button:has-text("发表")', '.weui-desktop-dialog a:has-text("发表")'], 10000);
async function pollResult(page, secs) {
  const dl = Date.now() + secs * 1000;
  while (Date.now() < dl) {
    await page.waitForTimeout(2000);
    const u = page.url();
    const t = await page.locator('body').innerText().catch(() => '');
    if (/扫码|扫一扫|二维码|安全验证|确认身份/.test(t)) return 'scan';
    if (/群发成功|发表成功|已群发|已发表|发送成功/.test(t) || (/mp\.weixin\.qq\.com/.test(u) && !/appmsg_edit|action=edit/.test(u))) return 'success';
  }
  return 'timeout';
}

// Poll only for SUCCESS — used while the user scans the QR on-screen (ignores 扫码 text).
async function pollSuccess(page, secs) {
  const dl = Date.now() + secs * 1000;
  while (Date.now() < dl) {
    await page.waitForTimeout(2000);
    const u = page.url();
    const t = await page.locator('body').innerText().catch(() => '');
    if (/群发成功|发表成功|已群发|已发表|发送成功|发表记录/.test(t)) return 'success';
    if (/mp\.weixin\.qq\.com/.test(u) && !/appmsg_edit|action=edit/.test(u)) return 'success';
  }
  return 'timeout';
}

(async () => {
  fs.writeFileSync(path.join(OUT, 'do_publish.txt'), 'DO PUBLISH\n');
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 960 }, executablePath: exe() });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  let token = '';
  try { token = new URL(page.url()).searchParams.get('token') || ''; } catch (_) {}
  log('token ' + token);
  await page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${APPMSGID}&token=${token}&lang=zh_CN`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  // Open the 发表 dialog (群发通知 默认 ON => 群发推送给全部粉丝).
  log('open via ' + (await openDialog(page)));
  await page.waitForTimeout(2500);
  await shot(page, 'pub_send1.png');

  // 仅发表不推送：关掉群发通知（弹窗里的第一个开关），这样不会触发群发的扫码安全关。
  if (process.env.WECHAT_MP_NO_MASSSEND === '1') {
    await page.evaluate(() => {
      const sw = document.querySelector('.weui-desktop-dialog .weui-desktop-switch');
      if (sw) sw.click();
    }).catch(() => {});
    await page.waitForTimeout(1000);
    await shot(page, 'pub_nomass.png');
    log('turned off 群发通知 (仅发表不推送)');
  }

  // Click through the SEQUENTIAL confirm dialogs by clicking the first VISIBLE primary
  // each time: 发表 -> 继续发表 -> ... clickVisible returns null once none are visible.
  let outcome = 'timeout';
  let clicks = 0;
  for (let i = 0; i < 4; i += 1) {
    const c = await clickVisible(page, ['.weui-desktop-dialog .weui-desktop-btn_primary'], 6000);
    if (!c) break;
    clicks += 1;
    log(`confirm ${i} via ${c}`);
    await page.waitForTimeout(2500);
    await shot(page, `pub_confirm${i}.png`);
    const t = await page.locator('body').innerText().catch(() => '');
    if (/群发成功|发表成功|已群发|已发表|发送成功|群发完成|发表记录|发表中/.test(t)) { outcome = 'success'; break; }
    if (/扫码|扫一扫|二维码|安全验证|确认身份/.test(t)) {
      // Only treat as scan if there is an actual visible QR-ish square image.
      const realScan = await page.evaluate(() => [...document.querySelectorAll('img,canvas')].some((im) => {
        const r = im.getBoundingClientRect();
        return r.width > 80 && r.height > 80 && r.width < 420 && Math.abs(r.width - r.height) < 60;
      })).catch(() => false);
      if (realScan) {
        const qrPath = await shot(page, 'pub_scan_qr.png');
        log('微信验证二维码出现 — 请在屏幕上用微信扫码（最多等 180 秒）');
        notifyLark('【公众号·待扫码】发表需微信验证：请用微信扫描下方二维码完成发表（限 180 秒）。', { imagePath: qrPath });
        const sr = await pollSuccess(page, 180);
        outcome = sr === 'success' ? 'success' : 'scan-timeout';
        break;
      }
    }
  }
  log('confirm clicks: ' + clicks);
  if (outcome === 'timeout') {
    outcome = await pollResult(page, 25);
  }
  await shot(page, 'pub_result.png');
  log('RESULT: ' + outcome + ' url=' + page.url());
  await page.waitForTimeout(2000);
  await ctx.close();
})().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
