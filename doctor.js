// deliveroo doctor: read-only setup check. Never touches the basket.
// Opens its own Deliveroo tab (same as restaurants/menu) and closes it.
// If the Chrome extension is not connected, opencli stops before this runs;
// `npx github:Eridanus-Multiverse/opencli-deliveroo doctor` explains that case.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { MIN_OPENCLI, versionAtLeast } from './lib.js';
import { FEED_STATE_JS, withFeedPage } from './feed-page.js';

/** Version of the opencli package this adapter is loaded by. */
export function opencliVersion() {
  let dir = dirname(createRequire(import.meta.url).resolve('@jackwener/opencli'));
  for (let i = 0; i < 6; i++, dir = dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, 'utf8'));
      if (json.name === '@jackwener/opencli') return json.version;
    }
  }
  return '';
}

/** One plain next step for a failed login check. */
export function loginAdvice(message) {
  if (/log ?in|session is gone/i.test(message)) return 'Open the Chrome that has the OpenCLI extension, log in at deliveroo.co.uk, then run: opencli deliveroo doctor';
  if (/captcha|verification/i.test(message)) return 'Open deliveroo.co.uk in that Chrome, complete the "are you human" check, then run: opencli deliveroo doctor';
  return 'Deliveroo did not load (' + message + '). Check deliveroo.co.uk opens in that Chrome, then run: opencli deliveroo doctor';
}

cli({
  site: 'deliveroo',
  name: 'doctor',
  access: 'read',
  description: 'Deliveroo doctor: check opencli version, Chrome connection and Deliveroo login (read-only)',
  domain: 'deliveroo.co.uk',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: ['check', 'status', 'next'],
  navigateBefore: false,
  func: async (page) => {
    const rows = [];
    const v = opencliVersion();
    rows.push(versionAtLeast(v, MIN_OPENCLI)
      ? { check: 'opencli', status: 'ok ' + v, next: '' }
      : { check: 'opencli', status: 'too old ' + (v || '?'), next: 'Update opencli: npm install -g @jackwener/opencli@latest' });
    // Reaching this line means opencli already got a browser tab through the extension.
    rows.push({ check: 'chrome extension', status: 'connected', next: '' });
    try {
      const loggedIn = await withFeedPage(page, () =>
        page.evaluate(`(() => !!((((${FEED_STATE_JS}) || {}).config || {}).user || {}).id)()`));
      rows.push(loggedIn
        ? { check: 'deliveroo login', status: 'ok', next: '' }
        : { check: 'deliveroo login', status: 'not logged in', next: loginAdvice('log in') });
    } catch (e) {
      rows.push({ check: 'deliveroo login', status: 'failed', next: loginAdvice(String(e?.message || e)) });
    }
    return rows;
  },
});
