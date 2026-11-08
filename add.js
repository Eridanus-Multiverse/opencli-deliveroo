// deliveroo add: put one dish in the basket. Never checks out.
//
// Dish names match fuzzily; if two dishes match, both are listed and nothing
// is clicked. If a required option group is unanswered and --option was not
// given, the options are listed and nothing is clicked: never guess a flavour.
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  BASKET_DOM_JS, GUARD_JS, KILL_OVERLAYS_JS, MODAL_JS,
  clampLimit, gotoMenu, guardPage, money,
} from './lib.js';
import { basketItemQuantity, findBasketRow } from './basket-page.js';

// Add is clicked exactly once. Success means the sidebar quantity rose by the
// requested amount; an existing row alone does not prove this add worked.
export async function waitForAddedQuantity(page, name, beforeQty, addedQty) {
  const expectedQty = beforeQty + addedQty;
  let basket, actualQty = beforeQty;
  for (let i = 0; i < 15; i++) {
    await page.wait(1);
    basket = await page.evaluate(BASKET_DOM_JS);
    guardPage(basket);
    actualQty = basketItemQuantity(basket.rows, name);
    if (actualQty === expectedQty) return { basket, actualQty, confirmed: true };
    if (actualQty > expectedQty) break;
  }
  return { basket, actualQty, confirmed: false };
}

