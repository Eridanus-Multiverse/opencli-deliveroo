// Shared helpers for the Deliveroo adapter. This file registers no commands.
//
// Privacy rule: a full street address, phone number or card number never
// leaves the browser page. Commands only return masked postcodes and a
// street-level summary.
import { createHash } from 'node:crypto';

// Any Deliveroo restaurants listing page works as a starting point: it warms
// the site up (opening a /menu/ URL directly can hit a Cloudflare challenge)
// and provides the Next.js client router. The restaurant feed itself is
// located by the geohash of your saved address, not by this path.
// Set DELIVEROO_AREA to the "city/area" part of your own restaurants URL.
export const AREA = process.env.DELIVEROO_AREA || 'london/soho';
export const FEED_SEED = 'https://deliveroo.co.uk/restaurants/' + AREA;

// Oldest opencli this adapter was tested with.
export const MIN_OPENCLI = '1.8.7';

/** True if semver string v >= min (major.minor.patch; pre-release tags ignored). */
export function versionAtLeast(v, min) {
  const parse = (x) => String(x || '').trim().replace(/^v/, '').split('-')[0].split('.').map(Number);
  const a = parse(v), b = parse(min);
  if (a.length < 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// A preview older than this no longer authorises a payment: prices and fees drift.
export const PREVIEW_MAX_AGE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- geohash

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Standard geohash encoding. Deliveroo's feed is located by geohash. */
export function geohash(lat, lon, precision = 12) {
  let latRange = [-90, 90];
  let lonRange = [-180, 180];
  let even = true, bit = 0, ch = 0, out = '';
  while (out.length < precision) {
    if (even) {
      const mid = (lonRange[0] + lonRange[1]) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonRange[0] = mid; } else { ch = ch << 1; lonRange[1] = mid; }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latRange[0] = mid; } else { ch = ch << 1; latRange[1] = mid; }
    }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

// ---------------------------------------------------------------- addresses

/**
 * Pick one of the account's saved addresses (default: the most recent one).
 * Returns only id / postcode / coordinates; the formatted address never leaves.
 */
export function pickAddress(locations, filter) {
  const list = Array.isArray(locations) ? locations : [];
  if (!list.length) {
    throw new Error('No saved delivery address found. You may be logged out, or Deliveroo changed its page.');
  }
  let chosen = list[0];
  if (filter) {
    const want = String(filter).replace(/\s+/g, '').toUpperCase();
    const hit = list.find(a => String(a.postcode || '').replace(/\s+/g, '').toUpperCase().includes(want));
    if (!hit) {
      // Masked postcodes can collide, so addresses are listed by index.
      const known = list.map((a, i) => '#' + (i + 1) + ' ' + maskPostcode(a.postcode)).join(' / ');
      throw new Error('No saved address has a postcode like "' + filter + '". Saved (' + list.length + '): ' + known);
    }
    chosen = hit;
  }
  const [lon, lat] = Array.isArray(chosen.coordinates) ? chosen.coordinates : [];
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    throw new Error('The saved address has no coordinates; refusing to guess an area.');
  }
  return { id: chosen.id, postcode: chosen.postcode, lat, lon, geohash: geohash(lat, lon) };
}

/**
 * Keep only the area letters and the first digit: "ZZ11ZZ" -> "ZZ1**".
 *
 * Deliberately stricter than the outward code. Without a space a UK postcode
 * cannot be split reliably, and keeping one more character can reveal a sector.
 */
export function maskPostcode(pc) {
  const s = String(pc || '').replace(/\s+/g, '').toUpperCase();
  if (!s) return '(none)';
  const m = s.match(/^([A-Z]{1,2}\d)/);
  return m ? m[1] + '**' : s.slice(0, 2) + '**';
}

// ---------------------------------------------------------------- page guards

/** Login page, captcha or bot wall: always stop and report, never work around it. */
export function guardPage(probe) {
  if (!probe) throw new Error('Nothing was read from the page; it may not have loaded.');
  if (probe.guard === 'auth') {
    throw new Error('Deliveroo session is gone (redirected to login). Log in yourself in Chrome; this tool never touches login.');
  }
  if (probe.guard === 'captcha') {
    throw new Error('Hit a bot-verification wall (captcha). Stopped without trying to bypass it; solve it yourself in Chrome.');
  }
}

/** Page-side guard snippet, paired with guardPage. */
export const GUARD_JS = `
  (() => {
    const href = location.href;
    if (/\\/login|\\/signin|\\/auth\\//.test(href)) return 'auth';
    const t = String(document.title || '') + '\\n' + ((document.body && document.body.innerText) || '');
    if (/px-captcha|Press & Hold|Access to this page has been denied|are you a human/i.test(t)) return 'captcha';
    // Cloudflare's wall uses different wording. Missing it would turn "blocked"
    // into "nothing found" and lead to clicking buttons that are not there.
    if (/Just a moment|Performing security verification|Checking your browser|Attention Required/i.test(t)) return 'captcha';
    return '';
  })()
`;

// ---------------------------------------------------------------- formatting

/**
 * Money only. Deliveroo uses {code, fractional} objects or preformatted
 * strings; bare numbers are treated as pence. Never pass ratings here
 * (4.8 would become 0.05); use formatRating.
 */
export function money(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return (v / 100).toFixed(2);
  if (typeof v === 'object') {
    if (typeof v.formatted === 'string') return v.formatted.trim();
    if (typeof v.formattedValue === 'string') return v.formattedValue.trim();
    const frac = v.fractional ?? v.fractionalValue ?? v.amount;
    if (frac !== undefined && frac !== null) {
      const sym = v.code === 'GBP' || v.currencyCode === 'GBP' ? '£' : (v.symbol || '');
      return sym + (Number(frac) / 100).toFixed(2);
    }
  }
  return '';
}

/** Ratings arrive as 4.8, "4.8" or {ratingValue: 4.8}. Output has one decimal. */
export function formatRating(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(1) : '';
  if (typeof v === 'string') {
    const s = v.trim();
    const n = Number(s);
    return s !== '' && Number.isFinite(n) ? n.toFixed(1) : s;
  }
  if (typeof v === 'object') {
    const inner = firstOf(v, ['ratingValue', 'value', 'score', 'rating', 'formatted', 'text']);
    return typeof inner === 'object' ? '' : formatRating(inner);
  }
  return '';
}

// ---------------------------------------------------------------- outgoing URLs

/**
 * Every URL printed by this adapter goes through here. Query parameters are an
 * allowlist: a denylist would have to anticipate every location parameter
 * (a 12-character geohash is metre-level precision). Missing one here only
 * loses a diagnostic, never a location.
 */
const URL_KEEP_PARAMS = new Set(['q']);

export function scrubUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s, 'https://deliveroo.co.uk'); } catch { return ''; }
  for (const k of [...u.searchParams.keys()]) {
    if (!URL_KEEP_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  return u.origin + u.pathname + (u.search || '');
}

/** First non-empty field; Deliveroo renames the same field across blocks. */
export function firstOf(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

export function clampLimit(v, dflt, max) {
  return Math.max(1, Math.min(Number(v) || dflt, max));
}

// ---------------------------------------------------------------- page-side walker
//
// Deliveroo nests blocks inside blocks and redesigns often. Instead of
// hard-coding block types, walk the state tree for objects that look like
// dishes; field names are more stable than layout.
// ponytail: walks the whole tree (depth <= 10, Set dedupe); prune by block type if it gets slow.
export const WALK_JS = `
  function __walk(root, test, cap) {
    var out = [], seen = new Set(), stack = [[root, 0]];
    while (stack.length) {
      var pair = stack.pop(), node = pair[0], d = pair[1];
      if (!node || typeof node !== 'object' || d > 10) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = node.length - 1; i >= 0; i--) stack.push([node[i], d + 1]);
        continue;
      }
      if (test(node)) { out.push(node); if (out.length >= cap) return out; }
      var ks = Object.keys(node);
      for (var j = ks.length - 1; j >= 0; j--) stack.push([node[ks[j]], d + 1]);
    }
    return out;
  }
`;

/**
 * Turn a slug, path or URL into a menu page URL. This is a trust boundary:
 * links scraped from a page are untrusted, so only https deliveroo.co.uk is accepted.
 */
export function menuUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('Need a restaurant slug or menu page URL.');
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new Error('Unreadable link: ' + s); }
    if (u.protocol !== 'https:' || !/^(www\.)?deliveroo\.co\.uk$/i.test(u.hostname)) {
      throw new Error('Only https deliveroo.co.uk links are accepted, got: ' + s);
    }
    return u.origin + u.pathname;
  }
  if (s.startsWith('//') || s.includes('://')) throw new Error('Unreadable link: ' + s);
  if (s.startsWith('/')) return 'https://deliveroo.co.uk' + s.split('?')[0];
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new Error('Unexpected characters in restaurant slug: ' + s);
  return 'https://deliveroo.co.uk/menu/' + AREA + '/' + encodeURIComponent(s);
}

