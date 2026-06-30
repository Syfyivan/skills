#!/usr/bin/env node
// CC 专用飞书机器人通知（隔离：独立 app + tenant token，curl 走代理，绝不碰 lark-cli 配置）。
// 默认【私聊 p2p】发给运营者；文本里含链接时，自动发「带按钮的交互卡片」，链接一点即开。
//
// 用法:
//   node notify_lark.cjs "文本（含 https://链接 会被自动抽出来做成按钮）"
//   node notify_lark.cjs "文本" --url https://... --title "标题"
// 配置（均有默认）:
//   CC_LARK_APP_ID       默认 cli_a90a2f201b799bc9（CC 专用 bot，与 Codex 桥接 app 隔离）
//   CC_LARK_SECRET_FILE  默认 ~/.cc-lark-secret（app_secret，600，不入库）
//   CC_LARK_OPENID       默认运营者在该 app 下的 open_id（私聊）
//   CC_LARK_CHAT_ID      一般不设；设了才发群（默认私聊，用户要求以后都私聊）

const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const APP_ID = process.env.CC_LARK_APP_ID || 'cli_a90a2f201b799bc9';
const SECRET_FILE = process.env.CC_LARK_SECRET_FILE || `${os.homedir()}/.cc-lark-secret`;
const OPENID = process.env.CC_LARK_OPENID || 'ou_b2a283594a2025ce338c19866a3f3840';
const CHAT_ID = process.env.CC_LARK_CHAT_ID || '';

// ---- 解析参数：剩余位置参数拼成正文，--url / --title 可选 ----
const argv = process.argv.slice(2);
let urlFlag = '';
let titleFlag = '';
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--url') urlFlag = argv[++i] || '';
  else if (argv[i] === '--title') titleFlag = argv[++i] || '';
  else rest.push(argv[i]);
}
const text = rest.join(' ').trim() || '(empty)';
const urlMatch = text.match(/https?:\/\/[^\s)）」】]+/);
const url = (urlFlag || (urlMatch ? urlMatch[0] : '')).trim();
const title = titleFlag || 'Claude Code 发布提醒';

function curlPost(u, headers, body) {
  const args = ['-s', '-m', '20', '-X', 'POST', u];
  for (const h of headers) args.push('-H', h);
  args.push('-d', body);
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 20 });
}

function main() {
  const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const tokResp = curlPost(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    ['Content-Type: application/json'],
    JSON.stringify({ app_id: APP_ID, app_secret: secret }),
  );
  const tt = JSON.parse(tokResp).tenant_access_token;
  if (!tt) { console.error('no token:', tokResp); process.exit(1); }

  const idType = CHAT_ID ? 'chat_id' : 'open_id';
  const receiveId = CHAT_ID || OPENID;

  let msgType;
  let content;
  if (url) {
    // 交互卡片：正文 + 大按钮「打开页面」+ note 里附明文链接（按钮万一不灵也能复制）。
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: title } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: text } },
        { tag: 'hr' },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🚀 打开页面去发布' }, type: 'primary', url }] },
        { tag: 'note', elements: [{ tag: 'plain_text', content: url }] },
      ],
    };
    msgType = 'interactive';
    content = JSON.stringify(card);
  } else {
    msgType = 'text';
    content = JSON.stringify({ text });
  }

  const body = JSON.stringify({ receive_id: receiveId, msg_type: msgType, content });
  const resp = curlPost(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${idType}`,
    ['Content-Type: application/json', `Authorization: Bearer ${tt}`],
    body,
  );
  const r = JSON.parse(resp);
  if (r.code === 0) {
    console.log('sent', msgType, r.data && r.data.message_id);
  } else {
    console.error('FAIL', resp);
    process.exit(1);
  }
}

main();
