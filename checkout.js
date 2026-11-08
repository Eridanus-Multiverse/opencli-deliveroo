// deliveroo checkout
//
//   opencli deliveroo checkout                    preview (default): read the order, click nothing
//                                                 that changes the account, print a one-time code
//   opencli deliveroo checkout --confirm <code>   place exactly one order (irreversible)
//   ... --confirm <code> --dry-run                run every gate, stop before Pay now, keep the code
//
// A saved payment method can be a one-click charge: nothing stands between
// Pay now and the money leaving. So the gates live here, and Pay now is
// pressed once and never retried. If the press happened but no order page
// appeared, an order may exist: pressing again risks paying twice, while
// stopping only costs a look at the orders page. Always stop.
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  ADDRESS_UNREADABLE, GUARD_JS, KILL_OVERLAYS_JS, MODAL_JS, PREVIEW_MAX_AGE_MS,
  basketFingerprint, fmtPence, gotoMenu, guardPage, maskAddress, maxTotalPence, pence, scrubUrl,
} from './lib.js';
import { basketShopUrl } from './basket-page.js';
import { checkCode, claimCode, issueCode, loadPending, verifyConfirm } from './confirm.js';

// Identity checks during payment are handed back to the user, never treated as a loading page.
export const PAYMENT_GUARD_JS = `(() => {
  const guard = ${GUARD_JS}; if (guard) return guard;
  const t = String(document.title || '') + ' ' + ((document.body && document.body.innerText) || '');
  if (/paypal\\.com\\/(?:[^?#]*\\/)?(?:signin|login|auth)(?:[/?#]|$)/i.test(location.href)) return 'verification';
  if ([...document.querySelectorAll('input[type=\"password\"],input[autocomplete=\"one-time-code\"]')].some(e => e.getClientRects().length > 0)) return 'verification';
  if (/3[- ]?D Secure|3DS|verify your identity|verification code|one[- ]time (?:code|password)|log in to paypal|sign in to paypal/i.test(t)) return 'verification';
  if (document.querySelector('iframe[src*="3ds" i],iframe[src*="cardinal" i],iframe[title*="authentication" i]')) return 'verification';
  return '';
})()`;
function guardPayment(state) {
  if (state?.guard === 'verification') throw new Error('A payment login, 3DS or identity check appeared. Stopped; finish it yourself in the browser. Payment is not retried.');
  guardPage(state);
}