// ---------------------------------------------------------------- money arithmetic
//
// Money is always compared in integer pence; floating point would make equal
// totals compare unequal, and the total comparison is a payment gate.

/** "£3.75" / "3.75" / "-£1.00" -> 375 / 375 / -100. Unreadable -> null (not 0). */
export function pence(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v ?? '').replace(/[\s,]/g, '');
  const m = s.match(/(-|−)?£?(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Math.round(Number(m[2]) * 100);
  return m[1] ? -n : n;
}

export function fmtPence(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return (n < 0 ? '-£' : '£') + (Math.abs(n) / 100).toFixed(2);
}

/**
 * Basket fingerprint: shop name plus each "qty×name@price" line, sorted, hashed.
 * Line order does not matter; any change in shop, item, quantity, option or price does.
 */
export function basketFingerprint(shop, lines) {
  const body = [String(shop || '').trim()]
    .concat((Array.isArray(lines) ? lines : [])
      .map(l => String(l.qty) + '×' + String(l.name || '').trim() + '@' + String(l.price || '').trim())
      .sort())
    .join('\n');
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- payment gates
//
// Pure functions, testable offline. Any failure throws; the default is always "stop".

/** The live total may differ from the previewed total by at most 50p. */
export function assertConfirmedTotal(confirmed, current) {
  if (![confirmed, current].every(v => Number.isSafeInteger(v) && v >= 0)) {
    throw new Error('Previewed or current total is not a valid amount in pence. Not paying.');
  }
  if (Math.abs(current - confirmed) > 50) {
    throw new Error('Checkout total differs from the preview by more than £0.50. ' +
      'Preview: ' + fmtPence(confirmed) + ', page now: ' + fmtPence(current) + '. Not paying; run a new preview.');
  }
  return true;
}

/** The preview must be under 10 minutes old, total within 50p, and the same basket fingerprint. */
export function assertPreviewMatches({ preview, now, totalPence, fingerprint }) {
  if (!preview || typeof preview !== 'object') {
    throw new Error('No preview found. Run `opencli deliveroo checkout --preview` first.');
  }
  const at = Date.parse(preview.at);
  if (!Number.isFinite(at)) throw new Error('Preview timestamp is unreadable: ' + preview.at + '. Run a new preview.');
  const age = now - at;
  if (age < 0) throw new Error('Preview timestamp is in the future (clock problem?). Run a new preview.');
  if (age > PREVIEW_MAX_AGE_MS) {
    throw new Error(
      'The preview is ' + Math.round(age / 60000) + ' minutes old; it expires after ' + (PREVIEW_MAX_AGE_MS / 60000) +
      ' minutes because prices and fees change. Run a new preview.'
    );
  }
  assertConfirmedTotal(preview.total_pence, totalPence);
  if (preview.fingerprint !== fingerprint) {
    throw new Error(
      'The basket changed since the preview (fingerprint ' + preview.fingerprint + ' -> ' + fingerprint + '). ' +
      'Not paying; run a new preview.'
    );
  }
  return true;
}

/**
 * Optional spending cap from DELIVEROO_MAX_TOTAL (pounds, e.g. "40" or "40.00").
 * Unset or empty -> no cap. Set but unreadable -> refuse rather than ignore it.
 */
export function maxTotalPence(env = process.env) {
  const raw = String(env.DELIVEROO_MAX_TOTAL ?? '').trim();
  if (!raw) return null;
  const p = /^£?\d+(?:\.\d{1,2})?$/.test(raw) ? pence(raw) : null;
  if (p === null || p <= 0) throw new Error('DELIVEROO_MAX_TOTAL is set but is not a positive amount: "' + raw + '". Not paying.');
  return p;
}

export function assertUnderCap({ totalPence, capPence }) {
  if (typeof totalPence !== 'number' || !Number.isFinite(totalPence)) {
    throw new Error('Could not read the checkout total. Not paying.');
  }
  if (capPence !== null && capPence !== undefined && totalPence > capPence) {
    throw new Error('This order is ' + fmtPence(totalPence) + ', above DELIVEROO_MAX_TOTAL ' + fmtPence(capPence) + '. Not paying.');
  }
  return true;
}

/** Tip and charity donation must be zero; this tool never adds them. */
export function assertNoTipOrDonation({ tipPence, charityPence }) {
  const t = tipPence ?? 0;
  const c = charityPence ?? 0;
  if (t !== 0 || c !== 0) {
    throw new Error(
      'Checkout shows tip ' + fmtPence(t) + ' / donation ' + fmtPence(c) + '; both must be £0.00. ' +
      'Not paying. Add tips or donations yourself in the browser if you want them.'
    );
  }
  return true;
}

// ---------------------------------------------------------------- address masking

/**
 * Checkout address block -> street name plus masked postcode only.
 * Input:  "1 Example Road\nLondon, ZZ1 1ZZ\n+447700900123\nNo rider directions"
 * Output: "Example Road · ZZ1**"
 * House numbers, flats, floors, phone numbers, city and free-text instructions
 * never come back. Anything unrecognised returns "(unreadable)".
 */
export const ADDRESS_UNREADABLE = '(unreadable)';

export function maskAddress(raw) {
  const lines = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean)
    // Phone lines are dropped entirely, not masked.
    .filter(l => !/^(\+|00)?[\d][\d\s()+-]{6,}$/.test(l))
    .filter(l => !/^(Edit|Change|Add|No rider directions|Rider directions)/i.test(l))
    // Map and delivery-option text appears depending on load timing; it must not change the result.
    .filter(l => !/(Map data|Report a map error|^Terms\b|Meet me with the order|choose a safe place|Make this a gift|Google)/i.test(l));
  // Never return the remainder of the address block: it may contain floors,
  // door codes or free-form delivery instructions. Unknown layouts stay closed.
  const notes = /\b(directions?|instructions?|leave|deliver|delivery|entrance|doorbell|buzzer|ring|call|access|code|reception|concierge|meet|safe place|gift)\b/i;
  const clean = lines.filter(l => !notes.test(l));
  const postcodes = [...new Set((clean.join('\n').match(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi) || []).map(p => p.replace(/\s/g, '').toUpperCase()))];
  if (postcodes.length !== 1) return ADDRESS_UNREADABLE;
  const roads = new Set();
  for (let part of clean.flatMap(l => l.split(/[;,]/))) {
    part = part.trim();
    // A unit and a floor can precede the street in either order.
    for (let i = 0; i < 4; i++) {
      part = part.replace(/^(?:Flat|Apt|Apartment|Unit|Room|Suite)\s+[\w-]+\s*/i, '')
        .replace(/^(?:(?:\d+(?:st|nd|rd|th)?|ground|first|second|third|fourth|fifth|upper|lower|basement)\s+floor|floor\s+\d+)\s*/i, '').trim();
    }
    part = part.replace(/^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?\s+/, '');
    const match = part.match(/^([\p{L}][\p{L}.'’ -]{0,100}?\s+(?:Road|Street|Lane|Way|Avenue|Close|Drive|Square|Terrace|Gardens|Place|Crescent|Court|Mews|Hill|Grove|Walk|Row|Bridge|Parade|Rise|Vale|Park|Embankment|Passage|Yard|Causeway|Highway))(?=$|\s+[A-Z]{1,2}\d)/iu);
    if (match) roads.add(match[1]);
  }
  if (roads.size !== 1) return ADDRESS_UNREADABLE;
  return [...roads][0] + ' · ' + maskPostcode(postcodes[0]);
}

// ---------------------------------------------------------------- page-side snippets
//
// Strings passed to page.evaluate. Deliveroo's class names are build hashes,
// so none are used; only aria labels and visible button text.

/**
 * The OneTrust cookie banner covers half the page. It is removed from the DOM,
 * never answered: clicking Accept or Reject would make a choice for the user.
 */
export const KILL_OVERLAYS_JS = `
  (() => {
    var sels = ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '.onetrust-pc-dark-filter', '#ot-sdk-btn-floating'];
    var n = 0;
    for (var i = 0; i < sels.length; i++) {
      var els = document.querySelectorAll(sels[i]);
      for (var j = 0; j < els.length; j++) { els[j].remove(); n++; }
    }
    return n;
  })()
`;

/** Shared dialog helpers: current dialog, option groups, find buttons by text. */
export const MODAL_JS = `
  function __dialog() {
    var ds = document.querySelectorAll('[role="dialog"],[aria-modal="true"]');
    return ds.length ? ds[ds.length - 1] : null;
  }
  function __firstLine(el) {
    return ((el && el.innerText) || '').split('\\n').map(function (s) { return s.trim(); }).filter(Boolean)[0] || '';
  }
  // Button text is the contract: Add for £0.50 / Remove item / Go to checkout / Pay now
  function __byText(root, re) {
    var all = root.querySelectorAll('button,[role="button"],[tabindex="0"],a');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (re.test((all[i].innerText || '').trim())) out.push(all[i]);
    }
    return out;
  }
  // Option groups: each choice is a button wrapping a radio/checkbox; the group
  // is the nearest ancestor whose heading says Choose / Select / Required / Optional.
  function __groups(d) {
    var rows = d.querySelectorAll('button');
    var groups = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.querySelector('input[type=radio],input[type=checkbox]')) continue;
      var g = r.parentElement, hit = null;
      for (var k = 0; k < 8 && g && g !== d; k++) {
        var head = ((g.innerText || '').split('\\n').filter(function (s) { return s.trim(); }).slice(0, 4).join(' '));
        if (/\\bRequired\\b|\\bOptional\\b/.test(head) || /^(Choose|Select)\\b/.test(head.trim())) { hit = g; break; }
        g = g.parentElement;
      }
      if (!hit) continue;
      var e = null;
      for (var j = 0; j < groups.length; j++) if (groups[j].el === hit) e = groups[j];
      if (!e) {
        var h = (hit.innerText || '').split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
        e = {
          el: hit,
          title: h.slice(0, 2).join(' · '),
          required: /\\bRequired\\b/.test(h.slice(0, 4).join(' ')),
          options: [], rows: [], checked: 0,
        };
        groups.push(e);
      }
      var label = __firstLine(r);
      e.options.push(label);
      e.rows.push(r);
      if (r.querySelector('input:checked')) e.checked++;
    }
    return groups;
  }
`;

/** Basket from the menu page sidebar (live DOM; the SSR state is stale after add/remove). */
export const BASKET_DOM_JS = `
  (() => {
    const guard = ${GUARD_JS};
    if (guard) return { guard };
    const t = document.body ? document.body.innerText || '' : '';
    const rows = [];
    const btns = document.querySelectorAll('button,[role="button"]');
    for (let i = 0; i < btns.length; i++) {
      const m = /^Quantity\\s+(\\d+),\\s*(.+?),\\s*(£[\\d.,]+)\\s*$/.exec(btns[i].getAttribute('aria-label') || '');
      if (m) rows.push({ qty: Number(m[1]), name: m[2].trim(), price: m[3] });
    }
    const shop = (document.title || '').split(' delivery from ')[0].split(' - Order with')[0].trim();
    return { guard: '', rows, shop, empty: /Your basket is empty/i.test(t) };
  })()
`;

// ---------------------------------------------------------------- opening a menu
//
// Opening a /menu/ URL as a new document can hit Cloudflare's "Just a moment"
// wall, while a restaurants listing page loads fine. So land on a listing page
// first and use Next's client-side router to reach the menu: no new document
// request, no wall.

const samePath = (a, b) =>
  String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();

export async function gotoMenu(page, restaurant) {
  const url = menuUrl(restaurant);
  const path = new URL(url).pathname;

  // Already on a Deliveroo page: do not goto again. Navigating to the same URL
  // twice is rejected by the browser extension, and client routing works from any Deliveroo page.
  const seed = await page.evaluate(`
    (() => ({ guard: ${GUARD_JS}, href: location.href, hasRouter: !!((window.next || {}).router || {}).push }))()
  `);
  guardPage(seed);
  if (!seed.hasRouter || !/^https:\/\/(www\.)?deliveroo\.co\.uk\//i.test(String(seed.href || ''))) {
    await page.goto(FEED_SEED);
    await page.wait(4);
    guardPage(await page.evaluate(`(() => ({ guard: ${GUARD_JS} }))()`));
  }

  const routed = await page.evaluate(`
    (() => {
      const r = (window.next || {}).router;
      if (!r || typeof r.push !== 'function') return false;
      r.push(${JSON.stringify(path)});
      return true;
    })()
  `);
  if (!routed) {
    // No Next router (redesign?): open directly; a wall is reported by guardPage as a wall.
    await page.goto(url);
  }
  // The URL changes instantly; menu data arrives later. Wait for dish cards,
  // not for the URL, or an empty read would be misreported as a redesign.
  for (let i = 0; i < 15; i++) {
    await page.wait(2);
    const ready = await page.evaluate(`
      (() => ({
        guard: ${GUARD_JS},
        path: location.pathname,
        cards: document.querySelectorAll('[role="button"][aria-label]').length,
      }))()
    `);
    guardPage(ready);
    if (samePath(ready.path, path) && ready.cards >= 5) return;
  }
  throw new Error('Could not open ' + path + ' (no menu appeared within 30 seconds). The restaurant may not exist, may be closed, or the link is wrong. Nothing was changed.');
}
