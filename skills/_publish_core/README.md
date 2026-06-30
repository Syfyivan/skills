# _publish_core — 多平台发布共享核心

被 `wechat-mp-publish` / `xiaohongshu-cards` / `zhihu-publish` / `csdn-publish` / `juejin-publish` 共用的底层。
设计：**skill 当大脑**（AI 编排：取标题、选主题、判断群发/扫码、回退、发飞书），**core + CLI 当手**（确定性脚本，可被 skill 调，也能脱离 AI 手动/cron 跑）。

## 模块

- `chromium.cjs` / `chromium.mjs` —— 解析 Playwright 自带 Chromium 可执行文件，扫
  `[PLAYWRIGHT_BROWSERS_PATH, <repo>/.pw-browsers, ~/Library/Caches/ms-playwright]`
  取第一个存在的 `chromium-*`（本机 = 仓库内 `.pw-browsers/chromium-1217`，避开系统 Chrome、避开缓存清理）。
  CJS：`const { resolveChromium } = require('../../_publish_core/chromium.cjs')`；
  ESM：`import { resolveChromium } from '../../_publish_core/chromium.mjs'`。
  **各发布脚本已统一引用它，不要再各自内联 `exe()`/`resolveChromium()`。**
- `title.mjs` + `title-playbook.md` —— 发布前取「吸睛标题」。playbook 是给 Claude 读的取标题公式
  （B 站「学过石油的语文老师」杨佳琦式钩子标题）；`title.mjs` 只做机械校验/截断，不负责创意：
  `validateTitle(title, platform)` → `{ok, title, warnings}`，platform ∈ `wechat`(≤64) / `xiaohongshu`(≤20) / `zhihu`(≤100) / `csdn`(≤100) / `juejin`(≤100)。
  CLI：`node title.mjs --title "..." --platform <p>`。
- 飞书通知 `notify_lark.cjs` 在 `../wechat-mp-publish/scripts/`（CC 专用 bot，**私聊**带按钮卡片；
  发布要人工那步给运营者发可点链接）。三平台脚本已接：公众号扫码 / 小红书发布 / 知乎发布。

## 取标题：每次发布前必做

别直接用 frontmatter 的平铺标题。流程见 `title-playbook.md`：
读完文章 → 按公式出 **3 个候选钩子标题** → 挑最吸引人的 1 个 →
`node _publish_core/title.mjs --title "..." --platform <平台>` 校验长度 → 用 `--title` 传给发布脚本。

## 发布素材：每次发布前必须显式产出

不要让脚本从正文开头自动截一句来充当摘要、封面提示或小红书正文。AI 编排层必须先读完文章，再产出这组平台化素材：

| 素材 | 用途 | 规则 |
|---|---|---|
| 吸睛标题 | 所有平台 `--title` | 先出 3 个候选，再用 `title.mjs` 按平台校验 |
| 公众号封面 prompt | `wechat --cover-prompt` | 用故事梗概或高光时刻描述画面；包含主角、场景、冲突、情绪、风格；排除网页截图/UI/随机文字 |
| 公众号摘要高光句 | `wechat --digest` | 不是正文开头截断；写成列表里能抓人的一句，≤120 字 |
| 小红书 hook/body | `gen_cards --hook` / `xhs_publish --body` | 第一眼要有冲突或收益；禁止跨平台引流 |
| CSDN 摘要 | `csdn --summary` | 概括文章收益，避免平台引流 |
| 掘金分类/标签/摘要 | `juejin --category --tags --summary` | 分类必选；标签只传 1 个；摘要 50-100 字 |

## 统一 CLI（在 skills 根：`publish-cli.mjs`）

薄调度器：用 child_process 调各 skill 已有脚本，自身**不实现任何浏览器/渲染/发布逻辑**。**默认不真发**，只有显式 `--post` 才对外发布。

```bash
node publish-cli.mjs <platform> --file <md> [--post] [--title "..."] [--theme ..]
# platform: wechat | xiaohongshu | zhihu | csdn | juejin | all | wechat-send
node publish-cli.mjs --help
```

| platform | 不带 --post（默认） | 带 --post | 主要透传 |
|---|---|---|---|
| `wechat` | 渲染 md → 存公众号草稿 | web 直接发布 | `--title --theme --hl-theme --url --no-cover --digest --cover-prompt --author`（`--url` 可代替 `--file`） |
| `wechat-send` | 只预览不执行（安全闸门） | 群发/发表已有草稿 | `--appmsgid <id>`、`--no-masssend`（仅发表不推送） |
| `xiaohongshu` | 生成卡片图 + 填发布页（不发） | 真发 | `--theme(literary\|blue) --title --out` |
| `zhihu` | 填标题+正文到草稿（不发） | 真发 | `--title --topic` |
| `csdn` | 填标题+正文到编辑器（不发） | 真发 | `--title --tags --column --summary` |
| `juejin` | 填标题+正文到草稿（不发） | 真发 | `--title --category --tags(单个) --summary(50-100字) --column` |
| `all` | wechat 草稿 + 小红书/知乎填好不发 | 恒忽略 --post（永不真发） | `--title` 等 |

约定：默认全部「不真发」；`wechat-send` 底层运行即真发，故必须 `--post` 才执行；`all` 永远忽略 `--post`（要真发请逐平台单独执行）。输出汇总 JSON：每平台 `{ok, step, command, artifact/draft, nextStep}`；参数错误退出码 2、执行失败 1、成功 0。

```bash
# 不真发（联调/审核）
node publish-cli.mjs all --file post.md
node publish-cli.mjs wechat --file post.md --theme lapis
# 真发（逐平台、确认后）
node publish-cli.mjs zhihu --file post.md --post
node publish-cli.mjs juejin --file post.md --post --category 人工智能 --tags 机器学习 --summary "50 到 100 字摘要..."
node publish-cli.mjs wechat-send --appmsgid 100000123 --post --no-masssend
```

## 调试原则：DOM/日志优先，截图只做视觉证据

发布脚本应优先用 DOM、URL、日志和平台返回状态判断流程；截图用于这些 DOM 难以证明的场景：二维码、AI 生成图、上传后的封面/卡片预览、遮罩/弹窗覆盖、窗口焦点跑到后台、按钮存在但实际不可点。不要只凭截图断言成功，最终以日志里的 `RESULT:`、URL 变化或平台成功页为准。

## 直接请求边界

“Mock 请求”不是 mock 本地数据，而是重放平台的真实认证请求。可以作为后续优化方向，但必须先捕获真实 endpoint、cookie、CSRF/token、签名参数、请求顺序和扫码后的状态机，并能从平台成功页/API 回读验证。未完成 API discovery 前，默认走网页自动化；不要伪造响应骗过本地脚本，也不要尝试绕过真人扫码/风控验证。

`request_trace.cjs` 可挂到发布脚本上记录最终发布阶段的真实请求/响应，输出 JSONL，敏感 header 和常见 token 参数会脱敏。CSDN/掘金 `--post` 已接入：

- `csdn-publish/scripts/csdn_publish_requests.jsonl`
- `juejin-publish/scripts/juejin_publish_requests.jsonl`

如果自动点击或人工点击触发了请求，先看这些抓包日志，再决定是否把稳定 endpoint 封装成 direct replay。不要在没有真实请求样本时硬编码接口。