// A payment must not use BasePage.pressKey: an incomplete synthetic Enter does
// not activate HTML buttons, and its catch/fallback can repeat an uncertain action.
export async function dispatchCheckoutEnter(page) {
  if (typeof page.cdp !== 'function') throw new Error('Native key channel unavailable; no payment was sent.');
  await page.cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await page.cdp('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
}

export async function withCheckoutTiming(phase, operation) {
  const started = Date.now(); let outcome = 'error';
  try { const result = await operation(); outcome = 'ok'; return result; }
  finally { process.stderr.write('[deliveroo-timing] ' + JSON.stringify({phase, elapsed_ms:Date.now()-started, outcome}) + '\n'); }
}

// Pay now only renders after the checkout sections are scrolled into view.
// Scroll page-side with a guard before every step; no clicks. An already-ready
// button needs no scrolling.
export async function revealPaymentAction(page) {
  return withCheckoutTiming('payment_ready', async () => {
    const result = await page.evaluate(`(async () => {
      const guard = ${PAYMENT_GUARD_JS}; if (guard) return {guard};
      const sections = [...document.querySelectorAll('[data-section-id]')];
      if (sections.length > 30) return {guard:'', tooMany:true};
      const ready = () => { const b = document.querySelector('#place-order-button'); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.getClientRects().length > 0; };
      if (ready()) return {guard:'', scrolled:0};
      let scrolled = 0;
      for (const section of sections) {
        const guard = ${PAYMENT_GUARD_JS}; if (guard) return {guard};
        section.scrollIntoView({behavior:'instant',block:'center'}); scrolled++;
        await new Promise(r => setTimeout(r, 250));
        if (ready()) break;
      }
      await new Promise(r => setTimeout(r, 500));
      return {guard:${PAYMENT_GUARD_JS}, scrolled};
    })()`);
    guardPayment(result);
    if (result.tooMany) throw new Error('Unexpected number of checkout sections. Code not consumed, nothing paid.');
  });
}

// The original cost is an explicitly marked, aria-hidden offer reference price.
// Every remaining character must be the Pay now label and one current amount.
export function readPayNowButton(button) {
  if (!button) return { error: 'PAY_NOW_MISSING' };
  const originals = [...button.querySelectorAll('[data-testid="pay-now-original-cost"]')];
  if (originals.length > 1 || originals.some(e => e.getAttribute('aria-hidden') !== 'true')) return { error: 'PAY_NOW_ORIGINAL_AMBIGUOUS' };
  const originalAmount = originals.length ? (originals[0].textContent || '').trim() : '';
  if (originals.length && !/^£\d+(?:,\d{3})*\.\d{2}$/.test(originalAmount)) return { error: 'PAY_NOW_ORIGINAL_INVALID' };
  const clone = button.cloneNode(true);
  for (const e of clone.querySelectorAll('[data-testid="pay-now-original-cost"]')) e.remove();
  if ([...clone.querySelectorAll('[hidden],[aria-hidden="true"],del,s')].some(e => /£/.test(e.textContent || ''))) return { error: 'PAY_NOW_CURRENT_HIDDEN' };
  const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/^Pay now\s*(£\d+(?:,\d{3})*\.\d{2})$/i);
  if (!match) return { error: 'PAY_NOW_CURRENT_AMBIGUOUS' };
  const amount = match[1];
  if (originalAmount && Number(originalAmount.replace(/[£,]/g, '')) < Number(amount.replace(/[£,]/g, ''))) return { error: 'PAY_NOW_DISCOUNT_INVALID' };
  return { label: 'Pay now ' + amount, amount, originalAmount, error: '' };
}

