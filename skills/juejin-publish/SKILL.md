---
name: "juejin-publish"
description: "把博客/Markdown 文章发布成稀土掘金(juejin.cn)文章。掘金编辑器是 markdown 原生(Bytemd/CodeMirror)，所以直接喂 markdown、无需 HTML 渲染。走网页自动化：Playwright 自带 Chromium + 持久登录态(扫一次码)，标题填进顶部标题框、正文灌进 CodeMirror，右上「发布」→ 抽屉里选分类(必选)/标签/摘要/专栏 →「确定并发布」。默认只填不发(PREPARE)，--post 才真发布。"
---

# 稀土掘金文章发布

掘金文章 = 一个标题 + 一段 **Markdown 正文**(编辑器是 ByteDance 自家的 **Bytemd**，底层 CodeMirror，左写右预览)。发布时弹出抽屉，**分类为必选**，标签按本 workflow **只传 1 个**，摘要必须 **50-100 字**，可选封面/专栏。本 skill 把一篇 Markdown 文章填进掘金写文章页并(可选)发布。**掘金无对外发文 API**，全程网页自动化。

> 与知乎/公众号的关键区别：**掘金编辑器吃 markdown 原生**，所以**不做 HTML 渲染**，frontmatter strip 掉后把正文 markdown 原样灌进 CodeMirror 即可。

## 发布前：取吸睛标题（必做）

照 `../_publish_core/title-playbook.md`（杨佳琦式钩子标题）出 3 个候选挑 1 个，前 20 字要抓人(掘金标题 ≤100 字)：
`node ../_publish_core/title.mjs --title "..." --platform juejin`，最终用 `--title` 传给 juejin_publish。

## 两步

### 1) 登录(扫一次码，长期复用)

```bash
node scripts/juejin_login.cjs   # 打开 juejin.cn/editor/drafts/new，手机掘金/微信扫码登录(等 180s)
```

- 登录态持久化到 `scripts/.juejin-browser`(Playwright persistentContext)，之后免扫。env `JUEJIN_USER_DATA_DIR` 可覆盖目录。
- 成功后把写文章页关键选择器 dump 到 `DIAG_OUT/juejin_login.txt`，截图 `juejin_write.png`；并**安全地**打开发布抽屉 dump 分类/标签/封面/摘要/专栏控件(只 dump 不发，dump 完按 Escape 关掉)，截图 `juejin_publish_drawer.png`。

### 2) 发布(默认只填不发)

```bash
# PREPARE：填好标题+正文，停在写文章页给人审核，不发布(安全默认)
node scripts/juejin_publish.cjs --content-file /abs/article.md

# 真发布(对外不可撤，确认后再用)
node scripts/juejin_publish.cjs --content-file /abs/article.md --post \
  --category "人工智能" --tags "机器学习" --summary "旧谷筐都分对了，山外新谷一来就露馅。这篇用农场寓言讲清数据、标签、训练、推理、泛化和过拟合，适合零基础读者快速建立直觉。" --column "我的专栏"
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--content-file <abs.md>` | 是 | 文章 markdown 绝对路径 |
| `--title "..."` | 否 | 默认取 frontmatter `title`；截到 100 字 |
| `--category "前端"` | 否* | 分类，**掘金发布必选**。best-effort 选第一个匹配；不传/不匹配则**自动选抽屉里第一个分类**让发布能继续 |
| `--tags "a"` | 否 | 本 workflow 只传 **1 个标签**；脚本收到多个会只取第一个并写日志 |
| `--summary "..."` | --post 时是 | 摘要，填进抽屉摘要框；**真发必须 50-100 字**，短于 50 字脚本直接退出 |
| `--column "专栏名"` | 否 | 收录至专栏，best-effort(**待登录后核对**) |

- 取 frontmatter `title` 作标题；frontmatter 自动 strip，只发正文 markdown。
- 截图：`DIAG_OUT/juejin_pub_ready.png`(填好待审/抽屉填好)、`juejin_pub_result.png`(--post 后)。

## 运行约定

- **浏览器**：Playwright **自带 Chromium**(非系统 Chrome，隔离)。可执行文件解析器扫 `[PLAYWRIGHT_BROWSERS_PATH, <repo>/.pw-browsers, ~/Library/Caches/ms-playwright]`，取第一个存在的 `chromium-*`。本机用仓库内 `.pw-browsers/chromium-1217`。
- **临时输出**：`DIAG_OUT=<scratchpad>` 控制截图/日志落点(默认脚本目录)。
- 脚本是 `.cjs`(`require('playwright/test')`)。需要浏览器/网络的命令在 Bash 里加 `dangerouslyDisableSandbox: true`；用 `run_in_background` 跑、读输出文件看结果。先 `node --check` 再跑。
- persistentContext 同一 `.juejin-browser` profile 一次只能跑一个实例(Chromium 锁 profile)，别并发跑两个脚本。

## 写文章页结构(juejin.cn/editor/drafts/new)

> 编辑器 URL：**`https://juejin.cn/editor/drafts/new`**(新建草稿)。已有草稿是 `/editor/drafts/<id>`。

