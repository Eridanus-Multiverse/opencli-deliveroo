// The real checkout command against a scripted fake page and the real confirm-code
// store in a temp HOME. No browser, no network; all data is fake.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import vm from 'node:vm';

const HOME = mkdtempSync(tmpdir() + '/deliveroo-pay-');
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
delete process.env.DELIVEROO_MAX_TOTAL;
test.after(() => rmSync(HOME, { recursive: true, force: true }));

const { getRegistry } = await import('@jackwener/opencli/registry');
const { CHECKOUT_READ_JS, PAYMENT_GUARD_JS } = await import('../checkout.js');
const { KILL_OVERLAYS_JS, basketFingerprint, maskAddress } = await import('../lib.js');
const { issueCode, pendingPath } = await import('../confirm.js');
const run = getRegistry().get('deliveroo/checkout').func;

const SHOP = '/menu/london/test/fixture-shop';
const ITEMS = [{ qty: 1, name: 'Fixture Fries', price: '£3.20' }];
const ADDRESS = ['17 Example Road', 'London, ZZ1 1ZZ'];

// The first read (no reveal on --confirm) still shows Continue; after scrolling, Pay now appears and a fee moved by 35p.
function readFor(n, over) {
  const first = n === 1;
  return {
    guard: '', shop: 'Fixture Kitchen', items: ITEMS,
    fees: { subtotal: '£3.20', delivery: '£1.49', service: first ? '£0.60' : '£0.95', total: first ? '£5.29' : '£5.64' },
    other: [], parseErrors: [], payment: 'Test Card', addressLines: ADDRESS,
    paymentAction: first ? 'Continue' : 'Pay now', payNowText: first ? '' : 'Pay now £5.64', payNowAmount: first ? '' : '£5.64',
    payNowReady: true, href: 'https://deliveroo.co.uk/checkout/payment', ...over(n),
  };
}

function preview(over = {}) {
  return issueCode({ at: new Date().toISOString(), shop: 'Fixture Kitchen', items: ITEMS, total_pence: 529,
    fingerprint: basketFingerprint('Fixture Kitchen', ITEMS), payment: 'Test Card', address: maskAddress(ADDRESS.join('\n')), ...over });
}
const consumed = () => !existsSync(pendingPath()) && existsSync(pendingPath() + '.used');

function fixture({ afterGuard = '', armAmount = '5.64', armOriginal = '', readOver = () => ({}), revealGuard = '', orderList = false,
  armThrows = false, payThrows = false, onArm = () => {} } = {}) {
  const s = { keys: 0, scrolls: 0, reads: 0, postReads: 0, focus: 0, evaluates: 0, events: [] };
  const page = {
    goto: async () => {}, wait: async () => {},
    cdp: async (method, args) => {
      assert.equal(method, 'Input.dispatchKeyEvent'); assert.equal(args.windowsVirtualKeyCode, 13);
      if (args.type !== 'keyDown') return;
      s.keys++; s.events.push(s.keys === 1 ? 'nav-key' : 'pay-key' + (consumed() ? '(consumed)' : '(NOT consumed)'));
      if (payThrows && s.keys > 1) throw Error('payment dispatch outcome unknown');
    },
    evaluate: async code => {
      s.evaluates++;
      if (code === KILL_OVERLAYS_JS) return 0;
      if (code === CHECKOUT_READ_JS) { s.reads++; return readFor(s.reads, readOver); }
      if (code.includes('const sections =')) { if (!revealGuard) s.scrolls += 9; return { guard: revealGuard, scrolled: revealGuard ? 0 : 9 }; }
      if (code.includes('hasRouter:')) return { guard: '', hasRouter: true, href: 'https://deliveroo.co.uk' + SHOP };
      if (code.includes('r.push(')) return true;
      if (code.includes('cards: document.querySelectorAll')) return { guard: '', path: SHOP, cards: 10 };
      if (code.includes('has: !!__byText')) return { guard: '', has: true };
      if (code.includes('armed: true')) return { guard: '', armed: true };
      if (code.includes('on: true')) return { guard: '', on: true };
      if (code.includes('const amount = Math.round')) {
        s.events.push('arm' + (consumed() ? '(consumed)' : ''));
        onArm();
        if (armThrows) throw Error('browser preparation interrupted');
        const button = { querySelectorAll: () => armOriginal ? [{ textContent: '£' + armOriginal, getAttribute: () => 'true' }] : [],
          cloneNode: () => ({ textContent: 'Pay now £' + armAmount, querySelectorAll: () => [] }),
          disabled: false, getAttribute: () => null, getClientRects: () => [{}], scrollIntoView() {}, focus() { s.focus++; document.activeElement = button; } };
        const document = { title: 'Checkout', body: { innerText: '' }, activeElement: null, querySelectorAll: () => [], querySelector: q => q === '#place-order-button' ? button : null };
        return vm.runInNewContext(code, { document, location: { href: 'https://deliveroo.co.uk/checkout/payment' } });
      }
      if (code.includes('const m = t.match')) {
        s.postReads++;
        if (afterGuard) return { guard: afterGuard };
        return vm.runInNewContext(code, { document: { title: 'Orders', body: { innerText: orderList ? 'Your orders' : 'Order confirmed. Order number FAKE-00001' }, querySelector: () => null, querySelectorAll: () => [] },
          location: { href: orderList ? 'https://deliveroo.co.uk/orders' : 'https://deliveroo.co.uk/orders/FAKE-00001' } });
      }
      throw new Error('Unexpected page operation');
    },
  };
  return { s, page };
}

