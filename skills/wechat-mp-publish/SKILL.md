---
name: "wechat-mp-publish"
description: "把 Markdown / 博客文章一键排版并发布到微信公众号：wenyan-core 多主题美化排版、按系列自动选主题、AI 生成封面、支持传链接/传 md/飞书文档；发表走浏览器自动化（个人/未认证号无 API 权限），最后一道微信验证扫码需真人。"
---

# 微信公众号自动发布

把一篇 Markdown（或博客链接 / 飞书文档）变成排版精致的公众号图文并发布。除了腾讯强制的「微信验证扫码」那一下，其余全自动。

## 能做什么

1. Markdown → 公众号内联样式 HTML（**wenyan-core**，多主题 + 代码高亮，样式全内联，公众号编辑器不会丢样式）
2. **按系列自动选主题**（读文章 frontmatter `categories/title/tags`，见 `scripts/series_theme.json`）
3. **AI 封面**：调用公众号后台「AI 配图」按提示词生成并设为封面
4. 多种输入：`.md` / 纯文本 / `.html` / **博客链接 `--url`** / **飞书文档 `--doc-url`**
5. 草稿 / 发表（群发）；发表默认**群发优先，失败回退仅发表**

## 现实约束（重要）

- **个人主体 / 未认证号自 2025-07 起无发布 API 权限**，所以走**浏览器自动化**（Playwright），不是 API。
- **网页端发表每次都要过一道「微信验证」扫码**（管理员/运营者本人用微信扫，脚本绕不过）。脚本会自动走到二维码并保持窗口，等你**屏幕扫码**（默认 180s）。若已配飞书 bot，可改为把二维码发飞书、手机扫（见下）。
- 浏览器用 **Playwright 自带 Chromium**（与用户日常 Chrome 隔离），登录态存在持久化 profile，扫一次码后长期复用。

## 环境与依赖

- Node + 仓库依赖：`@wenyan-md/core`、`jsdom`、`@mozilla/readability`、`turndown`（装在 skills 仓库根；scoped 包用 `--registry https://registry.npmjs.org`）。
- **Chromium 装在仓库内 `.pw-browsers/`**（不在 `~/Library/Caches` 下，避免被缓存清理删掉）。缺失时重装：
  `PLAYWRIGHT_BROWSERS_PATH=<repo>/.pw-browsers node_modules/.bin/playwright install chromium`
- 登录 profile：`scripts/.wechat-mp-browser`（默认；可用 `WECHAT_MP_USER_DATA_DIR` 覆盖）。

## 发布前：取吸睛标题（必做）

别直接用 frontmatter 的平铺标题。照 `../_publish_core/title-playbook.md`（B 站杨佳琦式钩子标题）：读完文章 → 出 **3 个候选**（短句切分、1-2 个问号 + 1 个感叹号、痛点/悬念开场、不剧透结局）→ 挑最吸引人的 1 个 → 校验：
```bash
node ../_publish_core/title.mjs --title "你选的标题" --platform wechat
```
`ok=true` 直接用；`ok=false`（被截断/超长）重写更短的钩子；`warnings` 提示加问号/感叹号时酌情补。最终标题用 `--title "..."` 传给下面的发布脚本。

## 发布前：封面 prompt + 摘要高光句（必做）

每次发布都必须从正文里单独提炼这两段，不能让脚本默认从开头截取：

- **封面 prompt**：用故事梗概或高光时刻描述画面，优先写主角、场景、冲突、情绪和视觉风格；明确排除无关截图、网页 UI、随机文字。长度尽量控制在 120 字内，用 `--cover-prompt "..."` 传入。
- **摘要高光句**：不是 frontmatter description，也不是正文第一段截断；要写成公众号列表里能抓人的一句话，点出冲突/悬念/收益但不剧透，控制在 120 字内，用 `--digest "..."` 传入。

示例：
```bash
--cover-prompt "温暖寓言插画，不要文字和网页截图：秋收谷仓里，学徒阿禾面对旧谷筐和陌生山外新谷，老把式在旁指点；突出训练、泛化与过拟合。"
--digest "旧谷筐都分对了，山外新谷一来就露馅。机器学习真正要学会的，不是背答案，而是遇到新题也能判断。"
```