/** Read the checkout page into a structured order. No class names; only aria, button text and row labels. */
export const CHECKOUT_READ_JS = `
  (() => {
    const guard = ${PAYMENT_GUARD_JS};
    if (guard) return { guard };
    ${MODAL_JS}
    const txt = (el) => ((el && el.innerText) || '').trim();
    const leaves = () => document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div,strong,label');

    // The block under a heading: climb from the heading leaf to the first ancestor with more than the heading.
    function section(title) {
      const all = leaves();
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (e.children.length) continue;
        if ((e.textContent || '').trim() !== title) continue;
        let g = e;
        for (let k = 0; k < 7 && g && g.parentElement; k++) {
          g = g.parentElement;
          if (txt(g).length > title.length + 8) return g;
        }
      }
      return null;
    }

    // Basket li elements are the real rows; items, fees and the membership total picker must not be mixed up.
    const card = document.querySelector('section[aria-label="Basket"]');
    if (!card) return { guard: '', checkoutError: 'BASKET_NOT_FOUND' };
    const items = [], fees = {}, other = [], parseErrors = [];
    const known = new Map([
      ['subtotal', 'subtotal'], ['delivery fee', 'delivery'], ['small order fee', 'small_order'],
      ['service fee', 'service'], ['bag charge', 'bag'], ['tip', 'tip'], ['rider tip', 'tip'],
      ['donation', 'charity'], ['charity', 'charity'], ['total', 'total'],
    ]);
    for (const line of card.querySelectorAll('li')) {
      if (line.parentElement.closest('li')) continue;
      const picker = line.querySelector('[data-testid="plus-checkout-radio-picker"]');
      if (picker) {
        const selected = picker.querySelectorAll('[role="radio"][aria-checked="true"]');
        const prices = selected.length === 1 ? selected[0].querySelectorAll('[data-testid$="-price-text"]') : [];
        if (prices.length !== 1 || !/^-?£[\\d.,]+$/.test(txt(prices[0]))) parseErrors.push('SELECTED_TOTAL_AMBIGUOUS');
        else fees.total = txt(prices[0]);
        continue;
      }
      // Discounted rows show a struck-through original next to the current price; struck prices are not paid.
      const struckOut = (e) => { for (let g = e; g && g !== line; g = g.parentElement) if (/^(S|DEL|STRIKE)$/.test(g.tagName) || /line-through/.test(getComputedStyle(g).textDecorationLine)) return true; return false; };
      const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const struck = [...line.querySelectorAll('*')].filter(e => !e.children.length && shown(e) && /^-?£[\\d.,]+$/.test(txt(e)) && struckOut(e)).map(txt);
      // Adjacent original and current spans read as "£6.00£5.00"; split rows made only of amounts.
      const raw = txt(line).split('\\n').map(s => s.trim()).filter(Boolean)
        .flatMap(s => /^(?:-?£[\\d.,]+\\s*){2,}$/.test(s) ? s.match(/-?£[\\d.,]+/g) : [s]);
      const parts = raw.filter(s => { const i = struck.indexOf(s); if (i < 0) return true; struck.splice(i, 1); return false; });
      const amounts = parts.filter(s => /^-?£[\\d.,]+$/.test(s));
      if (amounts.length !== 1) {
        if (raw.some(s => /£/.test(s))) parseErrors.push('MONEY_ROW_AMBIGUOUS');
        continue;
      }
      const qty = /^(\\d+)\\s*x$/i.exec(parts[0] || '');
      if (qty) {
        items.push({ qty: Number(qty[1]), name: parts.slice(1).filter(s => s !== amounts[0]).join(' '), price: amounts[0] });
        continue;
      }
      // "Total saved (-£1.00)" inside the subtotal row is a note, not a price or fee name.
      const label = parts.filter(s => s !== amounts[0] && !/^Total saved \\(-?£[\\d.,]+\\)$/i.test(s)).join(' ');
      const key = known.get(label.toLowerCase());
      if (key) { if (fees[key] !== undefined) parseErrors.push('DUPLICATE_FEE'); fees[key] = amounts[0]; }
      else { other.push({ label, amount: amounts[0] }); parseErrors.push('UNKNOWN_FEE'); }
    }

    // Delivery option: the row containing the checked radio.
    let fulfilment = '', eta = '';
    {
      const sec = section('Delivery options');
      if (sec) {
        const checked = sec.querySelector('input:checked');
        let g = checked;
        for (let k = 0; k < 6 && g; k++) {
          const parts = txt(g).split('\\n').map(s => s.trim()).filter(Boolean);
          if (parts.length >= 2) { fulfilment = parts[0]; eta = parts[1]; break; }
          g = g.parentElement;
        }
      }
    }

    // Address: phone lines are dropped inside the page; no digits reach Node.
    let addressLines = [];
    {
      const sec = section('Delivery address');
      if (sec) {
        addressLines = txt(sec).split('\\n').map(s => s.trim()).filter(Boolean)
          .filter(s => !/^(Delivery address|Change|Edit)$/i.test(s))
          .filter(s => !/^(\\+|00)?[\\d][\\d\\s()+-]{6,}$/.test(s));
      }
    }

    // Payment method: first non-heading text in the "Pay with" block.
    let payment = '';
    {
      const sec = section('Pay with');
      if (sec) {
        const parts = txt(sec).split('\\n').map(s => s.trim()).filter(Boolean)
          .filter(s => !/^(Pay with|Change|Delete|Try another way to pay|Add)$/i.test(s));
        const checked = sec.querySelector('input:checked');
        if (checked) {
          let g = checked;
          for (let k = 0; k < 6 && g; k++) {
            const t = txt(g).split('\\n').map(s => s.trim()).filter(Boolean)[0] || '';
            if (t && !/^Pay with$/i.test(t)) { payment = t; break; }
            g = g.parentElement;
          }
        }
        if (!payment) payment = parts[0] || '';
      }
    }

    // The full-width button at the bottom.
    let payNowText = '', payNowAmount = '', payNowOriginalAmount = '', payNowParseError = '', paymentAction = '', payNowReady = false;
    const continueButton = __byText(document.body, /^Continue$/i)[0];
    if (continueButton) paymentAction = 'Continue';
    {
      const b = document.querySelector('#place-order-button');
      if (b) {
        const price = (${readPayNowButton.toString()})(b);
        payNowText = price.label || '';
        payNowAmount = price.amount || '';
        payNowOriginalAmount = price.originalAmount || '';
        payNowParseError = price.error;
        paymentAction = 'Pay now';
        payNowReady = !price.error && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.getClientRects().length > 0;
      }
    }

    const h1 = [...document.querySelectorAll('h1,h2,h3')].find(e => /^Review your order from/i.test(txt(e)));
    const shop = ((h1 && h1.innerText) || '').replace(/^Review your order from\\s*/i, '').trim();

    return {
      guard: '', shop, items, fees, other, parseErrors, fulfilment, eta, addressLines, payment,
      payNowText, payNowAmount, payNowOriginalAmount, payNowParseError, paymentAction, payNowReady, href: location.href,
      onCheckout: /checkout/i.test(location.href),
    };
  })()
`;

