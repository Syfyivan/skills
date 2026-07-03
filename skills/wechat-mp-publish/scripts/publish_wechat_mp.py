#!/usr/bin/env python3

import argparse
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token"
DRAFT_ADD_URL = "https://api.weixin.qq.com/cgi-bin/draft/add"
FREEPUBLISH_SUBMIT_URL = "https://api.weixin.qq.com/cgi-bin/freepublish/submit"
FREEPUBLISH_GET_URL = "https://api.weixin.qq.com/cgi-bin/freepublish/get"

PUBLISH_STATUS_LABELS = {
    0: "success",
    1: "publishing",
    2: "original_check_failed",
    3: "normal_failed",
    4: "platform_audit_failed",
    5: "deleted_after_publish",
    6: "banned_after_publish",
}

ROOT_DIR = Path(__file__).resolve().parents[3]
WEB_SPEC_PATH = Path(__file__).with_name("publish_wechat_mp_web.spec.js")
WENYAN_RENDERER = Path(__file__).with_name("render_wenyan.mjs")
URL_RENDERER = Path(__file__).with_name("url_to_markdown.mjs")
FRONT_MATTER_RE = re.compile(r"^﻿?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n", re.S)
LARK_IMAGE_TAG_RE = re.compile(r"<image\b([^>]*)/>", re.I)
LARK_FILE_TAG_RE = re.compile(r"(?s)<view\b[^>]*>\s*<file\b([^>]*)/>\s*</view>", re.I)
LARK_WHITEBOARD_TAG_RE = re.compile(r"<whiteboard\b([^>]*)/>", re.I)
LARK_ATTR_RE = re.compile(r'([a-zA-Z_:][a-zA-Z0-9_.:-]*)="([^"]*)"')


class WeChatPublishError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish an article to WeChat Official Account")
    parser.add_argument("--title", help="Article title")
    parser.add_argument("--content", help="Inline article content")
    parser.add_argument("--content-file", help="Path to a file containing article content")
    parser.add_argument("--doc-url", help="Feishu/Lark doc or wiki url")
    parser.add_argument("--url", help="博客/网页链接：抓取正文并转为 Markdown 后再发布")
    parser.add_argument("--reflow", action="store_true", help="HTML 输入时先经 readability+turndown 转 Markdown 再套用主题排版")
    parser.add_argument("--no-cover", action="store_true", help="跳过 AI 封面生成(只更新标题/正文/样式)")
    parser.add_argument(
        "--publish-mode",
        choices=("auto", "web", "api"),
        default="auto",
        help="Publish via web automation or official api, defaults to auto",
    )
    parser.add_argument(
        "--action",
        choices=("draft", "publish"),
        default="draft",
        help="Save as draft or publish immediately in web mode",
    )
    parser.add_argument(
        "--content-format",
        choices=("auto", "html", "text", "markdown", "pdf"),
        default="auto",
        help="Input content format, defaults to auto",
    )
    parser.add_argument("--thumb-media-id", help="Permanent cover material media id")
    parser.add_argument("--author", help="Article author")
    parser.add_argument("--digest", default="", help="Article digest")
    parser.add_argument("--content-source-url", default="", help="Original source URL")
    parser.add_argument("--cover-prompt", default="", help="Prompt for AI cover generation in web mode")
    parser.add_argument("--theme", help="公众号 排版主题 id (wenyan-core)，如 default/lapis/orangeheart/rainbow")
    parser.add_argument("--hl-theme", help="代码高亮主题 id (wenyan-core)，如 github/atom-one-dark/dracula")
    parser.add_argument("--list-themes", action="store_true", help="列出可用的 wenyan 排版/高亮主题后退出")
    parser.add_argument("--render-only", action="store_true", help="Render the content to HTML and print it")
    parser.add_argument("--keep-browser", action="store_true", help="Keep browser open after web automation")
    parser.add_argument("--browser-channel", default="", help="Playwright 浏览器 channel；留空=用自带 Chromium（与你的 Chrome 完全隔离），也可设 chrome/msedge")
    parser.add_argument("--user-data-dir", help="Persistent browser profile directory for web mode login reuse")
    parser.add_argument(
        "--need-open-comment",
        type=int,
        choices=(0, 1),
        default=0,
        help="Whether to enable comments",
    )
    parser.add_argument(
        "--only-fans-can-comment",
        type=int,
        choices=(0, 1),
        default=0,
        help="Whether only followers can comment",
    )
    parser.add_argument("--poll-interval", type=float, default=5.0, help="Publish status poll interval seconds")
    parser.add_argument("--timeout", type=float, default=180.0, help="Overall publish timeout seconds")
    return parser.parse_args()


