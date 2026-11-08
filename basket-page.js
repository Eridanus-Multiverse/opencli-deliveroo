// How the basket is read.
//
// In the live Redux state the basket is only a shadow on every page:
//   s.basket = { loading, subtotal: "6" (item count, not money), url: the shop's menu link }
// Line items exist only in the menu page sidebar DOM (aria-label "Quantity N, name, £x").
// Flow: get the shop link from the shadow -> gotoMenu -> read the sidebar.
import { BASKET_DOM_JS, FEED_SEED, GUARD_JS, guardPage } from './lib.js';
import { FEED_STATE_JS } from './feed-page.js';

const ON_DELIVEROO = /^https:\/\/(www\.)?deliveroo\.co\.uk\//i;

/** Ask the live state which shop the basket belongs to. Returns { url, count }; empty url = unknown. */
export async function basketShopUrl(page) {
  const seed = await page.evaluate(`(() => ({ guard: ${GUARD_JS}, href: location.href }))()`);
  guardPage(seed);
  if (!ON_DELIVEROO.test(String(seed.href || ''))) {
    await page.goto(FEED_SEED);
  }
  for (let i = 0; i < 15; i++) {
    await page.wait(1);
    const r = await page.evaluate(`
      (() => {
        const guard = ${GUARD_JS};
        if (guard) return { guard };
        const s = ${FEED_STATE_JS};
        if (!s || !s.config) return { guard: '', ready: false };
        if (!((s.config || {}).user || {}).id) return { guard: 'auth' };
        const b = s.basket && typeof s.basket === 'object' ? s.basket : null;
        return {
          guard: '', ready: true,
          hasRoot: !!b,
          loading: !!(b || {}).loading,
          url: String((b || {}).url || ''),
          count: String((b || {}).subtotal ?? ''),
        };
      })()
    `);
    guardPage(r);
    if (r.ready && !r.loading) return r;
  }
  throw new Error('Deliveroo page did not finish loading within 15 seconds; try again later.');
}

/** Read the sidebar on a menu page. It renders after the menu, so wait for rows or an explicit "empty". */
export async function readBasketDom(page) {
  let last = null;
  for (let i = 0; i < 10; i++) {
    last = await page.evaluate(BASKET_DOM_JS);
    guardPage(last);
    if ((last.rows || []).length || last.empty) return last;
    await page.wait(1);
  }
  return last;
}

/** After the dish name only an option separator may follow: "Fries Deluxe" is not "Fries". */
function matchesBasketItem(row, name) {
  const want = String(name || '').trim().toLowerCase();
  const actual = String(row?.name || '').trim().toLowerCase();
  return !!want && (actual === want || actual.startsWith(want + ','));
}

export function findBasketRow(rows, name) {
  return (rows || []).find(row => matchesBasketItem(row, name)) || null;
}

/** One dish with different options may span several rows; confirming an add compares their total. */
export function basketItemQuantity(rows, name) {
  let total = 0;
  for (const row of rows || []) {
    if (!matchesBasketItem(row, name)) continue;
    const qty = Number(row.qty);
    if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('Basket quantity is unreadable; cannot confirm the add.');
    total += qty;
  }
  if (!Number.isSafeInteger(total)) throw new Error('Basket quantity out of range; cannot confirm the add.');
  return total;
}