cli({
  site: 'deliveroo',
  name: 'add',
  access: 'write',
  description: 'Deliveroo add: add one dish to the basket (does not order)',
  domain: 'deliveroo.co.uk',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'restaurant', positional: true, required: true, help: 'Restaurant slug or menu page URL (as for menu)' },
    { name: 'item', positional: true, required: true, help: 'Dish name, fuzzy match; stops if more than one dish matches' },
    { name: 'qty', type: 'int', default: 1, help: 'Quantity (1-10)' },
    { name: 'option', type: 'string', help: 'Required options separated by |, e.g. --option "Large | Extra cheese"' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Stop right before clicking Add and report what would be added' },
  ],
  columns: ['status', 'item', 'qty', 'price', 'note'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    const qty = clampLimit(kwargs.qty, 1, 10);
    const want = String(kwargs.item || '').trim();
    const dryRun = !!kwargs['dry-run'];
    const wantOptions = String(kwargs.option || '').split('|').map(s => s.trim()).filter(Boolean);
    if (!want) throw new Error('Need a dish name.');

    await gotoMenu(page, kwargs.restaurant);
    await page.evaluate(KILL_OVERLAYS_JS);

    // 1) Find the dish. Dish cards are [role=button][aria-label="Name, description, £x"].
    const found = await page.evaluate(`
      (() => {
        const guard = ${GUARD_JS};
        if (guard) return { guard };
        const want = ${JSON.stringify(want.toLowerCase())};
        const cards = document.querySelectorAll('[role="button"][aria-label]');
        const hits = [];
        for (let i = 0; i < cards.length; i++) {
          const label = cards[i].getAttribute('aria-label') || '';
          const name = label.split(',')[0].trim();
          if (!name) continue;
          const low = name.toLowerCase();
          if (low === want) hits.push({ name, exact: true, price: (label.match(/£[\\d.]+\\s*$/) || [''])[0].trim() });
          else if (low.includes(want)) hits.push({ name, exact: false, price: (label.match(/£[\\d.]+\\s*$/) || [''])[0].trim() });
        }
        const seen = new Set(), uniq = [];
        for (const h of hits) { if (seen.has(h.name)) continue; seen.add(h.name); uniq.push(h); }
        return { guard: '', hits: uniq, scanned: cards.length };
      })()
    `);
    guardPage(found);

    const hits = Array.isArray(found.hits) ? found.hits : [];
    if (!hits.length) {
      return [{
        status: 'not found',
        item: want,
        qty: '', price: '',
        note: `No dish on this menu contains "${want}" (scanned ${found.scanned} cards). Try: opencli deliveroo menu <restaurant>.`,
      }];
    }
    const exact = hits.filter(h => h.exact);
    const picked = exact.length === 1 ? exact[0] : (hits.length === 1 ? hits[0] : null);
    if (!picked) {
      return hits.slice(0, 8).map(h => ({
        status: 'which one?',
        item: h.name,
        qty: '', price: h.price,
        note: `${hits.length} dishes contain "${want}". Not guessing; use a more complete name.`,
      }));
    }

    // 2) Open the dish dialog.
    const opened = await page.evaluate(`
      (() => {
        ${MODAL_JS}
        const name = ${JSON.stringify(picked.name)};
        const cards = document.querySelectorAll('[role="button"][aria-label]');
        for (let i = 0; i < cards.length; i++) {
          if ((cards[i].getAttribute('aria-label') || '').split(',')[0].trim() === name) { cards[i].click(); return true; }
        }
        return false;
      })()
    `);
    if (!opened) throw new Error('The dish card disappeared before it could be opened; the page is changing, try again.');
    // In a background tab React can take several seconds to render the dialog;
    // a fixed wait misses it. Poll for up to 12 seconds.
    for (let i = 0; i < 12; i++) {
      await page.wait(1);
      const up = await page.evaluate(`
        (() => {
          ${MODAL_JS}
          const guard = ${GUARD_JS};
          if (guard) return { guard };
          const d = __dialog();
          return { guard: '', modal: !!d && __byText(d, /^Add\\b/).length > 0 };
        })()
      `);
      guardPage(up);
      if (up.modal) break;
    }
    await page.evaluate(KILL_OVERLAYS_JS);

    // 3) Options. Click one, wait for re-render, then look for the next: picking a
    // meal deal can add new required groups, and clicking several in one frame
    // hits rows React has already replaced, so only the last click takes effect.
    const applied = { modal: true, missed: [] };
    if (!wantOptions.length) {
      applied.modal = await page.evaluate(`(() => { ${MODAL_JS} return !!__dialog(); })()`).then(r => r === true || !!(r && r.modal));
    }
    for (const w of wantOptions.map(s => s.toLowerCase())) {
      const r = await page.evaluate(`
        (() => {
          ${MODAL_JS}
          const d = __dialog();
          if (!d) return { modal: false };
          const w = ${JSON.stringify(w)};
          const groups = __groups(d);
          let hit = null;
          for (const exact of [true, false]) {
            for (const g of groups) {
              for (let i = 0; i < g.rows.length; i++) {
                const o = g.options[i].toLowerCase();
                if (exact ? o === w || o.split('\\n')[0].trim() === w : o.includes(w)) { hit = g.rows[i]; break; }
              }
              if (hit) break;
            }
            if (hit) break;
          }
          if (!hit) return { modal: true, hit: false };
          hit.click();
          return { modal: true, hit: true };
        })()
      `);
      if (!r.modal) { applied.modal = false; break; }
      if (!r.hit) applied.missed.push(w);
      await page.wait(1);
    }
    if (!applied.modal) throw new Error('The dish dialog did not open; Deliveroo may have changed its page.');
    if (applied.missed && applied.missed.length) {
      throw new Error('Option(s) "' + applied.missed.join('", "') + '" not found for this dish. Run without --option to list the choices.');
    }
    await page.wait(2);

    const state = await page.evaluate(`
      (() => {
        ${MODAL_JS}
        const d = __dialog();
        const groups = __groups(d).map(g => ({ title: g.title, required: g.required, checked: g.checked, options: g.options }));
        const cands = __byText(d, /^Add\\b/);
        const addBtn = cands.find(b => /to (basket|order)/i.test(b.innerText || "")) || cands[cands.length - 1] || null;
        return {
          name: (d.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)[0] || '',
          addText: addBtn ? (addBtn.innerText || '').trim() : '',
          groups,
        };
      })()
    `);

    const unmet = (state.groups || []).filter(g => g.required && !g.checked);
    if (unmet.length) {
      const rows = [{
        status: 'needs options',
        item: picked.name,
        qty: String(qty),
        price: '',
        note: `${unmet.length} required option group(s) unanswered; nothing added. Retry with --option "A | B".`,
      }];
      for (const g of unmet) {
        rows.push({
          status: '- required',
          item: g.title,
          qty: '', price: '',
          note: g.options.slice(0, 12).join(' / ') + (g.options.length > 12 ? ` ... ${g.options.length} in total` : ''),
        });
      }
      return rows;
    }

    // 4) Quantity.
    if (qty > 1) {
      await page.evaluate(`
        (() => {
          ${MODAL_JS}
          const d = __dialog();
          const inc = [...d.querySelectorAll('button')].find(b => /Increase quantity/i.test(b.getAttribute('aria-label') || ''));
          if (!inc) return false;
          for (let i = 1; i < ${qty}; i++) inc.click();
          return true;
        })()
      `);
      await page.wait(1);
    }

    // 5) Dry run stops here.
    if (dryRun) {
      await page.evaluate(`
        (() => {
          ${MODAL_JS}
          const d = __dialog();
          const close = [...d.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === 'Close');
          if (close) close.click();
          return true;
        })()
      `);
      const cart = await page.evaluate(BASKET_DOM_JS);
      guardPage(cart);
      const already = findBasketRow(cart.rows, picked.name);
      return [{
        status: 'dry-run (not added)',
        item: picked.name,
        qty: String(qty),
        price: money(picked.price),
        note: `Would click "${state.addText || 'Add'}". ` +
          (already ? `Note: basket already has x${already.qty} (${already.name}). ` : '') +
          'Drop --dry-run to add for real.',
      }];
    }

    // 6) Add to basket.
    const beforeAdd = await page.evaluate(BASKET_DOM_JS);
    guardPage(beforeAdd);
    if (!(beforeAdd.rows || []).length && !beforeAdd.empty) {
      throw new Error('Basket unreadable before adding, so the quantity change cannot be verified. Add was not clicked.');
    }
    const beforeQty = basketItemQuantity(beforeAdd.rows, picked.name);
    const clicked = await page.evaluate(`
      (() => {
        ${MODAL_JS}
        const d = __dialog();
        // Topping rows inside the dialog are also labelled "Add"; the first match
        // would be wrong. The footer button with "to basket"/price is the real one.
        const cands = __byText(d, /^Add\\b/);
        const btn = cands.find(b => /to (basket|order)/i.test(b.innerText || "")) || cands[cands.length - 1];
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('No Add button in the dish dialog; Deliveroo may have changed its page. Nothing added.');
    const { basket, actualQty, confirmed } = await waitForAddedQuantity(page, picked.name, beforeQty, qty);
    const rows = (basket.rows || []).map(r => ({
      status: '- in basket',
      item: String(r.name).slice(0, 44),
      qty: String(r.qty),
      price: r.price,
      note: '',
    }));
    rows.unshift({
      status: confirmed ? 'added' : 'unconfirmed',
      item: picked.name,
      qty: String(qty),
      price: money(picked.price),
      note: confirmed
        ? `${basket.shop || 'shop'} | this dish across options: x${actualQty} (was x${beforeQty}, +${qty}) | ${basket.rows.length} basket rows`
        : `Add was clicked once, but the quantity did not go from x${beforeQty} to x${beforeQty + qty} (now x${actualQty}). It may still have worked; do not add again, check with: opencli deliveroo basket`,
    });
    return rows;
  },
});
