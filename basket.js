// deliveroo basket: read-only. Never changes quantities, removes items or checks out.
//
// Line items are not in the state tree (see basket-page.js), so this reads the
// menu page sidebar. "Unreadable" is never reported as "empty": if the shop or
// the sidebar cannot be read, the command fails instead.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { GUARD_JS, KILL_OVERLAYS_JS, gotoMenu, guardPage, money } from './lib.js';
import { FEED_STATE_JS } from './feed-page.js';
import { basketShopUrl, readBasketDom } from './basket-page.js';

cli({
  site: 'deliveroo',
  name: 'basket',
  access: 'read',
  description: 'Deliveroo basket: show the current basket (read-only)',
  domain: 'deliveroo.co.uk',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'restaurant', type: 'string', help: 'Which shop the basket is for (slug or menu URL); detected from the basket state if omitted' },
  ],
  columns: ['index', 'item', 'qty', 'price'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    let shop = String(kwargs.restaurant || '').trim();
    if (!shop) {
      const st = await basketShopUrl(page);
      if (!st.url) {
        throw new Error(
          'Basket unreadable: the page state does not say which shop the basket belongs to' +
          (st.hasRoot ? ` (basket state present, item count=${st.count || '?'}, but no shop link)` : ' (no basket state at all)') +
          '. This does not mean the basket is empty. Retry with --restaurant <slug or menu URL>, or check deliveroo.co.uk yourself.'
        );
      }
      shop = st.url;
    }

    await gotoMenu(page, shop);
    await page.evaluate(KILL_OVERLAYS_JS);
    const data = await readBasketDom(page);

    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      if (data.empty) return [{ index: '', item: 'Basket is empty', qty: '', price: '' }];
      throw new Error(
        'Basket unreadable: opened ' + (data.shop || shop) + ' but the sidebar shows neither items nor an empty basket. ' +
        'The page may still be loading or Deliveroo changed its layout. This does not mean the basket is empty.'
      );
    }

    const out = rows.map((r, i) => ({
      index: i + 1,
      item: String(r.name).slice(0, 52),
      qty: String(r.qty),
      price: r.price,
    }));
    if (data.shop) out.unshift({ index: '', item: `[${data.shop}]`, qty: '', price: '' });

    // The menu page state carries a formatted subtotal; include it when present.
    const sub = await page.evaluate(`
      (() => {
        const guard = ${GUARD_JS};
        if (guard) return { guard };
        const s = ${FEED_STATE_JS};
        return { guard: '', subtotal: String(((((s || {}).basketPage || {}).basket || {}).meta || {}).basket?.subtotalFormatted || '') };
      })()
    `);
    guardPage(sub);
    if (money(sub.subtotal)) out.push({ index: '', item: '- Subtotal -', qty: '', price: money(sub.subtotal) });
    return out;
  },
});
