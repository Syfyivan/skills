---
name: "zhihu-publish"
description: "把博客/Markdown 文章发布成知乎专栏文章。知乎没有官方发文 API，走网页自动化：Playwright 自带 Chromium + 持久登录态(扫一次码)，标题填进知乎标题框、正文用剪贴板把渲染后的 HTML 粘进知乎 Draft.js 编辑器(得到知乎原生排版)。默认只填不发(PREPARE)，--post 才真发布。"
---

# 知乎专栏文章发布

知乎专栏文章是**正文优先**的长文：一个标题(≤100 字) + 富文本正文(标题/加粗/列表/表格/链接/代码块)。本 skill 把一篇 Markdown 文章填进知乎写文章页并(可选)发布。**知乎无官方发文 API**，全程网页自动化。

## 发布前：取吸睛标题（必做）

照 `../_publish_core/title-playbook.md`（杨佳琦式钩子标题）出 3 个候选挑 1 个（知乎 ≤100 字，但前 20 字要抓人），校验：
`node ../_publish_core/title.mjs --title "..." --platform zhihu`，最终用 `--title` 传给 zhihu_publish。

## 两步

### 1) 登录(扫一次码，长期复用)

```bash
node scripts/zhihu_login.cjs   # 打开 zhuanlan.zhihu.com/write，手机知乎扫码登录(等 180s)
```

- 登录态持久化到 `scripts/.zhihu-browser`(Playwright persistentContext)，之后免扫。
- 成功后会把写文章页关键选择器 dump 到 `DIAG_OUT/zhihu_login.txt`，截图 `zhihu_write.png`。

### 2) 发布(默认只填不发)

```bash
# PREPARE：填好标题+正文，停在写文章页给人审核，不发布(安全默认)
node scripts/zhihu_publish.cjs --content-file /abs/article.md

# 真发布(对外不可撤，确认后再用)
node scripts/zhihu_publish.cjs --content-file /abs/article.md --post
# 可选： --title "自定义标题"   --topic "人工智能"(仅 --post 时尝试加话题)
```

- 取 frontmatter `title` 作标题(知乎可长，截到 100 字)；frontmatter 自动 strip，只发正文。
- 正文：用 `wechat-mp-publish/scripts/render_wenyan.mjs` 把正文 markdown 渲染成内联样式 HTML，再用剪贴板粘进知乎编辑器。
- 截图：`DIAG_OUT/zhihu_pub_ready.png`(填好待审)、`zhihu_pub_result.png`(--post 后)。

## 运行约定

- **浏览器**：Playwright **自带 Chromium**(非系统 Chrome，隔离)。可执行文件解析器扫 `[PLAYWRIGHT_BROWSERS_PATH, <repo>/.pw-browsers, ~/Library/Caches/ms-playwright]`，取第一个存在的 `chromium-*`。本机用仓库内 `.pw-browsers/chromium-1217`。
- **临时输出**：`DIAG_OUT=<scratchpad>` 控制截图/日志落点(默认脚本目录)。
- 脚本是 `.cjs`(`require('playwright/test')`)。需要浏览器/网络的命令在 Bash 里加 `dangerouslyDisableSandbox: true`；用 `run_in_background` 跑、读输出文件看结果。先 `node --check` 再跑。

## 写文章页结构(zhuanlan.zhihu.com/write)

| 元素 | 选择器 / 位置 | 说明 |
| --- | --- | --- |
| 标题 | `textarea.Input` | placeholder「请输入标题（最多 100 个字）」，≤100 字 |
| 正文编辑器 | `.public-DraftEditor-content` | **Draft.js** contenteditable(不是 ProseMirror) |
| 导入 | 工具栏「导入」按钮 | 下拉有「导入文档 MD/Doc」(file input accept `.md,.docx,.pdf…`)、「导入链接 公众号」 |
| 发布设置 | 底部左「发布设置 ▾」 | 内联展开面板：添加封面 / 投稿至问题 / 创作声明 / 文章话题 / 内容来源 |
| 发布 | 底部右蓝色「发布」 | 真实 DOM `<button>`，1440×900 时约 (1088, 874) |

## 实现要点 / 坑

- **正文进入方式 = 剪贴板粘贴 HTML(已实测，排版最好)**。流程：`ctx.grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://zhuanlan.zhihu.com'})` → 点 `.public-DraftEditor-content` → `navigator.clipboard.write([new ClipboardItem({'text/html':blob,'text/plain':blob})])` → `keyboard.press('Meta+v')`。Draft.js 的 paste handler 解析 HTML→自有 block：**标题/加粗/有序无序列表/表格/链接全部保留**，只丢内联样式(正好得到知乎原生排版)。加粗会变成 Draft 的 styled span(不是 `<strong>` 标签，但视觉是粗体)。
- **不要**直接改编辑器 innerHTML：Draft.js 内部维护 EditorState，直接改 DOM 不会同步进模型，提交时正文为空。必须走 paste 事件。
- **frontmatter**：`render_wenyan.mjs` 对本仓库这篇的 frontmatter 偶尔 strip 不掉(会把 YAML 当 setext 标题渲染)。所以发布脚本**自己先正则 strip frontmatter**，只把正文喂给渲染器(用 stdin)。
- **替代正文方案**(没用，留档)：① 工具栏「导入文档」可传 `.md` 文件(accept 含 `.md`)，但需先写一份 strip 掉 frontmatter 的临时 md，且解析保真度未验证；② Draft.js 底部显示「Markdown 语法输入中」，`keyboard.type` 打 markdown 能被部分自动转格式，但表格等不稳、且逐字慢。**优先剪贴板粘贴**。
- **发布按钮可自动**：底部蓝色「发布」是真实 `<button>`(出现在 `querySelectorAll('button')` 里)，Playwright `getByRole('button',{name:'发布',exact:true})` 能点到，不像小红书要靠坐标。脚本仍保留三级兜底：locator → 坐标点 (1088,874) → 保持窗口人工点(poll url 变 `zhuanlan.zhihu.com/p/<id>` 或出现「发布成功」)。
- **话题可能必填**：点「发布」后知乎常要求至少一个话题。`--topic` 会尝试展开发布设置 → 添加话题 → 选第一个候选；不稳时回退到「保持窗口人工完成」。
- **PREPARE 是默认**：不传 `--post` 只填不发，停在页面给人审核(知乎自动存草稿)。发布是对外不可撤动作，务必人工确认后再 `--post`。
- **内容硬要求**：正文里**不得出现“公众号”或任何跨平台引流**；「导入链接 公众号」也不要用。
- **登录态**：persistentContext 同一 `.zhihu-browser` profile 一次只能跑一个实例(Chromium 锁 profile)，别并发跑两个脚本。

## 也可用统一 CLI

`node ../publish-cli.mjs zhihu --file /abs/article.md --title "..."`（填好不发）；加 `--post` 真发。详见 `../_publish_core/README.md`。

## 何时调用

- “把这篇/这个系列发到知乎”“发知乎专栏”
- “知乎文章自动发布 / 填好待审”
- 已有 Markdown 博客文章要同步到知乎
