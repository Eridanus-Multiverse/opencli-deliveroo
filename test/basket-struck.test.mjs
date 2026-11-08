// Discounted checkout rows (struck-through original + current price) need real
// layout (getComputedStyle, getClientRects), so this one test drives a headless
// Chromium on a static fixture. It is skipped unless you opt in:
//   npm i --no-save playwright-core && CHROMIUM_PATH=/path/to/chrome npm test
// It never opens a website.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECKOUT_READ_JS } from '../checkout.js';

const row = (...cells) => `<li>${cells.map(c => `<div>${c}</div>`).join('')}</li>`;
const html = (extra = '') => `<h1>Review your order from Fixture Tea House</h1><section aria-label="Basket"><ul>
  ${row('1x', 'Fixture Milk Tea', '<span style="text-decoration:line-through">£5.00</span><span>£4.00</span>')}
  ${row('1x', 'Fixture Green Tea', '£4.50')}
  ${row('Subtotal', '<s>£9.50</s>', '£8.50', 'Total saved (-£1.00)')}
  ${row('Delivery fee', '£0.49')}
  ${row('Total', '£8.99')}${extra}</ul></section>`;

test('struck-through original price is ignored, the live price is kept', { skip: !process.env.CHROMIUM_PATH && 'set CHROMIUM_PATH to run' }, async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  try {
    const p = await browser.newPage();
    await p.setContent(html());
    const r = await p.evaluate(CHECKOUT_READ_JS);
    assert.deepEqual(r.parseErrors, []);
    assert.deepEqual(r.items, [{ qty: 1, name: 'Fixture Milk Tea', price: '£4.00' }, { qty: 1, name: 'Fixture Green Tea', price: '£4.50' }]);
    assert.deepEqual(r.fees, { subtotal: '£8.50', delivery: '£0.49', total: '£8.99' });
    // Two unstruck amounts in one row stay ambiguous.
    await p.setContent(html(row('Service fee', '£0.99', '£0.49')));
    assert.ok((await p.evaluate(CHECKOUT_READ_JS)).parseErrors.includes('MONEY_ROW_AMBIGUOUS'));
    // A hidden struck copy cannot excuse a visible unstruck price.
    await p.setContent(html(row('Service fee', '£0.99', '£0.49', '<s style="display:none">£0.99</s>')));
    assert.ok((await p.evaluate(CHECKOUT_READ_JS)).parseErrors.includes('MONEY_ROW_AMBIGUOUS'));
    // A fully struck row is an error, never silently dropped.
    await p.setContent(html(row('Service fee', '<s>£0.99</s>')));
    assert.ok((await p.evaluate(CHECKOUT_READ_JS)).parseErrors.includes('MONEY_ROW_AMBIGUOUS'));
    // Two adjacent unstruck inline prices are split and still rejected.
    await p.setContent(html(row('1x', 'Fixture Mystery Tea', '<span>£5.00</span><span>£4.00</span>')));
    assert.ok((await p.evaluate(CHECKOUT_READ_JS)).parseErrors.includes('MONEY_ROW_AMBIGUOUS'));
  } finally { await browser.close(); }
});