/**
 * Read the checkout page and reconcile it to the penny. Unreadable rows,
 * unknown fees, totals that do not add up or a missing payment method all stop here.
 */
export async function readCheckout(page) {
  const c = await page.evaluate(CHECKOUT_READ_JS);
  guardPayment(c);

  const stop = (why) => { throw new Error(why + ' Nothing was ordered or paid.'); };
  if (c.checkoutError || (c.parseErrors || []).length) stop('Checkout amount rows could not be read reliably: ' + (c.checkoutError || c.parseErrors.join(',')) + ((c.other || []).length ? ' (unrecognised rows: ' + c.other.map(o => o.label + ' ' + o.amount).join('; ') + ')' : '') + '.');
  if (c.payNowParseError) stop('The Pay now amount could not be read reliably: ' + c.payNowParseError + '.');
  const totalPence = pence(c.fees.total);
  const payNowPence = pence(c.payNowAmount);
  const tipPence = c.fees.tip === undefined ? null : pence(c.fees.tip);
  const charityPence = c.fees.charity === undefined ? null : pence(c.fees.charity);
  const address = maskAddress((c.addressLines || []).join('\n'));
  if (address === ADDRESS_UNREADABLE) stop('The delivery address could not be read reliably.');
  const fingerprint = basketFingerprint(c.shop, c.items || []);

  if (totalPence === null) stop('No Total found on the checkout page; Deliveroo may have changed its page.');
  if (!c.shop || !(c.items || []).length) stop('Shop name or items are missing on the checkout page.');
  const subtotal = pence(c.fees.subtotal);
  const lineAmounts = c.items.map(i => pence(i.price));
  if (subtotal === null || lineAmounts.some(v => v === null) || lineAmounts.reduce((a,b) => a+b,0) !== subtotal) {
    stop('Item rows do not add up to the Subtotal; unit prices are never guessed.');
  }
  if (c.fees.delivery === undefined || c.fees.service === undefined) stop('Delivery or service fee is missing; an unknown fee is never treated as zero.');
  const extra = Object.entries(c.fees).filter(([k]) => !['subtotal','total'].includes(k)).map(([,v]) => pence(v));
  if ((c.other || []).length || extra.some(v => v === null) || subtotal + extra.reduce((a,b) => a+b,0) !== totalPence) {
    stop('Subtotal plus fees does not equal the selected Total, or there is an unknown fee.');
  }
  if (payNowPence !== null && totalPence !== payNowPence) stop('Page Total (' + fmtPence(totalPence) + ') and Pay now (' + fmtPence(payNowPence) + ') differ.');
  if (!['Continue','Pay now'].includes(c.paymentAction || (c.payNowText ? 'Pay now' : ''))) stop('No payment action found on the page.');
  if (!String(c.payment || '').trim()) stop('The selected payment method could not be read.');

  const snapshot = {
    at: new Date().toISOString(),
    shop: c.shop,
    items: (c.items || []).map(i => ({ qty: i.qty, name: i.name, price: i.price })),
    fees: {
      subtotal: c.fees.subtotal || '', delivery: c.fees.delivery || '',
      small_order: c.fees.small_order || '', service: c.fees.service || '', bag: c.fees.bag || '',
      tip: c.fees.tip || '£0.00', charity: c.fees.charity || '£0.00',
      total: c.fees.total || '',
    },
    other: c.other || [],
    total_pence: totalPence,
    pay_now: c.payNowText,
    payment_action: c.paymentAction || 'Pay now',
    fulfilment: c.fulfilment, eta: c.eta,
    address, payment: c.payment,
    fingerprint,
    url: scrubUrl(c.href),
  };

  return { c, snapshot, totalPence, tipPence, charityPence, address };
}

