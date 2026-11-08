// deliveroo menu: read-only. Category / dish / price / short description / item id.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { GUARD_JS, WALK_JS, clampLimit, gotoMenu, guardPage, money, scrubUrl } from './lib.js';
import { FEED_STATE_JS as STATE_JS, withFeedPage } from './feed-page.js';

cli({
  site: 'deliveroo',
  name: 'menu',
  access: 'read',
  description: 'Deliveroo menu: list a restaurant\'s dishes (read-only)',
  domain: 'deliveroo.co.uk',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'restaurant', positional: true, required: true, help: 'Restaurant slug or menu page URL' },
    { name: 'q', type: 'string', help: 'Only dishes whose name or description contains this' },
    { name: 'limit', type: 'int', default: 40, help: 'Max items' },
  ],
  columns: ['category', 'item', 'price', 'id', 'desc'],
  navigateBefore: false,
  func: async (page, kwargs) => withFeedPage(page, async () => {
    const limit = clampLimit(kwargs.limit, 40, 120);
    const q = String(kwargs.q || '').trim().toLowerCase();

    await gotoMenu(page, kwargs.restaurant);

    const data = await page.evaluate(`
      (() => {
        const guard = ${GUARD_JS};
        if (guard) return { guard };
        ${WALK_JS}
        const s = ${STATE_JS};
        const mp = (s.menuPage || {}).menu || {};

        // Looks like a dish: has a name and a price (categories have no price).
        const isItem = (o) => typeof o.name === 'string' && o.name.length > 0 && o.name.length < 160
          && (o.price !== undefined || o.priceFractional !== undefined || o.formattedPrice !== undefined);
        const cands = __walk(mp, isItem, 800);

        // Category: a name plus an items/children array; used to label dishes.
        const catOf = new Map();
        const isCat = (o) => typeof o.name === 'string'
          && (Array.isArray(o.items) || Array.isArray(o.menuItems) || Array.isArray(o.children));
        for (const c of __walk(mp, isCat, 200)) {
          for (const it of (c.items || c.menuItems || c.children || [])) {
            if (it && typeof it === 'object') catOf.set(it, c.name);
          }
        }

        const seen = new Set(), out = [];
        for (const it of cands) {
          const id = String(it.id || it.itemId || it.uname || it.drnId || '');
          const key = id || (it.name + '|' + JSON.stringify(it.price || ''));
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            category: catOf.get(it) || it.categoryName || '',
            name: it.name,
            price: it.formattedPrice || it.price || it.priceFractional || '',
            id,
            desc: String(it.description || it.desc || it.subtitle || '').replace(/\\s+/g, ' ').trim(),
          });
        }
        const rest = mp.restaurant || mp.meta || {};
        return {
          guard: '', rows: out, scanned: cands.length,
          shop: rest.name || (s.menuPage && s.menuPage.menu && s.menuPage.menu.name) || '',
          href: location.href,
        };
      })()
    `);
    guardPage(data);

    let rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      return [{
        category: '',
        item: `No dishes found (scanned ${data.scanned} candidates). The restaurant may not exist or be closed, or Deliveroo changed its page.`,
        // The landing URL may have been redirected with location params; scrub them first.
        price: '', id: '', desc: scrubUrl(data.href),
      }];
    }

    // Zero matches means zero matches: never fall back to the full menu.
    const total = rows.length;
    if (q) {
      rows = rows.filter(r =>
        String(r.name).toLowerCase().includes(q) || String(r.desc).toLowerCase().includes(q));
      if (!rows.length) {
        return [{
          category: '',
          item: `- No dish name or description contains "${String(kwargs.q).trim().slice(0, 40)}" (${total} dishes on this menu) -`,
          price: '', id: '', desc: '',
        }];
      }
    }

    const out = rows.slice(0, limit).map(r => ({
      category: String(r.category).slice(0, 22),
      item: String(r.name).slice(0, 46),
      price: money(r.price),
      id: String(r.id).slice(0, 24),
      desc: r.desc.slice(0, 60),
    }));
    out.push({
      category: '',
      item: `- ${data.shop || 'This restaurant'}: ${rows.length} dishes${rows.length > limit ? ' (showing first ' + limit + ')' : ''} -`,
      price: '', id: '', desc: '',
    });
    return out;
  }),
});