const confirmArgs = (code, extra = {}) => ({ confirm: code, restaurant: SHOP, ...extra });

test('confirm: scrolls, rechecks the fresh total, consumes once right before the single payment key', async () => {
  const code = preview(); const { s, page } = fixture();
  const rows = await run(page, confirmArgs(code));
  assert.equal(s.scrolls, 9); assert.equal(s.keys, 2); assert.equal(s.focus, 1);
  assert.deepEqual(s.events, ['nav-key', 'arm', 'pay-key(consumed)']);
  assert.equal(rows.find(r => r.field === 'total').value, '£5.64');
  assert.equal(rows.find(r => r.field === 'order id').value, 'FAKE-00001');
  assert.ok(!rows.some(r => /deliver to/.test(r.field)), 'no address receipt after paying');
  await assert.rejects(run(fixture().page, confirmArgs(code)), /No pending|already used/);
});

test('preview issues a code that confirm accepts; preview never focuses Pay now', async () => {
  const f = fixture({ readOver: () => ({ fees: { subtotal: '£3.20', delivery: '£1.49', service: '£0.95', total: '£5.64' }, paymentAction: 'Pay now', payNowText: 'Pay now £5.64', payNowAmount: '£5.64' }) });
  const rows = await run(f.page, { restaurant: SHOP });
  const code = rows.find(r => r.field === 'confirm code').value;
  assert.match(code, /^[0-9a-f]{8}$/);
  assert.equal(f.s.focus, 0); assert.equal(f.s.keys, 1);
  const text = JSON.stringify(rows);
  assert.ok(text.includes('Example Road · ZZ1**'));
  for (const secret of ['17 Example', 'ZZ1 1ZZ', 'ZZ11ZZ']) assert.ok(!text.includes(secret), secret);
  const g = fixture();
  await run(g.page, confirmArgs(code, { 'dry-run': true }));
  assert.ok(!consumed());
});

test('confirm dry-run never reveals, focuses or consumes', async () => {
  const code = preview(); const { s, page } = fixture();
  const rows = await run(page, confirmArgs(code, { 'dry-run': true }));
  assert.equal(rows.at(-1).value, 'all passed');
  assert.equal(s.scrolls, 0); assert.equal(s.focus, 0); assert.equal(s.keys, 1); assert.ok(!consumed());
});

test('preview refuses to issue a code while only Continue is shown', async () => {
  rmSync(pendingPath(), { force: true });
  const { s, page } = fixture();
  await assert.rejects(run(page, { restaurant: SHOP }), /not ready/);
  assert.equal(s.scrolls, 9); assert.equal(s.focus, 0); assert.ok(!existsSync(pendingPath()));
});

test('no code, wrong code, stale code or both flags: refused before the browser is touched', async () => {
  rmSync(pendingPath(), { force: true });
  for (const [args, re] of [
    [confirmArgs('abcdef12'), /No pending/],
    [() => { preview(); return confirmArgs('00000000'); }, /does not match/],
    [() => confirmArgs(preview({ at: new Date(Date.now() - 11 * 60000).toISOString() })), /older than/],
    [() => ({ ...confirmArgs(preview()), preview: true }), /either --preview or --confirm/],
  ]) {
    const { s, page } = fixture();
    await assert.rejects(run(page, typeof args === 'function' ? args() : args), re);
    assert.equal(s.evaluates, 0); assert.equal(s.keys, 0);
  }
});

