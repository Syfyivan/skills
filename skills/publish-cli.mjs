#!/usr/bin/env node
// publish-cli.mjs — 多平台发布「统一入口」(thin dispatcher)
//
// 设计原则：本文件只是个调度器(dispatcher)。它用 child_process 调用各 skill 里
// 已有的发布脚本，绝不重新实现任何浏览器自动化/渲染/发布逻辑。
// 默认不真发(不传 --post)，与各底层脚本的默认行为保持一致。
//
// Usage:
//   node publish-cli.mjs <platform> --file <md> [--post] [--title "..."] [--theme ..] [--help]
//   platform ∈ wechat | xiaohongshu | zhihu | csdn | juejin | all | wechat-send

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// CLI 所在目录即各 skill 的根；底层脚本路径都相对它解析。
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

const SCRIPTS = {
  wechat: path.join(CLI_DIR, 'wechat-mp-publish', 'scripts', 'publish_wechat_mp.py'),
  wechatSend: path.join(CLI_DIR, 'wechat-mp-publish', 'scripts', 'do_publish.cjs'),
  xhsGen: path.join(CLI_DIR, 'xiaohongshu-cards', 'scripts', 'gen_cards.mjs'),
  zhihu: path.join(CLI_DIR, 'zhihu-publish', 'scripts', 'zhihu_publish.cjs'),
  csdn: path.join(CLI_DIR, 'csdn-publish', 'scripts', 'csdn_publish.cjs'),
  juejin: path.join(CLI_DIR, 'juejin-publish', 'scripts', 'juejin_publish.cjs'),
};

const PLATFORMS = ['wechat', 'xiaohongshu', 'zhihu', 'csdn', 'juejin', 'all', 'wechat-send'];

// Flags that take a value vs. boolean switches.
const VALUE_FLAGS = new Set([
  'file', 'title', 'theme', 'hl-theme', 'url', 'digest', 'cover-prompt', 'author',
  'content-source-url', 'user-data-dir', 'appmsgid', 'topic', 'out',
  'tags', 'column', 'summary', 'category',
]);
const BOOL_FLAGS = new Set(['post', 'no-cover', 'reflow', 'no-masssend']);

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {};
  let platform = null;
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) { opts[key] = true; continue; }
      if (VALUE_FLAGS.has(key)) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) { errors.push(`选项 --${key} 需要一个值`); continue; }
        opts[key] = v; i += 1; continue;
      }
      errors.push(`未知选项：--${key}`);
      continue;
    }
    if (a.startsWith('-') && a !== '-') { errors.push(`未知选项：${a}`); continue; }
    if (platform === null) platform = a;
    else errors.push(`多余的参数：${a}`);
  }
  return { platform, opts, errors };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function fail(msg) {
  process.stderr.write('错误：' + msg + '\n运行 `node publish-cli.mjs --help` 查看用法。\n');
  process.exit(2);
}

