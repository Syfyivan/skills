#!/usr/bin/env node
// title.mjs — mechanical title validation & normalization for multi-platform publishing.
//
// Scope: this file does NOT invent or improve titles. Creativity lives in title-playbook.md.
// Here we only (1) clean the string, (2) truncate to each platform's hard limit, and
// (3) lint for rhythm (count of ？/！). Pure Node ESM, zero third-party dependencies.
//
// Syntax check:  node --check title.mjs
// CLI:           node title.mjs --title "..." --platform xiaohongshu

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

// Per-platform hard title length limits, counted in Unicode code points.
const LIMITS = {
  wechat: 64,
  xiaohongshu: 20,
  zhihu: 100,
  csdn: 100,
  juejin: 100,
};

// Length in Unicode code points (a CJK char / most emoji = 1), not UTF-16 units.
function charLen(s) {
  return [...s].length;
}

// Truncate to `max` code points without splitting a surrogate pair.
function truncate(s, max) {
  const cp = [...s];
  return cp.length <= max ? s : cp.slice(0, max).join('');
}

// Drop invisible / control chars. Source stays ASCII-only by filtering on code points:
//   - C0 controls 0x00-0x1F, DEL + C1 controls 0x7F-0x9F
//   - zero-width space/joiner/non-joiner 0x200B-0x200D, word joiner 0x2060, BOM 0xFEFF
// (Newlines are converted to spaces by validateTitle before this runs.)
function stripInvisible(s) {
  return Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0);
      if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return false;
      if (c >= 0x200b && c <= 0x200d) return false;
      if (c === 0x2060 || c === 0xfeff) return false;
      return true;
    })
    .join('');
}

// Collapse any whitespace run to a single space and trim both ends.
function normalizeSpace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Validate & normalize a title for a target platform.
 *
 * `ok` means "length / platform is fine, safe to publish as-is". It is set to false when the
 * title is empty, the platform is unknown, or the title had to be truncated (content was lost).
 * Style advice (e.g. missing ？/！) is reported via `warnings` but does NOT flip `ok`.
 *
 * @param {string} title    raw title (may contain spaces / newlines / invisible chars)
 * @param {string} platform 'wechat' | 'xiaohongshu' | 'zhihu'
 * @returns {{ok: boolean, title: string, warnings: string[]}}
 */
export function validateTitle(title, platform) {
  const warnings = [];
  let ok = true;

  // 1) Clean: newlines -> space, strip invisibles, collapse spaces, trim.
  let t = String(title ?? '');
  t = t.replace(/[\r\n]+/g, ' ');
  t = stripInvisible(t);
  t = normalizeSpace(t);

  // Unknown platform: cannot enforce a limit; flag it and skip truncation.
  const limit = LIMITS[platform];
  if (limit === undefined) {
    ok = false;
    warnings.push(`未知平台「${platform}」，无法按长度校验，请使用 wechat / xiaohongshu / zhihu / csdn / juejin`);
  }

  // Empty after cleaning: nothing more to check.
  if (charLen(t) === 0) {
    warnings.push('标题为空');
    return { ok: false, title: t, warnings };
  }

  // 2) Xiaohongshu: if over 20 chars and a colon exists, prefer the subtitle after the first colon.
  if (platform === 'xiaohongshu' && charLen(t) > LIMITS.xiaohongshu && /[：:]/.test(t)) {
    const parts = t.split(/[：:]/);
    const sub = parts.slice(1).join('：').trim(); // keep any later colons inside the subtitle
    if (sub.length > 0) {
      warnings.push(`小红书标题超 ${LIMITS.xiaohongshu} 字，已改用冒号后的副标题：「${sub}」`);
      t = sub;
    }
  }

  // 3) Hard truncate to the platform limit.
  if (limit !== undefined && charLen(t) > limit) {
    const before = charLen(t);
    t = truncate(t, limit);
    ok = false;
    warnings.push(`标题原 ${before} 字超过 ${platform} 上限 ${limit} 字，已截断为 ${limit} 字`);
  }

  // 4) Rhythm lint: count ？/！ (full- and half-width). Zero -> suggest adding some.
  const punct = (t.match(/[？！?!]/g) || []).length;
  if (punct === 0) {
    warnings.push('建议加问号/感叹号增加节奏感');
  }

  return { ok, title: t, warnings };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') out.title = argv[++i];
    else if (a.startsWith('--title=')) out.title = a.slice('--title='.length);
    else if (a === '--platform') out.platform = argv[++i];
    else if (a.startsWith('--platform=')) out.platform = a.slice('--platform='.length);
  }
  return out;
}

// Run the CLI only when executed directly, not when imported as a module.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const { title = '', platform = 'wechat' } = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(validateTitle(title, platform), null, 2));
}
