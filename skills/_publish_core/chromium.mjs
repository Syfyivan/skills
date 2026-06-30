// ESM shim over chromium.cjs so .mjs scripts (e.g. gen_cards.mjs) share the same
// single source of truth for locating the Playwright-bundled Chromium executable.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveChromium } = require('./chromium.cjs');

export { resolveChromium };