def validate_input_source(args: argparse.Namespace) -> None:
    provided_count = sum(bool(value) for value in (args.content, args.content_file, args.doc_url, args.url))
    if provided_count != 1:
        raise WeChatPublishError("必须且只能提供 --content、--content-file、--doc-url、--url 其中一种")


def read_source(args: argparse.Namespace) -> Tuple[str, Optional[Path]]:
    source_path = Path(args.content_file) if args.content_file else None
    if args.content and args.content_format == "pdf":
        raise WeChatPublishError("PDF 模式仅支持 --content-file，请传入 PDF 文件路径")

    if args.content_file:
        if not source_path.exists():
            raise FileNotFoundError(source_path)
        if detect_content_format("", args.content_format, source_path) == "pdf":
            return "", source_path
        content = source_path.read_text(encoding="utf-8")
    else:
        content = args.content

    if not content or not content.strip():
        raise WeChatPublishError("文章正文不能为空")

    return content, source_path


def read_content(args: argparse.Namespace) -> Tuple[str, str, Optional[Path], Optional[str]]:
    content, source_path = read_source(args)

    content_format = detect_content_format(content, args.content_format, source_path)

    reflow = getattr(args, "reflow", False) or os.getenv("WECHAT_MP_REFLOW", "").strip() == "1"
    if content_format == "html" and reflow:
        converted = html_to_markdown(content)
        return converted, markdown_to_wechat_html(converted), source_path, None

    if content_format == "pdf":
        raw_text, rendered_html, pdf_title = pdf_to_wechat_html(source_path)
        return raw_text, rendered_html, source_path, pdf_title
    if content_format == "text":
        return content, text_to_html(content), source_path, None
    if content_format == "markdown":
        return content, markdown_to_wechat_html(content), source_path, None
    return content, content, source_path, None


def resolve_publish_mode(args: argparse.Namespace) -> str:
    if args.publish_mode != "auto":
        return args.publish_mode
    return "web"


def resolve_author(args: argparse.Namespace) -> str:
    return (args.author or os.getenv("WECHAT_MP_AUTHOR", "") or "繁漪").strip()


def resolve_title(args: argparse.Namespace, raw_content: str, source_path: Optional[Path], extracted_title: Optional[str] = None) -> str:
    if args.title and args.title.strip():
        return args.title.strip()

    if extracted_title and extracted_title.strip():
        return extracted_title.strip()

    if detect_content_format(raw_content, args.content_format, source_path) == "markdown":
        title = extract_title_from_markdown(raw_content)
        if title:
            return title

    if source_path:
        return source_path.stem.replace("-", " ").replace("_", " ").strip()

    first_line = next((line.strip() for line in raw_content.splitlines() if line.strip()), "")
    if first_line:
        return first_line[:80]
    raise WeChatPublishError("无法推断标题，请显式传入 --title")


def parse_front_matter(content: str) -> Tuple[Dict[str, str], str]:
    match = FRONT_MATTER_RE.match(content)
    if not match or ":" not in match.group(1):
        return {}, content
    attrs: Dict[str, str] = {}
    for line in match.group(1).splitlines():
        pair = re.match(r"^\s*([A-Za-z0-9_.\-]+)\s*:\s*(.*)$", line)
        if pair:
            attrs[pair.group(1).strip().lower()] = pair.group(2).strip().strip('"').strip("'").strip()
    return attrs, content[match.end():]


def strip_front_matter(content: str) -> str:
    return parse_front_matter(content)[1]


def extract_title_from_markdown(content: str) -> str:
    attrs, body = parse_front_matter(content)
    if attrs.get("title"):
        return cleanup_markdown_text(attrs["title"])

    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = re.match(r"^#\s+(.+)$", stripped)
        if match:
            return cleanup_markdown_text(match.group(1))

    for line in body.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith(("```", "- ", "* ", "> ")):
            return cleanup_markdown_text(stripped)
    return ""


