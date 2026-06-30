# _publish_core — 多平台发布共享核心

被 `wechat-mp-publish` / `xiaohongshu-cards` / `zhihu-publish` 三个 skill 共用的底层。
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
  `validateTitle(title, platform)` → `{ok, title, warnings}`，platform ∈ `wechat`(≤64) / `xiaohongshu`(≤20) / `zhihu`(≤100)。
  CLI：`node title.mjs --title "..." --platform <p>`。
- 飞书通知 `notify_lark.cjs` 在 `../wechat-mp-publish/scripts/`（CC 专用 bot，**私聊**带按钮卡片；
  发布要人工那步给运营者发可点链接）。三平台脚本已接：公众号扫码 / 小红书发布 / 知乎发布。

## 取标题：每次发布前必做

别直接用 frontmatter 的平铺标题。流程见 `title-playbook.md`：
读完文章 → 按公式出 **3 个候选钩子标题** → 挑最吸引人的 1 个 →
`node _publish_core/title.mjs --title "..." --platform <平台>` 校验长度 → 用 `--title` 传给发布脚本。

## 统一 CLI（在 skills 根：`publish-cli.mjs`）

薄调度器：用 child_process 调各 skill 已有脚本，自身**不实现任何浏览器/渲染/发布逻辑**。**默认不真发**，只有显式 `--post` 才对外发布。

```bash
node publish-cli.mjs <platform> --file <md> [--post] [--title "..."] [--theme ..]
# platform: wechat | xiaohongshu | zhihu | all | wechat-send
node publish-cli.mjs --help
```

| platform | 不带 --post（默认） | 带 --post | 主要透传 |
|---|---|---|---|
| `wechat` | 渲染 md → 存公众号草稿 | web 直接发布 | `--title --theme --hl-theme --url --no-cover --digest --author`（`--url` 可代替 `--file`） |
| `wechat-send` | 只预览不执行（安全闸门） | 群发/发表已有草稿 | `--appmsgid <id>`、`--no-masssend`（仅发表不推送） |
| `xiaohongshu` | 生成卡片图 + 填发布页（不发） | 真发 | `--theme(literary\|blue) --title --out` |
| `zhihu` | 填标题+正文到草稿（不发） | 真发 | `--title --topic` |
| `all` | wechat 草稿 + 小红书/知乎填好不发 | 恒忽略 --post（永不真发） | `--title` 等 |

约定：默认全部「不真发」；`wechat-send` 底层运行即真发，故必须 `--post` 才执行；`all` 永远忽略 `--post`（要真发请逐平台单独执行）。输出汇总 JSON：每平台 `{ok, step, command, artifact/draft, nextStep}`；参数错误退出码 2、执行失败 1、成功 0。

```bash
# 不真发（联调/审核）
node publish-cli.mjs all --file post.md
node publish-cli.mjs wechat --file post.md --theme lapis
# 真发（逐平台、确认后）
node publish-cli.mjs zhihu --file post.md --post
node publish-cli.mjs wechat-send --appmsgid 100000123 --post --no-masssend
```
