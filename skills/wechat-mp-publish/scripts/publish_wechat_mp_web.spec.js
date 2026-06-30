const { test, chromium } = require('playwright/test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveChromium } = require('../../_publish_core/chromium.cjs');

const ROOT = path.resolve(__dirname);
const RENDERER = path.join(ROOT, 'publish_wechat_mp.py');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value.trim();
}

function optionalEnv(name, fallback = '') {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

// Find an installed Chromium to drive. Prefer the build Playwright expects; if that
// build isn't downloaded (version skew), fall back to any chromium-* in the cache.
function resolveChromiumExecutable() {
  // Prefer the exact build Playwright expects; if that build isn't downloaded
  // (version skew), fall back to the shared scanner over .pw-browsers / the cache.
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return resolveChromium() || null;
}

function renderHtmlFromSource() {
  const content = optionalEnv('WECHAT_MP_CONTENT');
  const contentFile = optionalEnv('WECHAT_MP_CONTENT_FILE');
  const contentFormat = optionalEnv('WECHAT_MP_CONTENT_FORMAT', 'auto');

  if (Boolean(content) === Boolean(contentFile)) {
    throw new Error('必须设置 WECHAT_MP_CONTENT 或 WECHAT_MP_CONTENT_FILE 其中之一');
  }

  const args = [RENDERER, '--render-only', '--content-format', contentFormat];
  if (content) {
    args.push('--content', content);
  } else {
    args.push('--content-file', path.resolve(contentFile));
  }

  const result = spawnSync('python3', args, { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Markdown 转 HTML 失败').trim());
  }
  return result.stdout.trim();
}

function htmlToPlainText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDigest(html) {
  const plain = htmlToPlainText(html);
  const maxLength = Number(optionalEnv('WECHAT_MP_DIGEST_MAX_LENGTH', '120')) || 120;
  return plain.slice(0, maxLength);
}

async function waitForAnyVisible(page, selectors, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        try {
          if (await locator.isVisible()) {
            return locator;
          }
        } catch (_) {}
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`未找到可见元素: ${selectors.join(' | ')}`);
}

async function clickFirst(page, selectors, timeout = 15000) {
  const locator = await waitForAnyVisible(page, selectors, timeout);
  await locator.click();
  return locator;
}

async function fillFirst(page, selectors, value, timeout = 15000) {
  const locator = await waitForAnyVisible(page, selectors, timeout);
  await locator.fill('');
  await locator.fill(value);
  return locator;
}

const SELECT_ALL = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
const PASTE = process.platform === 'darwin' ? 'Meta+v' : 'Control+v';
const TITLE_PLACEHOLDER = '请在这里输入标题';

async function typeIntoTitle(page, title) {
  // New editor: the visible title is a ProseMirror; #title is the hidden form mirror.
  const pmTitle = page.locator(`div.ProseMirror[data-placeholder="${TITLE_PLACEHOLDER}"]`).first();
  if (await pmTitle.count()) {
    try {
      await pmTitle.click();
      await page.keyboard.press(SELECT_ALL);
      await page.keyboard.press('Backspace');
      await page.keyboard.type(title, { delay: 8 });
      const text = (await pmTitle.innerText().catch(() => '')).trim();
      if (text) return;
    } catch (_) {}
  }
  // Fallback: legacy textarea#title.
  const ta = page.locator('#title, textarea.js_title, textarea[placeholder*="标题"]').first();
  if (await ta.count()) {
    try {
      await ta.fill('');
      await ta.fill(title);
      return;
    } catch (_) {}
  }
  throw new Error('未找到标题输入框');
}

async function fillEditorHtml(page, html) {
  // Body editor is a ProseMirror (the title ProseMirror carries data-placeholder,
  // the body one does not). ProseMirror ignores innerHTML mutation, so we paste:
  // put styled HTML on the clipboard and Ctrl/Cmd+V — ProseMirror parses it natively
  // and 公众号 preserves the inline styles.
  const body = page.locator(`div.ProseMirror:not([data-placeholder="${TITLE_PLACEHOLDER}"])`).first();
  await body.waitFor({ state: 'visible', timeout: 20000 });
  await body.click();
  await page.keyboard.press(SELECT_ALL);
  await page.keyboard.press('Backspace');

  const wroteClipboard = await page.evaluate(async (value) => {
    try {
      const item = new ClipboardItem({ 'text/html': new Blob([value], { type: 'text/html' }) });
      await navigator.clipboard.write([item]);
      return true;
    } catch (_) {
      return false;
    }
  }, html);

  if (wroteClipboard) {
    await body.click();
    await page.keyboard.press(PASTE);
  } else {
    // Fallback: dispatch a synthetic paste carrying the HTML.
    await page.evaluate((value) => {
      const editors = Array.from(document.querySelectorAll('div.ProseMirror'));
      const el = editors.find((d) => d.getAttribute('data-placeholder') !== '请在这里输入标题') || editors[0];
      if (!el) throw new Error('未找到正文编辑区');
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', value);
      dt.setData('text/plain', '');
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    }, html);
  }

  // Wait for ProseMirror to ingest the paste.
  await page.waitForTimeout(2500);
  const len = await body.evaluate((node) => (node.innerText || '').trim().length).catch(() => 0);
  if (!len) throw new Error('正文粘贴后为空，可能编辑器结构又变了');
}

function allScopes(page) {
  return [page, ...page.frames()];
}

async function clickOptional(page, selectors, timeout = 5000) {
  try {
    return await clickFirst(page, selectors, timeout);
  } catch (_) {
    return null;
  }
}

async function findFirstLocalImagePlaceholder(page) {
  for (const scope of allScopes(page)) {
    try {
      const locator = scope.locator('[data-local-src]').first();
      if (await locator.count()) {
        return locator;
      }
    } catch (_) {}
  }
  return null;
}

async function setInputFilesOnAnyScope(page, filePath) {
  for (const scope of allScopes(page)) {
    try {
      const inputs = scope.locator('input[type="file"]');
      const count = await inputs.count();
      for (let index = count - 1; index >= 0; index -= 1) {
        try {
          await inputs.nth(index).setInputFiles(filePath);
          return true;
        } catch (_) {}
      }
    } catch (_) {}
  }
  return false;
}

async function openInlineImageUpload(page) {
  await clickOptional(page, [
    'text=图片',
    'text=上传图片',
    'text=本地上传',
    'text=从本地上传',
    'button:has-text("图片")',
    'button:has-text("上传图片")',
    '[aria-label*="图片"]',
    '[title*="图片"]',
  ], 4000);
}

async function uploadLocalImage(page, filePath) {
  await openInlineImageUpload(page);
  if (!(await setInputFilesOnAnyScope(page, filePath))) {
    throw new Error(`未找到可用的图片上传控件: ${filePath}`);
  }
  const waitMs = Number(optionalEnv('WECHAT_MP_LOCAL_IMAGE_UPLOAD_WAIT_MS', '3000')) || 3000;
  await page.waitForTimeout(waitMs);
}

async function uploadLocalImages(page) {
  const uploadedPaths = [];
  while (true) {
    const placeholder = await findFirstLocalImagePlaceholder(page);
    if (!placeholder) {
      return uploadedPaths;
    }
    const filePath = await placeholder.getAttribute('data-local-src');
    if (!filePath) {
      await placeholder.evaluate(node => node.remove());
      continue;
    }
    await placeholder.click();
    await uploadLocalImage(page, filePath);
    uploadedPaths.push(filePath);
    await placeholder.evaluate(node => node.remove());
    await page.waitForTimeout(300);
  }
}

async function openCoverPanel(page) {
  await clickOptional(page, [
    'text=封面和摘要',
    'text=封面摘要',
    'text=添加封面',
    'text=设置封面',
    '.js_cover_btn_area',
  ], 5000);
  await clickOptional(page, [
    '.js_cover_btn_area',
    '.js_chooseCoverWrap',
    'text=拖拽或选择封面',
    'text=换一张',
  ], 5000);
}

async function setCoverFromBodyFirstImage(page) {
  await openCoverPanel(page);
  const trigger = await clickOptional(page, [
    'text=正文图片',
    'text=从正文中选择',
    'text=从正文选择',
    'text=文章图片',
    'text=正文首图',
  ], 6000);
  if (!trigger) {
    return false;
  }
  const picker = await clickOptional(page, [
    '.cover img',
    '.material_list img',
    '.img_list img',
    '.weui-desktop-img-picker img',
    'img',
  ], 10000);
  if (!picker) {
    return false;
  }
  await clickOptional(page, [
    'text=确认',
    'text=使用',
    'text=选用',
    'text=完成',
  ], 10000);
  return true;
}

async function setCoverFromLocalImage(page, filePath) {
  await openCoverPanel(page);
  await clickOptional(page, [
    'text=本地上传',
    'text=上传封面',
    'text=从本地上传',
    'text=上传图片',
    'text=选择图片',
  ], 5000);
  if (!(await setInputFilesOnAnyScope(page, filePath))) {
    return false;
  }
  const waitMs = Number(optionalEnv('WECHAT_MP_LOCAL_COVER_UPLOAD_WAIT_MS', '3000')) || 3000;
  await page.waitForTimeout(waitMs);
  await clickOptional(page, [
    'text=确认',
    'text=使用',
    'text=选用',
    'text=完成',
  ], 10000);
  return true;
}

async function ensureLoggedIn(page) {
  await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
  const loginTimeout = Number(optionalEnv('WECHAT_MP_LOGIN_TIMEOUT_MS', '180000')) || 180000;
  const deadline = Date.now() + loginTimeout;
  let announced = false;
  // Logged in iff the home page carries a token in the URL (?...&token=NNN).
  while (Date.now() < deadline) {
    let token = '';
    try {
      token = new URL(page.url()).searchParams.get('token') || '';
    } catch (_) {}
    if (token) return;
    if (!announced) {
      console.log('>>> 请在打开的浏览器中用手机微信扫码登录公众号后台（最多等待 180 秒）…');
      announced = true;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error('登录超时：请在打开的浏览器中扫码登录公众号后台');
}

async function resolveToken(page) {
  let token = '';
  try {
    token = new URL(page.url()).searchParams.get('token') || '';
  } catch (_) {}
  if (token) return token;
  await page.goto('https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN', {
    waitUntil: 'domcontentloaded',
  });
  for (let i = 0; i < 40 && !token; i += 1) {
    try {
      token = new URL(page.url()).searchParams.get('token') || '';
    } catch (_) {}
    if (!token) await page.waitForTimeout(500);
  }
  return token;
}

async function openEditor(page) {
  const token = await resolveToken(page);
  // type=77 is the current 图文 editor (matches the draft list URL). It loads the
  // full editor in the same tab, so we go straight there — no menu click that would
  // spawn a new tab and strand the automation.
  const editUrl =
    `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&isNew=1&lang=zh_CN` +
    (token ? `&token=${token}` : '');
  await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
  await waitForAnyVisible(
    page,
    [`div.ProseMirror[data-placeholder="${TITLE_PLACEHOLDER}"]`, '#title', 'div.ProseMirror'],
    30000,
  );
}

async function debugShot(page, name) {
  const dir = optionalEnv('WECHAT_MP_DEBUG_DIR');
  if (!dir) return;
  try {
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
  } catch (_) {}
}

// Click the first VISIBLE match. `selectors` may be a single selector or an array;
// each item is a separate locator (never join selectors with commas across engines).
async function clickFirstVisible(page, selectors, timeout = 8000) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of list) {
      const loc = page.locator(sel);
      const n = await loc.count();
      for (let i = 0; i < n; i += 1) {
        const c = loc.nth(i);
        if (await c.isVisible().catch(() => false)) {
          await c.click().catch(() => {});
          return true;
        }
      }
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function generateAiCover(page) {
  try {
    // Open the cover popover, then enter AI 配图.
    await clickFirstVisible(page, ['.js_cover_btn_area', 'text=拖拽或选择封面', '.js_chooseCoverWrap'], 8000);
    await page.waitForTimeout(1000);
    const opened = await clickFirstVisible(page, ['.js_aiImage', 'a:has-text("AI 配图")'], 8000);
    if (!opened) {
      await page.keyboard.press('Escape').catch(() => {});
      return 'none';
    }
    await page.waitForTimeout(2500);
    await debugShot(page, 'cover1_ai_dialog');

    // Each generated image exposes a 「使用」 op-button; count existing ones first so we
    // can detect the freshly generated one.
    const useSel = 'div.ai-image-op-btn:has-text("使用")';
    const before = await page.locator(useSel).count();

    const prompt = optionalEnv('WECHAT_MP_COVER_PROMPT') || '根据文章主题生成一张公众号封面图';
    const ta = page.locator('textarea.chat_textarea').first();
    await ta.waitFor({ state: 'visible', timeout: 8000 });
    await ta.click();
    await ta.fill(prompt);
    await page.waitForTimeout(800);

    // Send (button.send-btn enables once the prompt is non-empty); fall back to Enter.
    const sent = await clickFirstVisible(page, ['button.send-btn:not(.send-btn_disabled)'], 5000);
    if (!sent) {
      await ta.press('Enter').catch(() => {});
    }
    await debugShot(page, 'cover1b_sent');

    // Wait for a new image (a new 「使用」 button appears). Generation can take 10–60s.
    let appeared = false;
    for (let i = 0; i < 30; i += 1) {
      await page.waitForTimeout(3000);
      if ((await page.locator(useSel).count()) > before) {
        appeared = true;
        break;
      }
    }
    if (!appeared) {
      await debugShot(page, 'cover2_timeout');
      await page.keyboard.press('Escape').catch(() => {});
      return 'none';
    }
    await page.waitForTimeout(1500);
    await debugShot(page, 'cover2_generated');

    // Use the newest generated image as the cover (the last 「使用」 button).
    const useButtons = page.locator(useSel);
    const last = useButtons.nth((await useButtons.count()) - 1);
    await last.scrollIntoViewIfNeeded().catch(() => {});
    await last.click().catch(() => {});
    await page.waitForTimeout(2500);
    await debugShot(page, 'cover3_used');

    // A crop/confirm step may follow.
    await clickFirstVisible(
      page,
      ['button:has-text("确定")', 'button:has-text("完成")', 'button:has-text("确认")', 'text=下一步'],
      8000,
    );
    await page.waitForTimeout(1500);
    await debugShot(page, 'cover4_done');
    return 'ai';
  } catch (_) {
    await debugShot(page, 'cover_error');
    await page.keyboard.press('Escape').catch(() => {});
    return 'none';
  }
}

async function publishArticle(page) {
  // Open the 发表 dialog. NOTE: 群发通知 defaults ON => pushes to all followers (1/day).
  await clickFirstVisible(page, ['#js_send', 'button.mass_send', 'text=发表'], 20000);
  await page.waitForTimeout(2500);
  await debugShot(page, 'publish1_dialog');

  // Optional: turn OFF 群发通知 (publish without mass-push) — best effort.
  if (optionalEnv('WECHAT_MP_NO_MASSSEND') === '1') {
    await page.evaluate(() => {
      const sw = document.querySelector(
        '.weui-desktop-dialog .weui-desktop-switch_checked, .weui-desktop-dialog .weui-desktop-switch--on, .weui-desktop-dialog .weui-desktop-switch.weui-desktop-switch_active',
      );
      if (sw) sw.click();
    }).catch(() => {});
    await page.waitForTimeout(800);
    await debugShot(page, 'publish1b_nomass');
  }

  // Confirm inside the dialog (green primary button labeled 发表).
  const confirmed = await clickFirstVisible(page, [
    '.weui-desktop-dialog .weui-desktop-btn_primary',
    '.weui-desktop-dialog button:has-text("发表")',
    '.weui-desktop-dialog a:has-text("发表")',
  ], 10000);
  await page.waitForTimeout(3500);
  await debugShot(page, 'publish2_after');

  // 群发 can trigger a 安全验证/扫码 step; surface it so the caller can relay the QR.
  const needScan = await page
    .evaluate(() => /扫码|扫一扫|二维码|安全验证|确认身份/.test(document.body.innerText || ''))
    .catch(() => false);
  if (needScan) {
    await debugShot(page, 'publish3_scan');
    throw new Error('PUBLISH_NEED_SCAN');
  }
  if (!confirmed) throw new Error('未找到发表确认按钮');
}

async function saveDraft(page) {
  await clickFirst(page, [
    'text=保存为草稿',
    'text=保存草稿',
    'text=保存',
    'button:has-text("保存")',
  ], 20000);
}

async function waitForDraftResult(page) {
  const timeout = Number(optionalEnv('WECHAT_MP_DRAFT_TIMEOUT_MS', '60000')) || 60000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tip = page.locator('#js_save_success').first();
    if ((await tip.count()) && (await tip.isVisible().catch(() => false))) {
      return { url: page.url(), saved: true };
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/保存成功|草稿已保存|已保存到草稿箱|保存为草稿成功|已保存/.test(bodyText)) {
      return { url: page.url(), saved: true };
    }
    await page.waitForTimeout(1000);
  }
  // 公众号 autosaves continuously; if the explicit toast wasn't captured the draft is
  // still almost certainly persisted, so report soft success instead of failing.
  return { url: page.url(), saved: false, note: '未捕获保存成功提示，公众号通常已自动存草稿，请到草稿箱确认' };
}

async function waitForPublishResult(page) {
  const timeout = Number(optionalEnv('WECHAT_MP_PUBLISH_TIMEOUT_MS', '180000')) || 180000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (/mp\.weixin\.qq\.com/.test(currentUrl) && !/edit/.test(currentUrl)) {
      return { url: currentUrl };
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/发表成功|发布成功|已发表|群发成功|已群发|发送成功|群发完成/.test(bodyText)) {
      return { url: currentUrl };
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('等待发布结果超时');
}

test('publish wechat mp article via web ui', async () => {
  test.setTimeout(0);

  const title = requiredEnv('WECHAT_MP_TITLE');
  const author = optionalEnv('WECHAT_MP_AUTHOR', '繁漪');
  const action = optionalEnv('WECHAT_MP_ACTION', 'draft');
  const userDataDir = path.resolve(optionalEnv('WECHAT_MP_USER_DATA_DIR', path.join(ROOT, '.wechat-mp-browser')));
  fs.mkdirSync(userDataDir, { recursive: true });

  const html = renderHtmlFromSource();
  const digest = optionalEnv('WECHAT_MP_DIGEST', buildDigest(html));

  // Default to Playwright's bundled Chromium (its own binary + profile dir) so we never
  // collide with the user's running Google Chrome. Set WECHAT_MP_BROWSER_CHANNEL=chrome to opt back in.
  const launchOptions = { headless: false, viewport: { width: 1440, height: 960 } };
  const channel = optionalEnv('WECHAT_MP_BROWSER_CHANNEL', '');
  if (channel) {
    launchOptions.channel = channel;
  } else {
    const exe = resolveChromiumExecutable();
    if (exe) launchOptions.executablePath = exe;
  }
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  // Needed so we can put styled HTML on the clipboard and paste it into ProseMirror.
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://mp.weixin.qq.com',
    });
  } catch (_) {}
  const page = context.pages()[0] || await context.newPage();

  try {
    await ensureLoggedIn(page);
    await openEditor(page);
    await typeIntoTitle(page, title);

    if (author) {
      try {
        await fillFirst(page, [
          '#author',
          'input.js_author',
          'input[placeholder*="作者"]',
        ], author, 8000);
      } catch (_) {}
    }

    if (digest) {
      try {
        await fillFirst(page, [
          '#js_description',
          'textarea.js_desc',
          'textarea[placeholder*="摘要"]',
        ], digest, 8000);
      } catch (_) {}
    }

    await fillEditorHtml(page, html);
    const uploadedPaths = await uploadLocalImages(page);
    let coverSource = 'skip';
    if (optionalEnv('WECHAT_MP_SKIP_COVER') !== '1') {
      coverSource = await generateAiCover(page);
      if (coverSource === 'none') {
        if (await setCoverFromBodyFirstImage(page)) {
          coverSource = 'body-first-image';
        } else if (uploadedPaths.length && await setCoverFromLocalImage(page, uploadedPaths[0])) {
          coverSource = 'first-local-image';
        }
      }
    }
    let result;
    let finalAction = action;
    if (action === 'publish') {
      try {
        await publishArticle(page);
        result = await waitForPublishResult(page);
      } catch (_) {
        await saveDraft(page);
        result = await waitForDraftResult(page);
        finalAction = 'draft';
      }
    } else {
      await saveDraft(page);
      result = await waitForDraftResult(page);
    }
    console.log(JSON.stringify({ mode: 'web', requested_action: action, final_action: finalAction, title, author, cover_source: coverSource, result_url: result.url }, null, 2));
  } finally {
    if (optionalEnv('WECHAT_MP_KEEP_BROWSER', '0') !== '1') {
      await context.close();
    }
  }
});