def cleanup_markdown_text(text: str) -> str:
    text = re.sub(r"!\[([^\]]*)\]\(([^\)]+)\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\(([^\)]+)\)", r"\1", text)
    text = re.sub(r"[`*_#>]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def build_digest(html_content: str, limit: int = 120) -> str:
    plain = re.sub(r"<style[\s\S]*?</style>", " ", html_content, flags=re.I)
    plain = re.sub(r"<script[\s\S]*?</script>", " ", plain, flags=re.I)
    plain = re.sub(r"<[^>]+>", " ", plain)
    plain = html.unescape(re.sub(r"\s+", " ", plain)).strip()
    return plain[:limit]


def resolve_digest(args: argparse.Namespace, raw_content: str, html_content: str) -> str:
    """摘要优先级：显式 --digest > 文章 frontmatter description > 正文截取兜底。"""
    if args.digest and args.digest.strip():
        return args.digest.strip()
    attrs, _ = parse_front_matter(raw_content)
    description = attrs.get("description", "").strip()
    if description:
        return description[:120]
    return build_digest(html_content)


def load_series_theme_config() -> Dict[str, Any]:
    config_path = Path(__file__).with_name("series_theme.json")
    if config_path.exists():
        try:
            return json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    return {
        "rules": [{"match": "大寓言课", "theme": "literary", "hl": "github"}],
        "default": {"theme": "lapis", "hl": "github"},
    }


def resolve_series_theme(raw_content: str) -> Tuple[str, str]:
    """按文章 frontmatter(categories/title/tags) 匹配系列，返回 (theme, hl)。"""
    config = load_series_theme_config()
    attrs, _ = parse_front_matter(raw_content)
    haystack = " ".join(str(attrs.get(key, "")) for key in ("categories", "title", "tags"))
    for rule in config.get("rules", []):
        match = rule.get("match")
        if match and match in haystack:
            return rule.get("theme", ""), rule.get("hl", "")
    default = config.get("default", {})
    return default.get("theme", ""), default.get("hl", "")


def pdf_to_wechat_html(source_path: Optional[Path]) -> Tuple[str, str, Optional[str]]:
    if source_path is None:
        raise WeChatPublishError("PDF 模式必须提供本地文件路径")

    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise WeChatPublishError("缺少 pypdf 依赖，请先执行: python3 -m pip install pypdf") from exc

    try:
        reader = PdfReader(str(source_path))
    except Exception as exc:
        raise WeChatPublishError(f"读取 PDF 失败: {exc}") from exc

    metadata = reader.metadata or {}
    metadata_title = str(metadata.get("/Title") or "").strip() or None
    total_pages = len(reader.pages)
    raw_pages = []
    html_pages = []

    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:
            raise WeChatPublishError(f"提取 PDF 第 {index} 页内容失败: {exc}") from exc

        cleaned = normalize_pdf_text(text)
        if not cleaned:
            continue

        raw_pages.append(cleaned)
        if total_pages > 1:
            html_pages.append(
                f'<h2 style="margin: 1.4em 0 0.6em; font-size: 22px; line-height: 1.4; font-weight: 700; color: #111;">第 {index} 页</h2>'
            )
        html_pages.append(text_to_html(cleaned))

    if not raw_pages:
        raise WeChatPublishError("PDF 中未提取到可用文本，暂不支持纯扫描图片 PDF")

    raw_text = "\n\n".join(raw_pages)
    rendered_html = "\n".join(html_pages)
    return raw_text, rendered_html, metadata_title


def normalize_pdf_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", normalized)
    normalized = re.sub(r"[ \t]+", " ", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def run_external_command(command: list[str]) -> str:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as exc:
        raise WeChatPublishError(f"缺少依赖命令：{command[0]}") from exc

    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    if completed.returncode != 0:
        message = stderr or stdout or f"命令执行失败: {' '.join(command)}"
        raise WeChatPublishError(message)
    return stdout


def parse_json_output(text: str) -> Dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise WeChatPublishError("外部命令未返回有效 JSON")
    candidates = [stripped]
    match = re.search(r"(\{[\s\S]*\})\s*$", stripped)
    if match:
        candidates.append(match.group(1))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise WeChatPublishError("无法解析外部命令返回的 JSON")


def parse_tag_attributes(attrs_text: str) -> Dict[str, str]:
    return {key: value for key, value in LARK_ATTR_RE.findall(attrs_text)}


def fetch_lark_doc(doc_url: str) -> Tuple[str, str]:
    response = parse_json_output(
        run_external_command(
            [
                "lark-cli",
                "docs",
                "+fetch",
                "--doc",
                doc_url,
                "--format",
                "json",
            ]
        )
    )
    payload = response.get("data") if isinstance(response.get("data"), dict) else response
    markdown = str(payload.get("markdown") or payload.get("content") or "").strip()
    title = str(payload.get("title") or "").strip()
    if not markdown:
        raise WeChatPublishError("飞书文档抓取成功，但未返回 markdown 正文")
    return markdown, title


def resolve_downloaded_media_path(target_path: Path) -> Path:
    if target_path.exists():
        return target_path
    matches = sorted(path for path in target_path.parent.glob(f"{target_path.name}*") if path.is_file())
    if not matches:
        raise WeChatPublishError(f"未找到下载后的飞书素材文件: {target_path.name}")
    return matches[0]


def download_lark_media(token: str, asset_dir: Path, basename: str) -> Path:
    asset_dir.mkdir(parents=True, exist_ok=True)
    target_path = asset_dir / basename
    run_external_command(
        [
            "lark-cli",
            "docs",
            "+media-download",
            "--token",
            token,
            "--output",
            str(target_path),
        ]
    )
    return resolve_downloaded_media_path(target_path).resolve()


def render_lark_file_reference(attrs_text: str) -> str:
    attrs = parse_tag_attributes(attrs_text)
    name = attrs.get("name") or attrs.get("token") or "附件"
    return f"\n\n[附件：{name}]\n\n"


def render_lark_whiteboard_reference(attrs_text: str) -> str:
    attrs = parse_tag_attributes(attrs_text)
    token = attrs.get("token") or "unknown"
    return f"\n\n[画板：{token}]\n\n"


def materialize_lark_doc_assets(markdown: str, asset_dir: Path) -> str:
    token_to_path: Dict[str, Path] = {}

    def replace_image(match: re.Match[str]) -> str:
        attrs = parse_tag_attributes(match.group(1))
        token = attrs.get("token", "").strip()
        if not token:
            return ""
        if token not in token_to_path:
            token_to_path[token] = download_lark_media(token, asset_dir, f"image-{len(token_to_path) + 1}")
        alt_text = attrs.get("title") or attrs.get("name") or attrs.get("token") or f"image-{len(token_to_path)}"
        return f"\n\n![{alt_text}]({token_to_path[token].as_uri()})\n\n"

    rewritten = LARK_IMAGE_TAG_RE.sub(replace_image, markdown)
    rewritten = LARK_FILE_TAG_RE.sub(lambda match: render_lark_file_reference(match.group(1)), rewritten)
    rewritten = LARK_WHITEBOARD_TAG_RE.sub(lambda match: render_lark_whiteboard_reference(match.group(1)), rewritten)
    rewritten = re.sub(r"\n{3,}", "\n\n", rewritten)
    return rewritten.strip()


def stage_lark_doc_source(doc_url: str) -> Tuple[tempfile.TemporaryDirectory, Path, Optional[str]]:
    markdown, title = fetch_lark_doc(doc_url)
    temp_dir = tempfile.TemporaryDirectory(prefix="wechat-mp-lark-")
    stage_root = Path(temp_dir.name)
    rewritten = materialize_lark_doc_assets(markdown, stage_root / "assets")
    markdown_path = stage_root / "article.md"
    markdown_path.write_text(rewritten, encoding="utf-8")
    return temp_dir, markdown_path, title or None


def run_node_to_markdown(extra_args: list[str], stdin_text: Optional[str] = None) -> str:
    if not URL_RENDERER.exists():
        raise WeChatPublishError("缺少 url_to_markdown.mjs，无法转换网页/HTML")
    try:
        completed = subprocess.run(
            ["node", str(URL_RENDERER), *extra_args],
            input=stdin_text,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as exc:
        raise WeChatPublishError("需要 Node.js 才能抓取网页或转换 HTML") from exc
    if completed.returncode != 0:
        raise WeChatPublishError((completed.stderr or completed.stdout or "网页/HTML 转换失败").strip())
    markdown = (completed.stdout or "").strip()
    if not markdown:
        raise WeChatPublishError("网页/HTML 正文提取为空")
    return markdown


def html_to_markdown(html_text: str) -> str:
    return run_node_to_markdown([], stdin_text=html_text)


def stage_url_source(url: str) -> Tuple[tempfile.TemporaryDirectory, Path, Optional[str]]:
    markdown = run_node_to_markdown(["--url", url])
    temp_dir = tempfile.TemporaryDirectory(prefix="wechat-mp-url-")
    markdown_path = Path(temp_dir.name) / "article.md"
    markdown_path.write_text(markdown, encoding="utf-8")
    return temp_dir, markdown_path, None


def run_web_publish(
    args: argparse.Namespace,
    title: str,
    author: str,
    digest: str,
    source_path: Optional[Path],
) -> int:
    env = os.environ.copy()
    env["WECHAT_MP_TITLE"] = title
    env["WECHAT_MP_AUTHOR"] = author
    env["WECHAT_MP_DIGEST"] = digest
    env["WECHAT_MP_ACTION"] = args.action
    env["WECHAT_MP_CONTENT_FORMAT"] = args.content_format
    env["WECHAT_MP_BROWSER_CHANNEL"] = args.browser_channel

    if args.cover_prompt:
        env["WECHAT_MP_COVER_PROMPT"] = args.cover_prompt
    if args.keep_browser:
        env["WECHAT_MP_KEEP_BROWSER"] = "1"
    if args.user_data_dir:
        env["WECHAT_MP_USER_DATA_DIR"] = args.user_data_dir

    if args.content_file:
        env["WECHAT_MP_CONTENT_FILE"] = str(source_path.resolve())
    else:
        env["WECHAT_MP_CONTENT"] = args.content or ""

    playwright_bin = ROOT_DIR / "node_modules" / ".bin" / "playwright"
    if playwright_bin.exists():
        command = [str(playwright_bin)]
    else:
        command = ["npx", "--prefix", str(ROOT_DIR), "playwright"]
    command += [
        "test",
        "-c",
        str(WEB_SPEC_PATH.parent),
        str(WEB_SPEC_PATH),
        "--headed",
        "--workers=1",
        "--output",
        os.environ.get("WECHAT_MP_PW_OUTPUT_DIR", "/private/tmp/pw-wechat"),
    ]

    completed = subprocess.run(command, env=env)
    if completed.returncode != 0:
        raise WeChatPublishError(f"后台自动化发布失败，退出码: {completed.returncode}")
    return completed.returncode


def detect_content_format(content: str, requested_format: str, source_path: Optional[Path]) -> str:
    if requested_format != "auto":
        return requested_format

    suffix = source_path.suffix.lower() if source_path else ""
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".md", ".markdown", ".mdown"}:
        return "markdown"
    if suffix in {".html", ".htm"}:
        return "html"
    if looks_like_html(content):
        return "html"
    if looks_like_markdown(content):
        return "markdown"
    return "text"


def looks_like_html(content: str) -> bool:
    snippet = content.lstrip()[:300]
    return bool(re.search(r"<\s*(p|div|section|article|h[1-6]|ul|ol|li|blockquote|img|pre|table|br)\b", snippet, re.I))


def looks_like_markdown(content: str) -> bool:
    sample = content[:2000]
    patterns = [
        r"(?m)^#{1,6}\s+",
        r"(?m)^```",
        r"(?m)^\s*[-*+]\s+",
        r"(?m)^\s*\d+\.\s+",
        r"\[[^\]]+\]\([^\)]+\)",
        r"\*\*[^*]+\*\*",
        r"`[^`]+`",
    ]
    return any(re.search(pattern, sample) for pattern in patterns)


def text_to_html(content: str) -> str:
    paragraphs = [segment.strip() for segment in content.replace("\r\n", "\n").split("\n\n")]
    blocks = []
    for paragraph in paragraphs:
        if not paragraph:
            continue
        escaped = html.escape(paragraph).replace("\n", "<br/>")
        blocks.append(f"<p>{escaped}</p>")
    if not blocks:
        raise WeChatPublishError("纯文本内容转换后为空，请检查输入")
    return "\n".join(blocks)


def render_markdown_with_wenyan(content: str) -> Optional[str]:
    """Render markdown to 公众号 HTML via @wenyan-md/core; return None to fall back."""
    if not WENYAN_RENDERER.exists():
        return None
    tmp_path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        completed = subprocess.run(
            ["node", str(WENYAN_RENDERER), tmp_path],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        return None  # node 未安装，回退内置排版
    except OSError:
        return None
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout or "wenyan 渲染失败").strip()
        sys.stderr.write(f"[wenyan] 渲染失败，回退到内置排版：{message}\n")
        return None
    html_output = (completed.stdout or "").strip()
    return html_output if "<" in html_output else None


def list_wenyan_themes() -> int:
    if not WENYAN_RENDERER.exists():
        raise WeChatPublishError("缺少 render_wenyan.mjs，无法列出主题")
    try:
        completed = subprocess.run(
            ["node", str(WENYAN_RENDERER), "--list-themes"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as exc:
        raise WeChatPublishError("需要 Node.js 才能列出 wenyan 主题") from exc
    if completed.returncode != 0:
        raise WeChatPublishError((completed.stderr or "列出主题失败").strip())
    print(completed.stdout.strip())
    return 0


def delink_markdown(text: str) -> str:
    """公众号不支持正文外链跳转，将 Markdown 链接转为纯文字。

    - 图片链接 ![alt](url) -> alt（去掉图片语法，保留描述）
    - 站内相对链接 [文字](/path) 或 (#anchor) -> 文字（仅保留文字）
    - 外部链接 [文字](http...) -> 文字（url） 保留出处但不可跳转
    可通过环境变量 WECHAT_MP_KEEP_LINKS=1 关闭本行为。
    """
    if os.getenv("WECHAT_MP_KEEP_LINKS", "").strip() == "1":
        return text

    text = re.sub(r"!\[([^\]]*)\]\(([^\)]*)\)", r"\1", text)

    def _replace(match):
        label = match.group(1).strip()
        url = match.group(2).strip()
        if re.match(r"^(https?:)?//", url) or url.startswith("www."):
            if label:
                return f"{label}（{url}）"
            return url
        return label

    text = re.sub(r"\[([^\]]+)\]\(([^\)\s]+)\)", _replace, text)
    return text


def markdown_to_wechat_html(content: str) -> str:
    body = strip_front_matter(content)
    body = delink_markdown(body)
    if os.getenv("WECHAT_MP_DISABLE_WENYAN", "").strip() != "1":
        rendered = render_markdown_with_wenyan(body)
        if rendered:
            return rendered
    return markdown_to_html_builtin(body)


def markdown_to_html_builtin(content: str) -> str:
    lines = content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    output = []
    paragraph_lines = []
    list_items = []
    list_type = None
    code_lines = []
    code_lang = ""
    in_code_block = False
    blockquote_lines = []

    def flush_paragraph() -> None:
        nonlocal paragraph_lines
        if not paragraph_lines:
            return
        text = "<br/>".join(render_inline(line.strip()) for line in paragraph_lines if line.strip())
        if text:
            output.append(
                '<p style="margin: 1em 0; line-height: 1.75; color: #222; font-size: 16px;">'
                + text
                + "</p>"
            )
        paragraph_lines = []

    def flush_list() -> None:
        nonlocal list_items, list_type
        if not list_items:
            return
        tag = "ol" if list_type == "ol" else "ul"
        output.append(
            f'<{tag} style="margin: 1em 0 1em 1.5em; padding: 0; line-height: 1.75; color: #222; font-size: 16px;">'
            + "".join(f'<li style="margin: 0.35em 0;">{item}</li>' for item in list_items)
            + f"</{tag}>"
        )
        list_items = []
        list_type = None

    def flush_blockquote() -> None:
        nonlocal blockquote_lines
        if not blockquote_lines:
            return
        quote_html = "<br/>".join(render_inline(line.strip()) for line in blockquote_lines if line.strip())
        output.append(
            '<blockquote style="margin: 1em 0; padding: 0.75em 1em; background: #f6f7f8; border-left: 4px solid #07c160; color: #555;">'
            + quote_html
            + "</blockquote>"
        )
        blockquote_lines = []

    def flush_code_block() -> None:
        nonlocal code_lines, code_lang
        code = "\n".join(code_lines)
        label = f'<div style="margin-bottom: 0.5em; color: #576b95; font-size: 13px;">{html.escape(code_lang)}</div>' if code_lang else ""
        output.append(
            '<section style="margin: 1em 0;">'
            + label
            + '<pre style="margin: 0; padding: 12px 14px; overflow-x: auto; background: #f6f8fa; border-radius: 6px;">'
            + f'<code style="font-family: Menlo, Consolas, monospace; font-size: 13px; line-height: 1.6; color: #24292f;">{html.escape(code)}</code>'
            + "</pre></section>"
        )
        code_lines = []
        code_lang = ""

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()

        fence_match = re.match(r"^```\s*([^`]*)$", stripped)
        if fence_match:
            flush_paragraph()
            flush_list()
            flush_blockquote()
            if in_code_block:
                flush_code_block()
                in_code_block = False
            else:
                in_code_block = True
                code_lang = fence_match.group(1).strip()
                code_lines = []
            continue

        if in_code_block:
            code_lines.append(raw_line)
            continue

        if not stripped:
            flush_paragraph()
            flush_list()
            flush_blockquote()
            continue

        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            flush_paragraph()
            flush_list()
            flush_blockquote()
            output.append('<hr style="border: none; border-top: 1px solid #e6e6e6; margin: 1.5em 0;"/>')
            continue

        heading_match = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading_match:
            flush_paragraph()
            flush_list()
            flush_blockquote()
            level = len(heading_match.group(1))
            heading_text = render_inline(heading_match.group(2).strip())
            size = {1: "28px", 2: "24px", 3: "20px", 4: "18px", 5: "16px", 6: "15px"}[level]
            weight = "700" if level <= 2 else "600"
            output.append(
                f'<h{level} style="margin: 1.2em 0 0.6em; font-size: {size}; line-height: 1.4; font-weight: {weight}; color: #111;">{heading_text}</h{level}>'
            )
            continue

        blockquote_match = re.match(r"^>\s?(.*)$", stripped)
        if blockquote_match:
            flush_paragraph()
            flush_list()
            blockquote_lines.append(blockquote_match.group(1))
            continue

        unordered_match = re.match(r"^\s*[-*+]\s+(.*)$", line)
        ordered_match = re.match(r"^\s*\d+\.\s+(.*)$", line)
        if unordered_match or ordered_match:
            flush_paragraph()
            flush_blockquote()
            current_type = "ol" if ordered_match else "ul"
            if list_type and list_type != current_type:
                flush_list()
            list_type = current_type
            item_text = ordered_match.group(1) if ordered_match else unordered_match.group(1)
            list_items.append(render_inline(item_text.strip()))
            continue

        flush_list()
        flush_blockquote()
        paragraph_lines.append(line)

    if in_code_block:
        flush_code_block()
    flush_paragraph()
    flush_list()
    flush_blockquote()

    if not output:
        raise WeChatPublishError("Markdown 转换后为空，请检查输入")
    return "\n".join(output)


def render_inline(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(
        r"!\[([^\]]*)\]\(([^\)\s]+)(?:\s+\&quot;([^\"]*)\&quot;)?\)",
        lambda m: render_image(m.group(2), m.group(1), m.group(3) or m.group(1)),
        escaped,
    )
    escaped = re.sub(
        r"\[([^\]]+)\]\(([^\)\s]+)\)",
        lambda m: f'<a href="{m.group(2)}" style="color: #576b95; text-decoration: none;">{m.group(1)}</a>',
        escaped,
    )
    escaped = re.sub(r"`([^`]+)`", r'<code style="padding: 0.15em 0.3em; background: #f2f4f5; border-radius: 4px; font-family: Menlo, Consolas, monospace; font-size: 0.92em;">\1</code>', escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"__([^_]+)__", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", escaped)
    escaped = re.sub(r"(?<!_)_([^_]+)_(?!_)", r"<em>\1</em>", escaped)
    return escaped


def render_image(src: str, alt: str, title: str) -> str:
    alt_attr = html.escape(alt or title or "image")
    title_attr = html.escape(title or alt or "")
    caption = f'<figcaption style="margin-top: 0.5em; color: #888; font-size: 13px; text-align: center;">{title_attr}</figcaption>' if title_attr else ""
    if src.startswith("file://"):
        local_path = urllib.parse.unquote(urllib.parse.urlparse(src).path)
        label = html.escape(title or alt or Path(local_path).name or "本地图片")
        return (
            '<figure style="margin: 1.2em 0; text-align: center;">'
            + f'<span data-local-src="{html.escape(local_path)}" data-local-alt="{alt_attr}" style="display: inline-block; padding: 0.9em 1.1em; border: 1px dashed #d0d7de; border-radius: 6px; color: #57606a; font-size: 14px;">{label}</span>'
            + caption
            + "</figure>"
        )
    return (
        '<figure style="margin: 1.2em 0; text-align: center;">'
        + f'<img src="{src}" alt="{alt_attr}" style="max-width: 100%; height: auto; border-radius: 6px;"/>'
        + caption
        + "</figure>"
    )


def request_json(url: str, method: str = "GET", payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise WeChatPublishError(f"HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise WeChatPublishError(f"网络请求失败: {exc}") from exc

    try:
        result = json.loads(body)
    except json.JSONDecodeError as exc:
        raise WeChatPublishError(f"接口返回不是合法 JSON: {body}") from exc

    errcode = result.get("errcode", 0)
    if errcode not in (0, None):
        errmsg = result.get("errmsg", "unknown error")
        raise WeChatPublishError(f"微信接口调用失败: errcode={errcode}, errmsg={errmsg}")
    return result


def get_access_token() -> str:
    existing = os.getenv("WECHAT_MP_ACCESS_TOKEN", "").strip()
    if existing:
        return existing

    appid = os.getenv("WECHAT_MP_APPID", "").strip()
    appsecret = os.getenv("WECHAT_MP_APPSECRET", "").strip()
    if not appid or not appsecret:
        raise WeChatPublishError("缺少认证信息：请设置 WECHAT_MP_ACCESS_TOKEN 或 WECHAT_MP_APPID + WECHAT_MP_APPSECRET")

    query = urllib.parse.urlencode(
        {
            "grant_type": "client_credential",
            "appid": appid,
            "secret": appsecret,
        }
    )
    response = request_json(f"{TOKEN_URL}?{query}")
    token = response.get("access_token", "").strip()
    if not token:
        raise WeChatPublishError("获取 access_token 成功但响应中没有 access_token")
    return token


def api_url(base_url: str, access_token: str) -> str:
    return f"{base_url}?{urllib.parse.urlencode({'access_token': access_token})}"


def create_draft(access_token: str, article_payload: dict) -> str:
    response = request_json(
        api_url(DRAFT_ADD_URL, access_token),
        method="POST",
        payload={"articles": [article_payload]},
    )
    media_id = response.get("media_id", "").strip()
    if not media_id:
        raise WeChatPublishError("草稿创建成功但未返回 media_id")
    return media_id


def submit_publish(access_token: str, media_id: str) -> dict:
    response = request_json(
        api_url(FREEPUBLISH_SUBMIT_URL, access_token),
        method="POST",
        payload={"media_id": media_id},
    )
    publish_id = response.get("publish_id", "").strip()
    if not publish_id:
        raise WeChatPublishError("发布提交成功但未返回 publish_id")
    return response


def poll_publish(access_token: str, publish_id: str, poll_interval: float, timeout: float) -> dict:
    deadline = time.time() + timeout
    last_response = None

    while time.time() <= deadline:
        response = request_json(
            api_url(FREEPUBLISH_GET_URL, access_token),
            method="POST",
            payload={"publish_id": publish_id},
        )
        last_response = response
        status = response.get("publish_status")
        if status == 0:
            return response
        if status != 1:
            label = PUBLISH_STATUS_LABELS.get(status, "unknown")
            raise WeChatPublishError(
                f"发布失败: publish_status={status} ({label}), response={json.dumps(response, ensure_ascii=False)}"
            )
        time.sleep(poll_interval)

    raise WeChatPublishError(
        "发布轮询超时，最后一次响应: " + json.dumps(last_response or {}, ensure_ascii=False)
    )


def extract_article_url(publish_response: dict) -> str:
    detail = publish_response.get("article_detail") or {}
    items = detail.get("item") or []
    if not items:
        return ""
    first = items[0] or {}
    return str(first.get("article_url", ""))


def main() -> int:
    staged_source: Optional[tempfile.TemporaryDirectory] = None
    try:
        args = parse_args()
        if args.theme:
            os.environ["WECHAT_MP_THEME"] = args.theme.strip()
        if args.hl_theme:
            os.environ["WECHAT_MP_HL_THEME"] = args.hl_theme.strip()
        if args.reflow:
            os.environ["WECHAT_MP_REFLOW"] = "1"
        if args.no_cover:
            os.environ["WECHAT_MP_SKIP_COVER"] = "1"
        if args.list_themes:
            return list_wenyan_themes()
        validate_input_source(args)
        publish_mode = resolve_publish_mode(args)
        staged_title = None
        if args.doc_url:
            if publish_mode == "api":
                raise WeChatPublishError("飞书文档 URL 当前仅支持 web 模式发布，以保证图片可正确上传到公众号")
            staged_source, staged_path, staged_title = stage_lark_doc_source(args.doc_url)
            args.content = None
            args.content_file = str(staged_path)
            if args.content_format == "auto":
                args.content_format = "markdown"
        if args.url:
            staged_source, staged_path, staged_title = stage_url_source(args.url)
            args.content = None
            args.content_file = str(staged_path)
            if args.content_format == "auto":
                args.content_format = "markdown"
        if not args.theme and not os.getenv("WECHAT_MP_THEME"):
            try:
                theme_source, _ = read_source(args)
            except Exception:
                theme_source = ""
            auto_theme, auto_hl = resolve_series_theme(theme_source)
            if auto_theme:
                os.environ["WECHAT_MP_THEME"] = auto_theme
            if auto_hl and not os.getenv("WECHAT_MP_HL_THEME"):
                os.environ["WECHAT_MP_HL_THEME"] = auto_hl
        raw_content, content, source_path, extracted_title = read_content(args)
        title = resolve_title(args, raw_content, source_path, staged_title or extracted_title)
        author = resolve_author(args)
        digest = args.digest.strip() or build_digest(content)

        if args.render_only:
            print(content)
            return 0

        if publish_mode == "web":
            return run_web_publish(args, title, author, digest, source_path)

        if not args.thumb_media_id:
            raise WeChatPublishError("缺少封面素材：API 模式下必须提供 --thumb-media-id")

        access_token = get_access_token()

        article_payload = {
            "title": title,
            "author": author,
            "digest": digest,
            "content": content,
            "content_source_url": args.content_source_url,
            "thumb_media_id": args.thumb_media_id,
            "need_open_comment": args.need_open_comment,
            "only_fans_can_comment": args.only_fans_can_comment,
        }

        media_id = create_draft(access_token, article_payload)
        submit_response = submit_publish(access_token, media_id)
        publish_id = submit_response["publish_id"]
        publish_response = poll_publish(access_token, publish_id, args.poll_interval, args.timeout)

        result = {
            "media_id": media_id,
            "publish_id": publish_id,
            "publish_status": publish_response.get("publish_status"),
            "publish_status_label": PUBLISH_STATUS_LABELS.get(publish_response.get("publish_status"), "unknown"),
            "article_id": publish_response.get("article_id", ""),
            "article_url": extract_article_url(publish_response),
            "fail_idx": publish_response.get("fail_idx", []),
        }

        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except FileNotFoundError as exc:
        print(f"输入文件不存在: {exc}", file=sys.stderr)
        return 1
    except WeChatPublishError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        if staged_source is not None:
            staged_source.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
