---
name: "xiaohongshu-cards"
description: "把博客/Markdown 文章转成小红书竖版图文卡片(1080×1440 PNG)，并生成可人工发布的标题/正文/话题。小红书账号已出现第三方工具/脚本预警，因此本 skill 禁止自动打开创作平台、上传或发布。"
---

# 小红书图文卡片（合规人工发布）

小红书是**图片优先**的图文笔记:1 张封面图 + 多张竖版内容图 + 短文案 + 话题标签。本 skill 只把文章切成竖版卡片图，并生成发布文案；**最后必须由用户用小红书官方 App/网页人工上传和发布**。

> ⚠️ 硬规则：小红书正文、卡片、标题**一律不得出现"公众号"或任何跨平台引流**（属违规广告）。
> ⚠️ 账号风控：用户已收到“疑似使用第三方工具或脚本自动浏览/查看/发布内容”的预警。不要再用 Playwright/脚本打开小红书创作平台、上传图片、填写表单或点击发布。

## 发布前：取吸睛标题（必做）

小红书标题 ≤20 字、要最吸睛。照 `../_publish_core/title-playbook.md` 出 3 个候选钩子标题挑 1 个，校验：
`node ../_publish_core/title.mjs --title "..." --platform xiaohongshu`（超 20 字会取「：」后副标题再截；别发被截断的残句）。最终用 `--title` 传给 `gen_cards.mjs`。

## 流程

### 1) 生成卡片图(纯本地,不需要登录)

```bash
node scripts/gen_cards.mjs --content-file /abs/article.md --out /abs/out-dir
```

- 输出:`card-01.png`(封面:系列名+标题+钩子摘要)、`card-02..N.png`(正文,按高度自动分页)、末页(全文完 / 点赞·收藏·关注，**无任何跨平台引流**),均 **1080×1440**。
- 取 frontmatter:`title`(标题)、`description`(封面钩子)、`categories`(系列名)。可用 `--title/--hook/--series/--account` 覆盖。
- 主题:`--theme literary`(默认,配色与公众号 literary 呼应) / `blue`。
- 原理:HTML/CSS 卡片模板 → Playwright(自带 Chromium)截图。Chromium 解析同 wechat-mp-publish(优先仓库 `.pw-browsers/`)。

### 2) 生成发布文案（交给用户人工发布）

发布前给用户这三样：

- 标题：≤20 字，必须是吸睛短钩子。
- 正文：第一句用 hook，后面 1-3 句概括文章收益；不要跨平台引流。
- 话题：3-5 个站内话题，例如 `#AI #机器学习 #人工智能 #学习笔记 #寓言`。

用户自己打开小红书官方 App/网页，上传 `card-*.png`，复制标题/正文/话题并发布。

## 实现要点 / 坑

- **不要登录/上传/发布自动化**：`scripts/xhs_publish.cjs` 已默认阻断，除非显式设置高风险环境变量 `XHS_ALLOW_BROWSER_AUTOMATION=1`。正常使用不要设置。
- **小红书限制**:标题 ≤20 字、正文 ≤1000 字、图 ≤18 张。
- 文案:封面短钩子 + 正文配文(可取文章 description/首段)+ 话题标签(#)。

## 也可用统一 CLI

`node ../publish-cli.mjs xiaohongshu --file /abs/article.md --title "..."` 只生成卡片图，不打开小红书网页；`--post` 会被阻断。详见 `../_publish_core/README.md`。

## 何时调用

- “把这篇/这个系列做成小红书图文卡片”
- “生成小红书竖版卡片图”
- “发小红书”(仅准备素材，最终人工发布)