| 元素 | 选择器 / 位置 | 说明 / 来源 |
| --- | --- | --- |
| 标题 | `input[placeholder*="标题"]`（实测 placeholder「输入文章标题...」） | 顶部标题输入框 |
| 正文编辑器 | `.CodeMirror`（Bytemd / CodeMirror 5；`.CodeMirror-code` 下 `span[role="presentation"]`） | **markdown 原生**，直接灌 markdown |
| 发布(触发) | 右上 `getByRole('button',{name:'发布'})`，回退 `.send-button` / 文本「发布」 | 点开发布抽屉 |
| 分类(必选) | 抽屉 `.category-list` 里文本节点(如「前端/后端/Android/iOS/人工智能/开发工具…」) | XPath 来源：`//div[@class="form-item-content category-list"]//div[contains(text(),"{分类}")]` |
| 标签 | byte-select：`[class*="byte-select__placeholder"]`(「请搜索添加标签」)，选项 `li[class*="byte-select-option"]` | 搜索→选候选；本 workflow 只选 1 个 |
| 封面 | `input[type="file"]` | 不传则掘金自动抓正文首图 |
| 摘要 | `textarea[placeholder*="摘要"]` / `textarea[class*="byte-input__textarea"]` | 「编辑摘要」；真发 50-100 字 |
| 专栏 | 文本「专栏/收录至专栏」+ 下拉选项 | **待登录后核对** |
| 确定并发布 | `button` 文本「确定并发布」 | 抽屉底部最终发布 |

> 选择器来源：知名自动化文章实测(见文末)。`byte-select__*` / `byte-input__*` 是字节自家组件库前缀。**分类/标签/确定并发布**已被多处实测引用；**专栏**控件未在公开资料中给出精确选择器，标「待登录后核对」，首次登录后用 `juejin_login.cjs` 的抽屉 dump 校正。

## 实现要点 / 坑

- **正文进入方式 = 优先 CodeMirror 5 API**。Bytemd 用 CodeMirror 5，DOM 节点 `.CodeMirror` 上挂着 JS 实例：`document.querySelector('.CodeMirror').CodeMirror.setValue(md)` + `.refresh()`，会正确触发 change、Bytemd 自动同步预览。脚本三级兜底：(a) `setValue` → (b) **剪贴板粘贴 text/plain markdown**(`grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://juejin.cn'})` → 点 `.CodeMirror` → `navigator.clipboard.writeText(md)` → `Meta+v`) → (c) `keyboard.type` 逐字(慢，截 20000 字)。每步用 `cm.CodeMirror.getValue().length` 校验是否灌进去。
- **markdown 原生，不要 HTML 渲染**：掘金不需要像知乎那样把 md 渲染成 HTML。frontmatter 用正则先 strip：`md.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '')`，标题取 frontmatter `title`。
- **分类是发布必选**：点「发布」后抽屉里**必须选一个分类**才能「确定并发布」。`--category` best-effort 匹配；**不匹配/不传就自动选第一个分类**，保证发布流程不卡住(选错分类只是分类不准，不影响发出)。
- **标签 byte-select**：只传 1 个最稳定标签。每个标签 = 点搜索框 → `keyboard.type` → 选第一个含该词的 `byte-select-option`；脚本收到多个标签会只取第一个，避免抽屉状态不稳定。
- **摘要硬规则**：`--post` 时摘要必须显式传入且至少 50 字；超过 100 字脚本截断到 100 字。不要用正文开头截断凑摘要，要写文章收益/冲突/读者能获得什么。
- **确定并发布可自动**：优先 `getByRole('button',{name:'确定并发布'})`/evaluate 点文本；不行坐标点抽屉右下；都不行 → `notifyLark('【掘金·待发布】文章已填好，请去点发布：https://juejin.cn/editor/drafts/new')` 并**保持窗口人工点**(poll url 变 `juejin.cn/post/<id>` 或出现「发布成功」，≤300s)。
- **PREPARE 是默认**：不传 `--post` 只填标题+正文，停在页面给人审核(掘金自动存草稿，进「我的-草稿箱」)。发布是对外不可撤动作，务必人工确认后再 `--post`。
- **未登录**：写文章页没有标题框即未登录，脚本 `exit 2`(与统一 CLI 约定一致)，先跑 `juejin_login.cjs` 扫码。
- **内容硬要求**：正文里**不得出现“公众号”或任何跨平台引流**。

## 掘金小册（说明：本 skill 不做，留 TODO）

> 用户问到「小册」时照此回答。

- **小册(Juejin 小册)是付费、多章节的创作者产品**：需要先向掘金申请并通过审批「**开设小册**」(有创作者资质/选题评审门槛)，与「发文章」是两套流程。
- **本 skill 不自动创建小册**，只做「**文章 + 专栏/分类**」。专栏(免费、聚合自己的文章)≠ 小册(付费、独立章节体系)。
- **备注 / TODO**：小册的「章节编辑器」与文章编辑器相近(同样 Bytemd / CodeMirror)。**待用户账号开通小册后**，可再扩一个「章节草稿填充」能力(填章节标题 + 灌 markdown 到章节编辑器，仍默认 PREPARE 不发布)。当前**先不实现**。

## 也可用统一 CLI（已接线）

```bash
node ../publish-cli.mjs juejin --file /abs/article.md --title "..." [--category "前端"] [--tags 单个标签] [--summary "50-100 字摘要"] [--column "专栏"]   # 填好不发
node ../publish-cli.mjs juejin --file /abs/article.md --post ...                                                                          # 真发
```

详见 `../_publish_core/README.md`。

## 何时调用

- “把这篇/这个系列发到掘金”“发稀土掘金”
- “掘金文章自动发布 / 填好待审”
- 已有 Markdown 博客文章要同步到掘金

## 选择器来源(实测参考)

- 一键自动化博客发布工具(掘金篇)：发布按钮 `.send-button`、标题 `input[placeholder="输入文章标题..."]`、正文 `.CodeMirror-code` 剪贴板粘贴、分类 `.category-list`、标签 `byte-select__placeholder`/`byte-select-option`、封面 `input[type=file]`、摘要 `byte-input__textarea`、最终 `button「确定并发布」`。
- Bytemd(掘金编辑器底层，bytemd.js.org)。专栏控件选择器待首登核对。
