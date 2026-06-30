---
name: "csdn-publish"
description: "把博客/Markdown 文章发布成 CSDN 博客。CSDN 编辑器(editor.csdn.net/md)是 markdown 原生(cledit：左源码右预览)，所以直接把正文 markdown 灌进去即可——不需要 wenyan 渲染成 HTML。走网页自动化：Playwright 自带 Chromium + 持久登录态(扫一次码)，标题填进标题框、正文用剪贴板把 markdown 粘进 cledit 编辑器。默认只填不发(PREPARE)，--post 才打开「发布文章」面板真发布。"
---

# CSDN 博客发布

CSDN 写文章页是**markdown 原生编辑器**：一个标题输入框 + cledit 源码编辑器(左写 markdown、右实时预览) + 右上「发布文章」按钮。点「发布文章」弹出**发布面板**(分类专栏 / 文章标签 / 摘要 / 封面 / 文章类型(原创) / 可见范围) → 再点面板里的「发布文章」确认。本 skill 把一篇 Markdown 文章填进 CSDN 写文章页并(可选)发布。**CSDN 个人无官方发文 API**，全程网页自动化。

> 关键差异：CSDN 是 **markdown 原生**，正文**直接喂 markdown**(先 strip frontmatter)，**不要**像知乎那样先 wenyan 渲染成 HTML。

## 发布前：取吸睛标题（必做）

照 `../_publish_core/title-playbook.md`（杨佳琦式钩子标题）出 3 个候选挑 1 个，再机械校验长度：

```bash
node ../_publish_core/title.mjs --title "AI 满嘴跑火车？给它配个图书管理员！" --platform csdn
```

`ok=true` 直接用；`ok=false`(被截断/超长)重写更短的钩子。最终用 `--title` 传给 csdn_publish。

## 两步

### 1) 登录(扫一次码，长期复用)

```bash
node scripts/csdn_login.cjs   # 打开 editor.csdn.net/md/，CSDN App 扫码登录(等 180s)
```

- 登录态持久化到 `scripts/.csdn-browser`(Playwright persistentContext)，之后免扫。
- 成功后会把写文章页关键选择器 dump 到 `DIAG_OUT/csdn_login.txt`，截图 `csdn_write.png`。
- **首次登录后请按 dump 核对下表选择器**（CSDN 偶尔小改 class）。

### 2) 发布(默认只填不发)

