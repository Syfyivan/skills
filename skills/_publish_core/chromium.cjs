// Resolve the Playwright-bundled "Google Chrome for Testing" executable on macOS.
// Shared by every publish script so this lookup logic lives in exactly one place.
//
// Scan order mirrors the original inline copies:
//   1. $PLAYWRIGHT_BROWSERS_PATH (if set)
//   2. <repo>/.pw-browsers            (durable, survives ~/Library/Caches cleanup)
//   3. ~/Library/Caches/ms-playwright (Playwright's default download cache)
// Within each root pick the highest-numbered `chromium-<n>` build, then probe the
// known mac layout sub-dirs. Returns the first existing executable path, else undefined.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function resolveChromium() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  // This file lives at <repo>/skills/_publish_core/, so the repo-root .pw-browsers
  // is two levels up. (Original scripts reached it as ROOT/../../../.pw-browsers
  // from <repo>/skills/<skill>/scripts/.)
  roots.push(path.resolve(__dirname, '..', '..', '.pw-browsers'));
  roots.push(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'));
  for (const root of roots) {
    let builds;
    try { builds = fs.readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse(); }
    catch (_) { continue; }
    for (const d of builds) {
      // Union of all inline copies: cover all three mac layout variants.
      for (const s of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac']) {
        const e = path.join(root, d, s, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (fs.existsSync(e)) return e;
      }
    }
  }
  return undefined;
}

module.exports = { resolveChromium };