export async function gotoCheckout(page) {
  // A JS click on "Go to checkout" sometimes does not navigate, so focus it and
  // send a real Enter. Navigation is idempotent, so a second attempt (click) is
  // harmless here, unlike Pay now. The sidebar button renders a few seconds
  // after the menu; wait up to 20 seconds for it.
  for (let i = 0; i < 10; i++) {
    const status = await page.evaluate(`(() => { const guard = ${GUARD_JS}; if (guard) return { guard }; ${MODAL_JS} return { guard: '', has: !!__byText(document.body, /Go to checkout/i)[0] }; })()`);
    guardPage(status);
    if (status.has) break;
    await page.wait(2);
  }
  let onCheckout = false;
  for (const how of ['enter', 'click']) {
    const armed = await page.evaluate(`
      (() => {
        const guard = ${GUARD_JS};
        if (guard) return { guard };
        ${MODAL_JS}
        const b = __byText(document.body, /Go to checkout/i)[0];
        if (!b) return { guard: '', armed: false };
        b.scrollIntoView({ block: 'center' });
        b.focus();
        ${how === 'click' ? 'b.click();' : ''}
        return { guard: '', armed: true };
      })()
    `);
    guardPage(armed);
    if (!armed.armed) throw new Error('No "Go to checkout" button on the page; the basket may be empty or Deliveroo changed its page. Nothing clicked.');
    if (how === 'enter') await dispatchCheckoutEnter(page);
    // Wait for navigation, guarding every poll; login or a bot wall stops immediately.
    for (let i = 0; i < 30; i++) {
      await page.wait(2);
      const st = await page.evaluate(`
        (() => {
          const guard = ${GUARD_JS};
          if (guard) return { guard };
          ${MODAL_JS}
          if (/checkout/i.test(location.href)) return { guard: '', on: true };
          // The sidebar button first opens a "Fancy anything else?" upsell dialog
          // with its own Go to checkout; until that one is pressed the URL stays on
          // the menu. Press only that button, never the upsell rows.
          const d = document.querySelector('[role="dialog"]');
          const inner = d ? __byText(d, /Go to checkout/i)[0] : null;
          if (inner) inner.click();
          return { guard: '', on: false, upsell: !!inner };
        })()
      `);
      guardPage(st);
      onCheckout = !!st.on;
      if (onCheckout) break;
    }
    if (onCheckout) break;
  }
  if (!onCheckout) throw new Error('Pressed "Go to checkout" but the checkout page did not open. Nothing was paid; check the browser.');
}

