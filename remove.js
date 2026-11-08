// deliveroo remove: remove one basket line, or reduce its quantity.
//
// Uses the page's own controls on the basket sidebar row: "Decrease quantity"
// while qty > 1 (no confirmation), "Remove Item" at qty 1 followed by
// "Remove item" in the confirmation dialog. One line at a time.
// Never touches "Delete all items".
import { cli, Strategy } from '@jackwener/opencli/registry';
import { KILL_OVERLAYS_JS, MODAL_JS, clampLimit, gotoMenu } from './lib.js';
import { basketShopUrl, readBasketDom } from './basket-page.js';

cli({
  site: 'deliveroo',
  name: 'remove',
  access: 'write',
  description: 'Deliveroo remove: remove a dish from the basket, or reduce its quantity',
  domain: 'deliveroo.co.uk',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'item', positional: true, required: true, help: 'Dish name, fuzzy match; stops if more than one line matches' },
    { name: 'restaurant', type: 'string', help: 'Which shop the basket is for; detected from the basket state if omitted' },
    { name: 'qty', type: 'int', default: 0, help: 'Only remove this many (1-10); omit to remove the whole line' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Stop right before clicking Remove Item' },
  ],
  columns: ['status', 'item', 'qty', 'price', 'note'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    const want = String(kwargs.item || '').trim();
    const dryRun = !!kwargs['dry-run'];
    const qtyArg = kwargs.qty ? clampLimit(kwargs.qty, 1, 10) : 0;
    if (!want) throw new Error('Need a dish name.');

    // 1) Which shop. The live state only has a { subtotal: count, url } shadow;
    // the lines are on that shop's menu page sidebar.
    let shopLink = String(kwargs.restaurant || '').trim();
    if (!shopLink) {
      const st = await basketShopUrl(page);
      if (!st.url) {
        throw new Error(
          'Basket unreadable: the page state does not say which shop the basket belongs to' +
          (st.hasRoot ? ` (basket state present, item count=${st.count || '?'}, but no shop link)` : ' (no basket state at all)') +
          '. This does not mean the basket is empty. Retry with --restaurant <slug or menu URL>. Nothing changed.'
        );
      }
      shopLink = st.url;
    }

    // 2) Go to the shop page and identify the line.
    await gotoMenu(page, shopLink);
    await page.evaluate(KILL_OVERLAYS_JS);

    const before = await readBasketDom(page);
    const lines = before.rows || [];
    if (!lines.length) {
      return [{
        status: before.empty ? 'empty basket' : 'unreadable',
        item: '', qty: '', price: '',
        note: before.empty ? 'The basket is empty; nothing to remove.' : 'No basket sidebar on the shop page; it may still be loading or the layout changed. Nothing changed.',
      }];
    }
    const low = want.toLowerCase();
    const exact = lines.filter(r => r.name.toLowerCase() === low);
    const fuzzy = lines.filter(r => r.name.toLowerCase().includes(low));
    const target = exact.length === 1 ? exact[0] : (fuzzy.length === 1 ? fuzzy[0] : null);
    if (!target) {
      if (!fuzzy.length) {
        return [{
          status: 'not in basket',
          item: want, qty: '', price: '',
          note: 'The basket has ' + lines.length + ' line(s): ' + lines.map(r => r.name).join(' / ') + '. Nothing changed.',
        }];
      }
      return fuzzy.slice(0, 8).map(r => ({
        status: 'which one?',
        item: r.name, qty: String(r.qty), price: r.price,
        note: `${fuzzy.length} lines contain "${want}". Not guessing; use a more complete name. Nothing changed.`,
      }));
    }

    const startQty = Number(target.qty) || 1;
    const wantGone = !qtyArg || qtyArg >= startQty;
    const goal = wantGone ? 0 : startQty - qtyArg;   // quantity to end at

    if (dryRun) {
      return [{
        status: 'dry-run (not removed)',
        item: target.name, qty: String(target.qty), price: target.price,
        note: (wantGone
          ? 'Would remove the whole line: "Decrease quantity" down to 1, then "Remove Item", then "Remove item" in the confirmation dialog.'
          : `Would click "Decrease quantity" ${qtyArg} time(s), from x${startQty} to x${goal}.`) +
          ' Drop --dry-run to remove for real.',
      }];
    }

    // 3) One step at a time until the quantity is reached or the line is gone.
    // Capped at 10 clicks: report instead of looping forever.
    let clicks = 0, confirms = 0;
    for (let i = 0; i < 10; i++) {
      const step = await page.evaluate(`
        (() => {
          ${MODAL_JS}
          const name = ${JSON.stringify(target.name)};
          const goal = ${goal};
          const btns = [...document.querySelectorAll('button,[role="button"]')];
          let idx = -1, qty = 0;
          for (let j = 0; j < btns.length; j++) {
            const m = /^Quantity\\s+(\\d+),\\s*(.+?),\\s*£/.exec(btns[j].getAttribute('aria-label') || '');
            if (m && m[1] && m[2].trim() === name) { idx = j; qty = Number(m[1]); break; }
          }
          if (idx === -1) return { gone: true };
          if (qty <= goal) return { done: true, qty };
          // qty > 1 shows "Decrease quantity" (no dialog); qty 1 shows "Remove Item" (dialog).
          const rm = btns.slice(idx + 1, idx + 4).find(b => /^(Remove Item|Decrease quantity)/i.test(b.getAttribute('aria-label') || ''));
          if (!rm) return { gone: false, noButton: true, qty };
          rm.click();
          return { gone: false, clicked: true, qty };
        })()
      `);
      if (step.gone || step.done) break;
      if (step.noButton) {
        throw new Error('No Remove Item / Decrease quantity button on the basket line; Deliveroo may have changed its page. Clicked ' + clicks + ' time(s) so far.');
      }
      clicks++;
      await page.wait(2);
      // Confirmation dialog: only the exact "Remove item" button is clicked.
      const ok = await page.evaluate(`
        (() => {
          ${MODAL_JS}
          const d = __dialog();
          if (!d) return false;
          const btn = __byText(d, /^Remove item$/i)[0];
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      if (ok) confirms++;
      await page.wait(2);
    }

    const after = await readBasketDom(page);
    const still = (after.rows || []).find(r => r.name === target.name) || null;
    const left = still ? Number(still.qty) : 0;
    const okDone = left === goal;
    const rows = (after.rows || []).map(r => ({
      status: '- in basket', item: String(r.name).slice(0, 44), qty: String(r.qty), price: r.price, note: '',
    }));
    rows.unshift({
      status: okDone ? (wantGone ? 'removed' : `reduced to x${left}`) : 'quantity mismatch',
      item: target.name,
      qty: String(left),
      price: still ? still.price : target.price,
      note: (okDone
        ? `x${startQty} -> x${left} | `
        : `Wanted x${startQty} -> x${goal}, now x${left}. Do not retry blindly; check the page. | `) +
        `${clicks} click(s), ${confirms} confirmation(s) | ${(after.rows || []).length} line(s) left${after.empty ? ' (empty)' : ''}`,
    });
    return rows;
  },
});