## 也可用统一 CLI（一条命令发本平台）

```bash
node ../publish-cli.mjs wechat --file /abs/article.md --title "..." --cover-prompt "..." --digest "..." [--theme lapis]   # 存草稿
node ../publish-cli.mjs wechat --file /abs/article.md --post --title "..." --cover-prompt "..." --digest "..."             # 发布
node ../publish-cli.mjs wechat-send --appmsgid <草稿id> --post [--no-masssend]        # 群发/仅发表已有草稿
```
详见 `../_publish_core/README.md`。

## 常用命令

存草稿（自动按系列选主题；封面 prompt 和摘要高光句必须显式传入）：
```bash
python3 scripts/publish_wechat_mp.py --publish-mode web --action draft \
  --content-file /abs/path/article.md \
  --title "..." \
  --cover-prompt "..." \
  --digest "..."
```

发表（群发优先，失败回退仅发表；到二维码请屏幕扫码）：
```bash
python3 scripts/publish_wechat_mp.py --publish-mode web --action publish \
  --content-file /abs/path/article.md \
  --title "..." \
  --cover-prompt "..." \
  --digest "..."
```

传博客链接 / 仅发表不推送 / 指定主题 / 不动封面：
```bash
# 抓网页正文转 md 再发
python3 scripts/publish_wechat_mp.py --publish-mode web --action draft --url https://blog.example.com/post
# 指定主题 + 跳过封面（只更新正文/样式）
python3 scripts/publish_wechat_mp.py --publish-mode web --action draft --content-file a.md --theme lapis --no-cover
# 列出可用主题
python3 scripts/publish_wechat_mp.py --list-themes
```

## 入参（节选）

- `--content` / `--content-file` / `--doc-url` / `--url`：四选一的正文来源
- `--content-format`：`auto|markdown|html|text|pdf`（默认 auto）
- `--reflow`：HTML 输入先经 readability+turndown 转 md 再套主题
- `--theme` / `--hl-theme`：公众号主题 / 代码高亮主题（不传则按系列映射，再默认）
- `--list-themes`：列出主题后退出
- `--no-cover`：跳过 AI 封面（`WECHAT_MP_SKIP_COVER=1` 同义）
- `--action`：`draft`（默认）/ `publish`
- `--digest`：摘要（不传则取 frontmatter `description`，再退为正文截取）
- `--author`：作者（默认 `繁漪`）
- `--browser-channel`：留空=自带 Chromium（推荐，隔离）；可设 `chrome`

## 主题系统

- 内置（wenyan-core）：`default / orangeheart / rainbow / lapis / pie / maize / purple / phycat`；高亮 `github / atom-one-dark / dracula / monokai / solarized-* / xcode` 等。
- 自定义主题：把 CSS 放 `scripts/themes/<id>.css`（选择器挂 `#wenyan`，`var()` 会被解析成字面值内联）。已内置 `literary.css`（文学风，红/蓝/绿取自博客课程页）。**勿用 `::before` 伪元素做装饰**——粘进公众号 ProseMirror 会跳行。
- 系列→主题：`scripts/series_theme.json`（`match` 命中 frontmatter 即用对应主题；`--theme` 优先级最高）。

## 发表 / 群发流程（脚本如何做）

`#js_send` 打开发表弹窗 → 弹窗1（群发通知开关 + 发表）→ 弹窗2（「已开启群发通知…继续发表」）→「微信验证」二维码 → **真人扫** → 页面跳 `home` = 成功。
- 默认群发（群发通知开）；失败/扫码超时**回退仅发表不推送**（`WECHAT_MP_NO_MASSSEND=1` 关群发通知）。
- 群发不可撤回、订阅号每天 1 次；确认后再发。

## 飞书二维码中转（可选，待开通 bot）

发表到二维码那步，可把二维码发到运营者飞书、手机扫。前提：给应用开**机器人(bot)能力**并具 `im:message`/图片权限（app secret 已配，`lark-cli config show` 可见）。开通前用屏幕扫码即可。

## 实施约束

- 不打印 token / secret / cookie。
- 只创建草稿/发表当前文章，不删历史草稿。
- 不把 Markdown 原样塞接口；必须经渲染。
- 发表那道微信验证扫码必须真人完成，不可绕过。
