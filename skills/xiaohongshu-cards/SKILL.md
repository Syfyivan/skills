---
name: "xiaohongshu-cards"
description: "把博客/Markdown 文章转成小红书竖版图文卡片(1080×1440 PNG)并发布到小红书。卡片用 HTML/CSS 模板 + Playwright 截图本地生成(零登录),发布走小红书创作平台(持久登录态,扫一次码)。"
---

# 小红书图文卡片 + 发布

小红书是**图片优先**的图文笔记:1 张封面图 + 多张竖版内容图 + 短文案 + 话题标签。本 skill 把文章切成竖版卡片图,再发到小红书。

> ⚠️ 硬规则：小红书正文、卡片、标题**一律不得出现"公众号"或任何跨平台引流**（属违规广告）。

## 发布前：取吸睛标题（必做）

小红书标题 ≤20 字、要最吸睛。照 `../_publish_core/title-playbook.md` 出 3 个候选钩子标题挑 1 个，校验：
`node ../_publish_core/title.mjs --title "..." --platform xiaohongshu`（超 20 字会取「：」后副标题再截；别发被截断的残句）。最终用 `--title` 传给 gen_cards / xhs_publish。

## 两步

### 1) 生成卡片图(纯本地,不需要登录)

```bash
node scripts/gen_cards.mjs --content-file /abs/article.md --out /abs/out-dir
```

- 输出:`card-01.png`(封面:系列名+标题+钩子摘要)、`card-02..N.png`(正文,按高度自动分页)、末页(全文完 / 点赞·收藏·关注，**无任何跨平台引流**),均 **1080×1440**。
- 取 frontmatter:`title`(标题)、`description`(封面钩子)、`categories`(系列名)。可用 `--title/--hook/--series/--account` 覆盖。
- 主题:`--theme literary`(默认,配色与公众号 literary 呼应) / `blue`。
- 原理:HTML/CSS 卡片模板 → Playwright(自带 Chromium)截图。Chromium 解析同 wechat-mp-publish(优先仓库 `.pw-browsers/`)。

### 2) 发布到小红书(需登录态)

- 首次登录(扫一次码,长期保留到 `scripts/.xiaohongshu-browser`):
  ```bash
  node scripts/xhs_login.cjs   # 打开创作平台，手机扫码登录
  ```
- 发布:打开 `creator.xiaohongshu.com/publish/publish` → 点「上传图文」→ 上传 `card-*.png` → 填标题/正文/话题 → 发布。(脚本见 `scripts/`,流程见下「实现要点」。)

## 实现要点 / 坑

- **登录**:`creator.xiaohongshu.com`,扫码后落 `/new/home`;profile 持久化,复用免扫。用 Playwright 自带 Chromium(非系统 Chrome,隔离)。
- **图文表单**:发布页默认是「上传视频」,必须先点「上传图文」;上传至少一张图后才出现 标题/正文/话题 表单。`input[type=file]` 支持一次传多张(setInputFiles 数组)。
- **小红书限制**:标题 ≤20 字、正文 ≤1000 字、图 ≤18 张;反爬较强,优先实名号、有头浏览器,批量易限流——预期偶发失效需维护。
- 文案:封面短钩子 + 正文配文(可取文章 description/首段)+ 话题标签(#)。

## 也可用统一 CLI

`node ../publish-cli.mjs xiaohongshu --file /abs/article.md --title "..."`（生成卡片+填发布页，不发）；加 `--post` 真发。详见 `../_publish_core/README.md`。

## 何时调用

- “把这篇/这个系列做成小红书图文卡片”
- “生成小红书竖版卡片图”
- “发小红书”(图文笔记)