cli({
  site: 'deliveroo',
  name: 'checkout',
  access: 'write',
  description: 'Deliveroo checkout: preview by default; --confirm <code> places exactly one order (irreversible)',
  domain: 'deliveroo.co.uk',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'preview', type: 'bool', default: false, help: 'Read the order and print a one-time confirm code (default when --confirm is absent)' },
    { name: 'confirm', type: 'string', help: 'Confirm code from the latest preview. Places one real order and charges you' },
    { name: 'restaurant', type: 'string', help: 'Which shop the basket is for; detected from the basket state if omitted' },
    { name: 'dry-run', type: 'bool', default: false, help: 'With --confirm: run every gate, stop before Pay now, keep the code' },
  ],
  columns: ['field', 'value', 'note'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    const code = String(kwargs.confirm || '').trim();
    const place = !!code;
    const dryRun = !!kwargs['dry-run'];
    if (place && kwargs.preview) throw new Error('Use either --preview or --confirm <code>, not both.');

    // Gate 1 before touching the browser: a matching, unexpired code and a sane cap.
    let pending = null, capPence = null;
    if (place) {
      capPence = maxTotalPence();
      pending = loadPending();
      checkCode({ pending, code, now: Date.now() });
    }

    // Go to the checkout page.
    let shopLink = String(kwargs.restaurant || '').trim();
    if (!shopLink) {
      // The live state only knows the shop link; the items are read on the checkout page.
      const shop = await basketShopUrl(page);
      if (!shop.url) {
        if (shop.count === '0') return [{ field: 'basket', value: 'empty', note: 'Nothing to check out.' }];
        throw new Error('Cannot tell which shop the basket belongs to (state says ' + shop.count + ' item(s) but no shop link). This is not an empty basket; retry with --restaurant. Nothing clicked.');
      }
      shopLink = shop.url;
    }

    await withCheckoutTiming('navigation', async () => {
      await gotoMenu(page, shopLink);
      await page.evaluate(KILL_OVERLAYS_JS);
      await gotoCheckout(page);
      await page.wait(3);
    });
    await page.evaluate(KILL_OVERLAYS_JS);
    if (!place) await revealPaymentAction(page);
    const { c, snapshot, totalPence, tipPence, charityPence, address } = await readCheckout(page);
    if (!place && (c.paymentAction !== 'Pay now' || pence(c.payNowAmount) === null)) throw new Error('The Pay now amount is not ready yet, so no confirm code was issued. Nothing was ordered or paid.');

    const humanRows = [
      { field: 'shop', value: c.shop || '(unreadable)', note: c.fulfilment ? c.fulfilment + (c.eta ? ' · ' + c.eta : '') : '' },
      ...(c.items || []).map(i => ({ field: 'item', value: i.qty + 'x ' + i.name, note: i.price })),
      { field: 'subtotal', value: c.fees.subtotal || '(none)', note: '' },
      { field: 'delivery', value: c.fees.delivery || '(none)', note: '' },
      { field: 'small order', value: c.fees.small_order || '(none)', note: '' },
      { field: 'service', value: c.fees.service || '(none)', note: '' },
      ...(c.fees.bag ? [{ field: 'bag', value: c.fees.bag, note: '' }] : []),
      { field: 'tip', value: c.fees.tip || '£0.00', note: 'must be £0.00' },
      { field: 'donation', value: c.fees.charity || '£0.00', note: 'must be £0.00' },
      { field: 'total', value: fmtPence(totalPence), note: 'selected Total, reconciled to the penny with items and fees' },
      { field: 'deliver to', value: address, note: '' },
      { field: 'payment', value: c.payment, note: 'login, 3DS or captcha stops immediately' },
    ];

    // Preview: save the snapshot with a fresh code. Nothing on the account was clicked.
    if (!place) {
      const issued = issueCode(snapshot);
      return humanRows.concat([{
        field: 'confirm code',
        value: issued,
        note: 'valid ' + (PREVIEW_MAX_AGE_MS / 60000) + ' minutes, one order: opencli deliveroo checkout --confirm ' + issued,
      }]);
    }

    // Confirm: every gate against this read of the page.
    verifyConfirm({ pending, code, live: snapshot, tipPence, charityPence, capPence });

    if (dryRun) {
      return humanRows.concat([{
        field: 'gates',
        value: 'all passed',
        note: 'dry-run: payment area not revealed, Pay now not pressed, code not consumed',
      }]);
    }

    // Finish all browser preparation first; the final recheck and the claim sit
    // right next to the payment keypress. Claiming and paying cannot be one
    // atomic step, so after the claim the code is gone whatever happens.
    await revealPaymentAction(page);
    const fresh = await readCheckout(page); // re-read: a fee that changed just now must still stop us
    if (!fresh.c.payNowReady || !/^Pay now\s+£[\d.,]+$/i.test(fresh.c.payNowText) || pence(fresh.c.payNowAmount) !== fresh.totalPence) throw new Error('Pay now is not visible and enabled, or its amount does not match. Code not consumed, nothing paid.');

    // Arm Pay now (focus only).
    const finalReadyStarted = Date.now();
    const armed = await page.evaluate(`
      (() => {
        ${MODAL_JS}
        const guard = ${PAYMENT_GUARD_JS};
        if (guard) return { guard, ok: false, why: 'identity check before payment' };
        const b = document.querySelector('#place-order-button');
        if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true' || !b.getClientRects().length) return { ok: false, why: 'No usable Pay now button on the page' };
        const price = (${readPayNowButton.toString()})(b);
        if (price.error) return { ok: false, why: 'The Pay now amount could not be read reliably' };
        const amount = Math.round(Number(price.amount.replace(/[£,]/g, '')) * 100);
        if (amount !== ${fresh.totalPence}) return { ok: false, why: 'The Pay now amount just changed; code not consumed, nothing paid' };
        b.scrollIntoView({ block: 'center' });
        b.focus();
        if (document.activeElement !== b) return { ok: false, why: 'Pay now could not be focused, so Enter would land elsewhere' };
        return { ok: true, text: price.label };
      })()
    `);
    guardPayment(armed);
    if (!armed.ok) throw new Error(armed.why + '. Nothing clicked.');
    process.stderr.write('[deliveroo-timing] ' + JSON.stringify({phase:'final_ready',elapsed_ms:Date.now()-finalReadyStarted,outcome:'ok'}) + '\n');
    // No awaited browser work between the claim and the single payment keypress.
    // Gates are rechecked after the awaited preparation, not before it.
    verifyConfirm({ pending, code, live: fresh.snapshot, tipPence: fresh.tipPence, charityPence: fresh.charityPence, capPence });
    if (typeof page.cdp !== 'function') throw new Error('Native key channel unavailable; code not consumed, nothing paid.');
    const dispatchStarted = Date.now();
    claimCode({ code });
    try { await dispatchCheckoutEnter(page); }
    finally { process.stderr.write('[deliveroo-timing] ' + JSON.stringify({phase:'dispatch',elapsed_ms:Date.now()-dispatchStarted,outcome:'attempted'}) + '\n'); }

    // Wait for the order page. If it does not come, say so; never press again.
    let done = null;
    for (let i = 0; i < 30; i++) {
      await page.wait(2);
      done = await page.evaluate(`
        (() => {
          const guard = ${PAYMENT_GUARD_JS};
          if (guard) return { guard };
          const t = (document.body && document.body.innerText) || '';
          const m = t.match(/(?:order (?:number|id|ref)[^\\w]{0,4})([A-Z0-9-]{5,})/i);
          const pathId = (location.href.match(/\\/orders?\\/([A-Za-z0-9-]+)(?:[/?#]|$)/) || [])[1] || '';
          const orderId = m ? m[1] : pathId;
          const explicitSuccess = /order (?:confirmed|placed)|thank(?:s| you) for (?:your )?order/i.test(t);
          return {
            ordered: !!orderId && (!!pathId || explicitSuccess),
            orderId,
            eta: (t.match(/(?:arriv\\w+|estimated)[^\\n]{0,60}/i) || [''])[0].trim(),
            error: /(went wrong|couldn.t|declined|failed|try again)/i.test(t),
            wall: /Just a moment|Performing security verification|px-captcha|Press & Hold/i.test(t),
          };
        })()
      `);
      guardPayment(done);
      if (done.ordered || done.error || done.wall) break;
    }

    if (done && done.wall) {
      throw new Error(
        'The payment keypress was sent, then a bot-verification wall appeared. Unknown whether Deliveroo accepted it; not retried. ' +
        'An order may or may not exist: check your orders on Deliveroo yourself. This tool will not press again.'
      );
    }
    if (!done || !done.ordered) {
      throw new Error(
        'Sent one keypress to the payment button (' + armed.text + '), but no order page appeared within ' + (30 * 2) + ' seconds. Not retried. ' +
        (done && done.error ? 'The page shows an error message. ' : '') +
        'An order may or may not exist: check your orders on Deliveroo yourself. This tool will not press again.'
      );
    }

    return [
      { field: 'ordered', value: fresh.c.shop, note: 'payment sent; this cannot be undone' },
      { field: 'order id', value: done.orderId || '(not shown)', note: '' },
      { field: 'total', value: fmtPence(fresh.totalPence), note: armed.text },
      { field: 'eta', value: done.eta || '(not shown)', note: '' },
      { field: 'confirm code', value: 'consumed', note: 'cannot be reused; no screenshots or address receipts are saved' },
    ];
  },
});
