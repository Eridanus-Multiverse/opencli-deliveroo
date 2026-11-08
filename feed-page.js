// Each read-only command opens its own fresh document and closes only that tab.
import { FEED_SEED, GUARD_JS, guardPage } from './lib.js';

// Read the live React/Redux store, not __NEXT_DATA__'s stale SSR snapshot.
// Walk only the current fiber tree and stop after 8,000 nodes in case of a redesign.
export const FEED_STATE_JS = `(() => {
  const element = document.getElementById('__next');
  if (!element) return null;
  const key = Object.keys(element).find(k => k.startsWith('__reactContainer$'));
  const container = element[key];
  const root = container?.stateNode?.current || container?.current || container;
  const queue = [root], seen = new Set();
  for (let count = 0; queue.length && count < 8000; count++) {
    const fiber = queue.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const props = fiber.memoizedProps;
    const store = props?.store || props?.value?.store;
    if (typeof store?.getState === 'function') {
      const state = store.getState();
      if (state?.config && state?.location && state?.home) return state;
    }
    if (fiber.sibling) queue.push(fiber.sibling);
    if (fiber.child) queue.push(fiber.child);
  }
  return null;
})()`;

export async function withFeedPage(page, read) {
  const id = await page.newTab(FEED_SEED);
  if (!id) throw new Error('Deliveroo tab was not created; no other tab was read.');
  try {
    page.setActivePage(id);
    for (let i = 0; i < 15; i++) {
      await page.wait(1);
      const status = await page.evaluate(`(() => ({
        guard: ${GUARD_JS},
        ready: location.hostname === 'deliveroo.co.uk' &&
          document.readyState === 'complete' && !!(${FEED_STATE_JS})?.config
      }))()`);
      guardPage(status);
      if (status.ready) return await read();
    }
    throw new Error('Deliveroo page did not finish loading within 15 seconds; try again later.');
  } finally {
    await page.closeTab(id);
  }
}

// Only delivery lookup fields leave the page; street, phone and account stay there.
export const RECENT_ADDRESSES_JS = `(() => {
  const guard = ${GUARD_JS};
  if (guard) return { guard };
  const s = ${FEED_STATE_JS};
  if (!s) return { guard: '', addressError: 'live page state is not ready' };
  if (!((s.config || {}).user || {}).id) return { guard: 'auth' };
  const recent = s.location?.recentAddresses;
  if (recent?.loading) return { guard: '', loading: true };
  if (recent?.error || !Array.isArray(recent?.locations)) {
    return { guard: '', addressError: 'saved addresses failed to load' };
  }
  return { guard: '', loggedIn: true, locations: recent.locations.map(a => ({
    postcode: a.postcode, coordinates: a.coordinates
  })) };
})()`;

export async function readRecentAddresses(page) {
  for (let i = 0; i < 10; i++) {
    const result = await page.evaluate(RECENT_ADDRESSES_JS);
    guardPage(result);
    if (!result.loading) return result;
    await page.wait(1);
  }
  throw new Error('Saved addresses did not load within 10 seconds; try again later.');
}

// Restaurant cards are rendered from DOM blocks; read links, not state objects.
export function readRestaurantCards(document) {
  const seen = new Set(), rows = [];
  for (const a of document.querySelectorAll('a[href*="/menu/"]')) {
    const url = new URL(a.href, 'https://deliveroo.co.uk');
    if (url.origin !== 'https://deliveroo.co.uk' || !url.pathname.startsWith('/menu/')) continue;
    const text = selector => (a.querySelector(selector)?.textContent || '').trim();
    const name = text('[data-testid="partner-name"], h3') || (a.getAttribute('aria-label') || '').split('. ')[0].trim();
    if (!name || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    rows.push({ name, url: url.origin + url.pathname,
      category: text('[data-testid*="cuisine"]'),
      rating: text('[data-testid*="rating"]'),
      fee: text('[data-testid*="delivery-fee"]'),
      eta: text('[data-testid="delivery-time"]'),
    });
    if (rows.length >= 400) break;
  }
  return rows;
}
export const RESTAURANT_CARDS_JS = '(' + readRestaurantCards.toString() + ')(document)';