```bash
# PREPARE：填好标题+正文，停在写文章页给人审核，不发布(安全默认)
node scripts/csdn_publish.cjs --content-file /abs/article.md

# 真发布(对外不可撤，确认后再用)：打开「发布文章」面板，尽力选专栏/填标签/摘要，点最终「发布文章」
node scripts/csdn_publish.cjs --content-file /abs/article.md --post \
  --tags "AI,Agent,大模型" --column "AI 寓言课" --summary "用一个寓言讲透检索增强"
```

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--content-file <abs.md>` | 是 | 文章 markdown 绝对路径 |
| `--title "..."` | 否 | 默认取 frontmatter `title`，按 100 字截断 |
| `--tags a,b,c` | 否 | 逗号分隔，best-effort，仅 `--post` 时填 |
| `--column "专栏名"` | 否 | 分类专栏名，best-effort，仅 `--post` 时勾 |
| `--summary "摘要"` | 否 | 文章摘要，best-effort，仅 `--post` 时填 |

- 取 frontmatter `title` 作标题；frontmatter 自动 strip，只发正文 markdown。
- 截图：`DIAG_OUT/csdn_pub_ready.png`(填好待审)、`csdn_pub_panel.png`(发布面板)、`csdn_pub_result.png`(--post 后)。

## 运行约定

- **浏览器**：Playwright **自带 Chromium**(非系统 Chrome，隔离)。可执行文件解析复用 `_publish_core/chromium.cjs`，扫 `[PLAYWRIGHT_BROWSERS_PATH, <repo>/.pw-browsers, ~/Library/Caches/ms-playwright]` 取第一个存在的 `chromium-*`。
- **临时输出**：`DIAG_OUT=<scratchpad>` 控制截图/日志落点(默认脚本目录)。
- **PREPARE 停留**：`CSDN_PREPARE_HOLD`(默认 300s)控制 PREPARE 后保持窗口给人审核的秒数；人工关掉窗口会提前退出。
- **登录态目录**：`CSDN_USER_DATA_DIR`(默认 `scripts/.csdn-browser`)。同一 profile 一次只能跑一个实例(Chromium 锁 profile)，别并发跑两个脚本。
- 脚本是 `.cjs`(`require('playwright/test')`)。需要浏览器/网络的命令在 Bash 里加 `dangerouslyDisableSandbox: true`；用 `run_in_background` 跑、读输出文件看结果。先 `node --check` 再跑。

## 写文章页结构(editor.csdn.net/md/)

> 选择器来自公开自动化工具核对，**标 ⚠ 的待首次真登录后用 `csdn_login.txt` dump 复核**。

| 元素 | 选择器 / 位置 | 说明 |
| --- | --- | --- |
| 标题 | `.article-bar__title-display` / `.article-bar__input-box`（先展示）→ 点击后出现 `input[placeholder*="请输入文章标题"], input.article-bar__title--input` | 新版 CSDN 标题不是一开始就是 input；需先点展示区再 fill；≤~100 字 |
| 正文编辑器 | `.editor`(容器) > `.cledit-section` | **cledit contenteditable**(markdown 源码)，非 textarea、非 CodeMirror |
| 发布(顶栏) | `button.btn-publish`，文案「发布文章」 | 点开发布面板(modal) |
| 文章标签 | `button.tag__btn-tag`「添加文章标签」→ `.mark_selection_box input[placeholder*="搜索"]` → 选候选/回车 → `button[title="关闭"]` | ⚠ best-effort |
| 分类专栏 | 面板内 `input[type="checkbox"]` + 同行专栏名文本 | ⚠ 按专栏名文本匹配后勾选 |
| 摘要 | 发布面板内 `textarea.el-textarea__inner`，placeholder 含「展现列表」「正文前256个字」 | 新版 DOM 实测；用 placeholder 语义匹配比 class 稳 |
| 封面 | `input[type="file"]` | ⚠ 当前脚本不传封面 |
| 文章类型 / 可见范围 | 面板内 radio | 默认「原创」「全部可见」，脚本**不改默认** |
| 发布(面板) | `.modal__button-bar button`，文案「发布文章」 | ⚠ 真实 DOM `<button>`，最终确认 |

## 实现要点 / 坑

- **正文 = 直接喂 markdown(剪贴板粘贴)**。CSDN 编辑器是 markdown 源码态，所以把**原始 markdown 文本**(text/plain)写进剪贴板 → 点 `.cledit-section` → `keyboard.press('Meta+v')`，右侧预览自动渲染。**不需要 wenyan/HTML 渲染**(那是知乎/公众号的做法)。
- **先清空再粘**：cledit 会恢复上次草稿/模板，灌正文前先 `Meta+a` → `Delete` 清空，避免叠加。
- **粘贴兜底**：剪贴板粘贴若没进(textLen 太小)，回退 `keyboard.insertText(body)`(单次 input 事件、瞬时、不触发逐字 markdown 自动格式化)。需要 `ctx.grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://editor.csdn.net'})`。
- **frontmatter**：脚本自己正则 strip frontmatter(`/^﻿?---\n[\s\S]*?\n---\n/`)，只把正文喂进编辑器；`title` 从 frontmatter 取。
- **「发布文章」有两个**：顶栏触发(`button.btn-publish`)和面板确认(`.modal__button-bar` 内)文案都是「发布文章」。脚本找**最终确认**时**限定在 modal 内**，别误点顶栏那个。
- **新版标题 DOM**：如果标题 input 不可见，不要直接判未登录；先看 `.article-bar__title-display`/`.article-bar__input-box` 和 markdown 编辑器是否存在，再点击标题展示区打开 input。
- **新版发布面板 DOM**：发布弹窗根节点常见为 `modal__inner-1 modal__publish-article`；摘要 textarea 是 `textarea.el-textarea__inner`，placeholder 文案为「本内容会在各展现列表中展示...若不填，则默认提取正文前256个字。」；最终按钮为 `button.btn-b-red` 文案「发布文章」。
- **三级兜底发布**：locator 点面板「发布文章」→ 坐标点(模板右下，坐标**近似、待核对**，`CSDN_COORD_CLICK=0` 可关)→ 都不行则 `notifyLark('【CSDN·待发布】...editor.csdn.net/md/')` 并保持窗口让人工点(轮询 ≤300s)。
- **判成功**：url 变文章详情 `blog.csdn.net/<user>/article/details/<id>`，或 `mp.csdn.net/.../success`，或页面出现「发布成功/发表成功」。
- **PREPARE 是默认**：不传 `--post` 只填不发，保持窗口给人审核(`CSDN_PREPARE_HOLD` 秒)。发布对外不可撤，务必人工确认后再 `--post`。
- **内容硬要求**：正文里**不得出现“公众号”或任何跨平台引流**。
- **标签/专栏 best-effort**：CSDN 标签是搜索+候选(可新建)，分类专栏需账号里已建好同名专栏；匹配不到不阻断发布，回退人工面板。

## 也可用统一 CLI（已接线）

```bash
node ../publish-cli.mjs csdn --file /abs/article.md --title "..." [--tags a,b] [--column "专栏"] [--summary "..."]   # 填好不发
node ../publish-cli.mjs csdn --file /abs/article.md --post ...                                                       # 真发
```

详见 `../_publish_core/README.md`。

## 待办

- ✅ 已给 `title.mjs` 加 `csdn: 100`、`publish-cli.mjs` 已接 `csdn` 子命令(透传 `--tags/--column/--summary`)。
- 首次真登录后，按 `csdn_login.txt` dump 复核上表 ⚠ 选择器与坐标兜底。

## 何时调用

- “把这篇/这个系列发到 CSDN”“发 CSDN 博客”
- “CSDN 文章自动发布 / 填好待审”
- 已有 Markdown 博客文章要同步到 CSDN