// Pretty-print a command for the summary (quote args containing spaces).
const showCmd = (cmd, args) => [cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

// Run a child process.
// capture=true -> capture stdout (for JSON parsing) while streaming stderr live.
// capture=false -> inherit all stdio for live output (browser automation progress).
function run(cmd, args, { env, capture } = {}) {
  return spawnSync(cmd, args, {
    cwd: CLI_DIR,
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });
}

// Best-effort: read the final RESULT line a script wrote to its diag log.
function readResultLog(logPath) {
  try {
    const lines = fs.readFileSync(logPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    const result = [...lines].reverse().find((l) => /^RESULT:/.test(l));
    if (result) return result;
    const sig = [...lines].reverse().find((l) => /NOT LOGGED IN|FATAL|ERROR/i.test(l));
    return sig || null;
  } catch {
    return null;
  }
}

function spawnNote(res) {
  if (res.error) return `进程启动失败：${res.error.code || res.error.message}`;
  return null;
}

// ---------------------------------------------------------------------------
// platform handlers — each returns a result object for the summary
// ---------------------------------------------------------------------------

// 公众号：渲染 markdown -> 存草稿(web 模式，默认)。--post 时改为 --action publish(web 直接发布)。
function runWechat(opts, { withinAll = false } = {}) {
  // Source: standalone 可用 --url 代替 --file；all 内固定用 --file。
  const source = !withinAll && opts.url
    ? ['--url', opts.url]
    : ['--content-file', path.resolve(opts.file)];
  const args = [SCRIPTS.wechat, ...source];
  if (opts.title) args.push('--title', opts.title);
  if (opts.theme) args.push('--theme', opts.theme);
  if (opts['hl-theme']) args.push('--hl-theme', opts['hl-theme']);
  if (opts.digest) args.push('--digest', opts.digest);
  if (opts['cover-prompt']) args.push('--cover-prompt', opts['cover-prompt']);
  if (opts.author) args.push('--author', opts.author);
  if (opts['content-source-url']) args.push('--content-source-url', opts['content-source-url']);
  if (opts['user-data-dir']) args.push('--user-data-dir', opts['user-data-dir']);
  if (opts['no-cover']) args.push('--no-cover');
  if (opts.reflow) args.push('--reflow');

  const post = opts.post && !withinAll;
  if (post) args.push('--action', 'publish'); // 真发(web 直接发布)；默认不传 = 存草稿
  const step = post ? 'WEB_PUBLISH' : 'DRAFT';

  const res = run('python3', args, { capture: false });
  const ok = !res.error && res.status === 0;
  return {
    platform: 'wechat',
    ok,
    step,
    command: showCmd('python3', args),
    exitCode: res.status,
    artifact: null, // 草稿落在公众号后台，本地无路径
    draft: null,
    note: spawnNote(res),
    nextStep: post
      ? '已尝试 web 直接发布(以浏览器自动化结果为准)。'
      : '草稿已存入公众号后台(需登录态)。核对无误后用 `node publish-cli.mjs wechat-send --appmsgid <草稿appmsgid> --post` 群发(加 --no-masssend 仅发表不推送)。',
  };
}

// 公众号群发：调 do_publish.cjs 把「已有草稿」群发/发表。
// do_publish.cjs 没有 dry 模式(运行即真发)，故用 --post 作为安全闸门：不传 --post 只预览不执行。
function runWechatSend(opts) {
  const env = {};
  if (opts.appmsgid) env.APPMSGID = String(opts.appmsgid);
  if (opts['no-masssend']) env.WECHAT_MP_NO_MASSSEND = '1';
  const args = [SCRIPTS.wechatSend];
  const envDesc = [
    opts.appmsgid ? `APPMSGID=${opts.appmsgid}` : null,
    opts['no-masssend'] ? 'WECHAT_MP_NO_MASSSEND=1' : null,
  ].filter(Boolean).join(' ');
  const command = (envDesc ? envDesc + ' ' : '') + showCmd('node', args);

  if (!opts.post) {
    return {
      platform: 'wechat-send',
      ok: true,
      step: 'DRY_PREVIEW',
      command,
      exitCode: null,
      artifact: null,
      draft: null,
      note: '未传 --post：群发/发表是真发操作，已跳过执行，未对外发布。',
      nextStep: '确认草稿 appmsgid 后加 --post 执行：node publish-cli.mjs wechat-send --appmsgid <id> --post [--no-masssend]',
    };
  }

  const res = run('node', args, { env, capture: false });
  const ok = !res.error && res.status === 0;
  return {
    platform: 'wechat-send',
    ok,
    step: opts['no-masssend'] ? 'PUBLISH_NO_PUSH' : 'MASS_SEND',
    command,
    exitCode: res.status,
    artifact: null,
    draft: null,
    note: spawnNote(res) || readResultLog(path.join(path.dirname(SCRIPTS.wechatSend), 'do_publish.txt')),
    nextStep: '以 do_publish 日志/截图为准；若需扫码请在弹出的浏览器中完成。',
  };
}

// 小红书：只生成本地卡片图。不要用浏览器自动登录/上传/发布，避免账号风控预警。
function runXiaohongshu(opts, { withinAll = false } = {}) {
  const file = path.resolve(opts.file);
  const cardsDir = opts.out ? path.resolve(opts.out) : path.join(path.dirname(file), 'xhs-cards');

  // step 1: 生成卡片图
  const genArgs = [SCRIPTS.xhsGen, '--content-file', file, '--out', cardsDir];
  if (opts.title) genArgs.push('--title', opts.title);
  if (opts.theme) genArgs.push('--theme', opts.theme);
  const gen = run('node', genArgs, { capture: true });

  let artifact = cardsDir;
  let cardsInfo = null;
  if (gen.stdout) {
    const raw = gen.stdout.trim();
    const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    cardsInfo = tryParse(raw) || tryParse((raw.match(/\{[\s\S]*\}/) || [])[0] || '');
    if (cardsInfo && cardsInfo.outDir) artifact = cardsInfo.outDir;
  }
  if (gen.error || gen.status !== 0) {
    return {
      platform: 'xiaohongshu',
      ok: false,
      step: 'GEN_CARDS',
      command: showCmd('node', genArgs),
      exitCode: gen.status,
      artifact: null,
      draft: null,
      note: spawnNote(gen) || '卡片生成失败(检查 markdown / playwright / marked 依赖)。',
      nextStep: '修复后重试。',
    };
  }
  if (cardsInfo) process.stderr.write(`[xiaohongshu] 已生成 ${cardsInfo.cards} 张卡片 -> ${artifact}\n`);

  const post = opts.post && !withinAll;
  return {
    platform: 'xiaohongshu',
    ok: !post,
    step: post ? 'GEN_CARDS_ONLY_POST_BLOCKED' : 'GEN_CARDS_ONLY',
    command: showCmd('node', genArgs),
    exitCode: post ? 3 : 0,
    artifact, // 卡片图目录
    draft: null,
    note: post
      ? '小红书账号已出现第三方工具/脚本预警，已阻止自动上传/发布。'
      : '小红书卡片图已本地生成；请用官方 App/网页手动上传发布。',
    nextStep: post
      ? `卡片图在 ${artifact}。为避免账号继续预警，请人工打开小红书官方发布入口上传这些图片并粘贴文案。`
      : `卡片图在 ${artifact}。请人工打开小红书官方发布入口上传这些图片并粘贴标题/正文/标签。`,
  };
}

// 知乎：填标题+正文到草稿编辑器(PREPARE)；--post 才真发，all 内强制不发。
function runZhihu(opts, { withinAll = false } = {}) {
  const file = path.resolve(opts.file);
  const post = opts.post && !withinAll;
  const args = [SCRIPTS.zhihu, '--content-file', file];
  if (opts.title) args.push('--title', opts.title);
  if (opts.topic) args.push('--topic', opts.topic);
  if (post) args.push('--post');

  const res = run('node', args, { capture: false });
  const notLogged = res.status === 2; // zhihu_publish.cjs 未登录时 exit 2
  const ok = !res.error && res.status === 0;
  return {
    platform: 'zhihu',
    ok,
    step: post ? 'POST' : 'PREPARE',
    command: showCmd('node', args),
    exitCode: res.status,
    artifact: null,
    draft: null,
    note: spawnNote(res)
      || (notLogged ? '知乎未登录(exit 2)。' : readResultLog(path.join(path.dirname(SCRIPTS.zhihu), 'zhihu_publish.txt'))),
    nextStep: notLogged
      ? `先扫码登录：node ${SCRIPTS.zhihu.replace('zhihu_publish.cjs', 'zhihu_login.cjs')}，再重试。`
      : (post
        ? '已尝试发布(以 zhihu_publish 日志为准)。'
        : '标题+正文已填入知乎草稿(需登录态)。审核后真发：node publish-cli.mjs zhihu --file <md> --post'),
  };
}

// CSDN：填标题 + 灌 raw markdown 到 cledit 编辑器(PREPARE)；--post 才真发，all 内强制不发。
function runCsdn(opts, { withinAll = false } = {}) {
  const file = path.resolve(opts.file);
  const post = opts.post && !withinAll;
  const args = [SCRIPTS.csdn, '--content-file', file];
  if (opts.title) args.push('--title', opts.title);
  if (opts.tags) args.push('--tags', opts.tags);
  if (opts.column) args.push('--column', opts.column);
  if (opts.summary) args.push('--summary', opts.summary);
  if (post) args.push('--post');

  const res = run('node', args, { capture: false });
  const notLogged = res.status === 2; // csdn_publish.cjs 未登录时 exit 2
  const ok = !res.error && res.status === 0;
  return {
    platform: 'csdn',
    ok,
    step: post ? 'POST' : 'PREPARE',
    command: showCmd('node', args),
    exitCode: res.status,
    artifact: null,
    draft: null,
    note: spawnNote(res)
      || (notLogged ? 'CSDN 未登录(exit 2)。' : readResultLog(path.join(path.dirname(SCRIPTS.csdn), 'csdn_publish.txt'))),
    nextStep: notLogged
      ? `先扫码登录：node ${SCRIPTS.csdn.replace('csdn_publish.cjs', 'csdn_login.cjs')}，再重试。`
      : (post
        ? '已尝试发布(以 csdn_publish 日志为准)。'
        : '标题+正文已填入 CSDN 编辑器(需登录态)。审核后真发：node publish-cli.mjs csdn --file <md> --post'),
  };
}

// 掘金：填标题 + 灌 markdown 到 CodeMirror(PREPARE)；--post 才真发，all 内强制不发。
function runJuejin(opts, { withinAll = false } = {}) {
  const file = path.resolve(opts.file);
  const post = opts.post && !withinAll;
  const args = [SCRIPTS.juejin, '--content-file', file];
  if (opts.title) args.push('--title', opts.title);
  if (opts.category) args.push('--category', opts.category);
  if (opts.tags) args.push('--tags', opts.tags);
  if (opts.summary) args.push('--summary', opts.summary);
  if (opts.column) args.push('--column', opts.column);
  if (post) args.push('--post');

  const res = run('node', args, { capture: false });
  const notLogged = res.status === 2; // juejin_publish.cjs 未登录时 exit 2
  const ok = !res.error && res.status === 0;
  return {
    platform: 'juejin',
    ok,
    step: post ? 'POST' : 'PREPARE',
    command: showCmd('node', args),
    exitCode: res.status,
    artifact: null,
    draft: null,
    note: spawnNote(res)
      || (notLogged ? '掘金未登录(exit 2)。' : readResultLog(path.join(path.dirname(SCRIPTS.juejin), 'juejin_publish.txt'))),
    nextStep: notLogged
      ? `先扫码登录：node ${SCRIPTS.juejin.replace('juejin_publish.cjs', 'juejin_login.cjs')}，再重试。`
      : (post
        ? '已尝试发布(以 juejin_publish 日志为准)。'
        : '标题+正文已填入掘金草稿(需登录态)。审核后真发：node publish-cli.mjs juejin --file <md> --post'),
  };
}

// all：依次 wechat(草稿)、xiaohongshu(本地卡片)、zhihu/csdn/juejin(填好不发)。为安全起见忽略 --post。
function runAll(opts) {
  return [
    runWechat(opts, { withinAll: true }),
    runXiaohongshu(opts, { withinAll: true }),
    runZhihu(opts, { withinAll: true }),
    runCsdn(opts, { withinAll: true }),
    runJuejin(opts, { withinAll: true }),
  ];
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
function printHelp() {
  process.stdout.write(`多平台发布统一入口 (thin dispatcher)

用法:
  node publish-cli.mjs <platform> --file <md> [选项]

platform:
  wechat        公众号：渲染 markdown -> 存草稿(默认)；--post 改为 web 直接发布
  wechat-send   公众号群发：把已有草稿群发/发表(真发，需 --post 才执行)
  xiaohongshu   小红书：只生成本地卡片图；不再自动打开/上传/发布，避免账号风控
  zhihu         知乎：填标题+正文到草稿(默认不发)；--post 才真发
  csdn          CSDN：填标题+正文到编辑器(默认不发)；--post 才真发
  juejin        掘金：填标题+正文到草稿(默认不发)；--post 才真发
  all           依次跑 wechat(草稿)+小红书本地卡片+知乎/csdn/掘金(均不真发)，强制不真发

通用选项:
  --file <md>            文章 markdown 路径(wechat/xiaohongshu/zhihu/all 必填)
  --title "..."          自定义标题(透传给对应脚本)
  --post                 真发开关。默认不传 = 不真发(草稿/预览)；小红书会阻止 --post
  --help, -h             显示本帮助

按平台透传的选项:
  wechat:       --theme --hl-theme --url --no-cover --digest --cover-prompt --author
                --content-source-url --reflow --user-data-dir
                (--url 可代替 --file 抓网页正文；二者互斥)
  wechat-send:  --appmsgid <id>   设到 env APPMSGID(指定要群发的草稿)
                --no-masssend     设 env WECHAT_MP_NO_MASSSEND=1(仅发表不推送)
  xiaohongshu:  --theme(literary|blue) --out <卡片输出目录>
  zhihu:        --topic <话题>(仅 --post 时尝试添加)
  csdn:         --tags a,b,c  --column "分类专栏"  --summary "摘要"
  juejin:       --category "分类"  --tags 单个标签  --column "专栏"  --summary "50-100 字摘要"

示例(均不真发):
  node publish-cli.mjs wechat --file post.md --theme lapis --cover-prompt "故事高光画面..." --digest "摘要高光句..."
  node publish-cli.mjs xiaohongshu --file post.md
  node publish-cli.mjs zhihu --file post.md
  node publish-cli.mjs all --file post.md
真发示例:
  node publish-cli.mjs zhihu --file post.md --post
  node publish-cli.mjs wechat-send --appmsgid 100000123 --post --no-masssend

输出: 一段汇总 JSON，含每个平台的 {ok, step, artifact/draft, nextStep}。
`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function checkScripts(platform) {
  const need = {
    wechat: [SCRIPTS.wechat],
    'wechat-send': [SCRIPTS.wechatSend],
    xiaohongshu: [SCRIPTS.xhsGen],
    zhihu: [SCRIPTS.zhihu],
    csdn: [SCRIPTS.csdn],
    juejin: [SCRIPTS.juejin],
    all: [SCRIPTS.wechat, SCRIPTS.xhsGen, SCRIPTS.zhihu, SCRIPTS.csdn, SCRIPTS.juejin],
  }[platform] || [];
  for (const s of need) if (!fs.existsSync(s)) fail(`找不到发布脚本：${s}`);
}

function main() {
  const argv = process.argv.slice(2);
  const { platform, opts, errors } = parseArgs(argv);

  if (opts.help || argv.length === 0) { printHelp(); process.exit(opts.help ? 0 : 1); }
  if (errors.length) fail(errors.join('\n'));
  if (!platform) fail('缺少平台参数。');
  if (!PLATFORMS.includes(platform)) fail(`未知平台：${platform}。可选：${PLATFORMS.join(' | ')}`);

  // --file 校验(按平台)
  if (platform === 'wechat') {
    if (opts.file && opts.url) fail('wechat：--file 与 --url 互斥，二选一。');
    if (!opts.file && !opts.url) fail('wechat 需要 --file <md> 或 --url <网页链接>。');
    if (opts.file && !fs.existsSync(path.resolve(opts.file))) fail(`文件不存在：${opts.file}`);
  } else if (['xiaohongshu', 'zhihu', 'csdn', 'juejin', 'all'].includes(platform)) {
    if (!opts.file) fail(`平台 ${platform} 需要 --file <md>。`);
    if (!fs.existsSync(path.resolve(opts.file))) fail(`文件不存在：${opts.file}`);
  }

  checkScripts(platform);

  let results;
  if (platform === 'all') results = runAll(opts);
  else if (platform === 'wechat') results = [runWechat(opts)];
  else if (platform === 'wechat-send') results = [runWechatSend(opts)];
  else if (platform === 'xiaohongshu') results = [runXiaohongshu(opts)];
  else if (platform === 'zhihu') results = [runZhihu(opts)];
  else if (platform === 'csdn') results = [runCsdn(opts)];
  else results = [runJuejin(opts)];

  const summary = {
    platform,
    post: !!opts.post,
    dryRun: !opts.post,
    ok: results.every((r) => r.ok),
    results,
  };
  if (platform === 'all' && opts.post) {
    summary.note = 'all 模式为安全起见已忽略 --post(各平台均未真发)。如需真发，请对单个平台单独执行。';
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(summary.ok ? 0 : 1);
}

main();