test('spending cap above the live total refuses without consuming', async () => {
  const code = preview(); const { s, page } = fixture();
  process.env.DELIVEROO_MAX_TOTAL = '5.00';
  try { await assert.rejects(run(page, confirmArgs(code)), /DELIVEROO_MAX_TOTAL/); }
  finally { delete process.env.DELIVEROO_MAX_TOTAL; }
  assert.ok(!consumed()); assert.equal(s.focus, 0);
});

test('Pay now not ready: no consume, no payment key', async () => {
  const code = preview(); const { s, page } = fixture({ readOver: () => ({ payNowReady: false }) });
  await assert.rejects(run(page, confirmArgs(code)), /Code not consumed/);
  assert.ok(!consumed()); assert.equal(s.keys, 1);
});

test('button amount changes during final arming: no consume, no payment key', async () => {
  const code = preview(); const { s, page } = fixture({ armAmount: '5.65' });
  await assert.rejects(run(page, confirmArgs(code)), /just changed/);
  assert.ok(!consumed()); assert.equal(s.keys, 1);
});

test('arming ignores only an explicit hidden original cost and reports the current amount', async () => {
  const code = preview(); const { s, page } = fixture({ armOriginal: '6.80' });
  const rows = await run(page, confirmArgs(code));
  assert.equal(s.keys, 2); assert.ok(consumed());
  assert.equal(rows.find(r => r.field === 'total').note, 'Pay now £5.64');
});

for (const guard of ['verification', 'auth', 'captcha']) test(`${guard} after payment halts at the first read, no retry`, async () => {
  const code = preview(); const { s, page } = fixture({ afterGuard: guard });
  await assert.rejects(run(page, confirmArgs(code)));
  assert.ok(consumed()); assert.equal(s.keys, 2); assert.equal(s.postReads, 1);
});

test('verification during the payment-area reveal stops before consuming or focusing', async () => {
  const code = preview(); const { s, page } = fixture({ revealGuard: 'verification' });
  await assert.rejects(run(page, confirmArgs(code)), /3DS/);
  assert.ok(!consumed()); assert.equal(s.focus, 0);
});

test('a generic orders list is "unknown", never reported as a new order', async () => {
  const code = preview(); const { s, page } = fixture({ orderList: true });
  await assert.rejects(run(page, confirmArgs(code)), /no order page appeared/);
  assert.ok(consumed()); assert.equal(s.keys, 2);
});

test('pre-dispatch failures keep the code and never pay', async () => {
  for (const [name, opts, re] of [
    ['arming throws', { armThrows: true }, /interrupted/],
    ['payment method changed on the fresh read', { readOver: n => n > 1 ? { payment: 'Other Card' } : {} }, /payment method/],
    ['fresh total drifted past 50p', { readOver: n => n > 1 ? { fees: { subtotal: '£3.20', delivery: '£1.49', service: '£1.20', total: '£5.89' }, payNowText: 'Pay now £5.89', payNowAmount: '£5.89' } : {}, armAmount: '5.89' }, /£0.50/],
  ]) {
    const code = preview(); const { s, page } = fixture(opts);
    await assert.rejects(run(page, confirmArgs(code)), re, name);
    assert.ok(!consumed(), name); assert.equal(s.keys, 1, name);
  }
});

test('code file removed or replaced during arming: claim fails, no payment key', async () => {
  for (const onArm of [() => unlinkSync(pendingPath()), () => preview()]) {
    const code = preview(); const { s, page } = fixture({ onArm });
    await assert.rejects(run(page, confirmArgs(code)), /already used|newer preview/);
    assert.equal(s.keys, 1);
  }
});

test('unknown payment dispatch keeps the code consumed and never retries', async () => {
  const code = preview(); const { s, page } = fixture({ payThrows: true });
  await assert.rejects(run(page, confirmArgs(code)), /outcome unknown/);
  assert.ok(consumed()); assert.equal(s.keys, 2); assert.equal(s.postReads, 0);
});

for (const mode of ['paypal-login', 'password', 'otp', '3ds']) test(`payment guard detects ${mode} without reading input values`, () => {
  const document = { title: mode === '3ds' ? '3D Secure' : 'Checkout', body: { innerText: '' }, querySelector: () => null,
    querySelectorAll: () => ['password', 'otp'].includes(mode) ? [{ getClientRects: () => [{}] }] : [] };
  assert.ok(vm.runInNewContext(PAYMENT_GUARD_JS, { document, location: { href: mode === 'paypal-login' ? 'https://www.paypal.com/signin' : 'https://deliveroo.co.uk/checkout/payment' } }));
});
