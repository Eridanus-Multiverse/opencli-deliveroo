// "Go to checkout" navigation and the native Enter used for payment. Fake page only.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { dispatchCheckoutEnter, gotoCheckout } from '../checkout.js';

function fixture({ guard = false } = {}) {
  let time = 0, stage = 'menu';
  const count = { keys: 0, clicks: 0 };
  const location = { get href() { return 'https://deliveroo.co.uk/' + (stage === 'checkout' ? 'checkout/payment' : 'menu/london/test/shop'); } };
  // Discounted shape: two amounts plus "incl. fees" on the button.
  const button = { innerText: 'Go to checkout\n£21.40£19.90 incl. fees', disabled: false, getAttribute: () => null, getClientRects: () => [1],
    scrollIntoView() {}, focus() { document.activeElement = button; }, click() { count.clicks++; stage = 'checkout'; } };
  const document = { title: 'Checkout', body: { innerText: guard ? 'Just a moment' : '', querySelectorAll: () => [button] }, activeElement: null, querySelector: () => null, querySelectorAll: () => [] };
  const page = {
    evaluate: async code => vm.runInNewContext(code, { document, location, Date: { now: () => time }, setTimeout: (fn, ms) => { time += ms; fn(); } }),
    wait: async seconds => { time += seconds * 1000; },
    cdp: async (method, p) => {
      assert.equal(method, 'Input.dispatchKeyEvent'); assert.equal(p.windowsVirtualKeyCode, 13);
      if (p.type === 'keyDown') { assert.equal(p.text, '\r'); count.keys++; stage = 'checkout'; }
    },
    pressKey: async () => { throw new Error('generic Enter must not be used'); },
  };
  return { page, count };
}

test('discounted button label with two amounts and "incl. fees" reaches checkout with one Enter', async () => {
  const f = fixture(); await gotoCheckout(f.page);
  assert.equal(f.count.keys, 1); assert.equal(f.count.clicks, 0);
});

test('a challenge during navigation stops before any key or click', async () => {
  const f = fixture({ guard: true });
  await assert.rejects(gotoCheckout(f.page), /captcha/i);
  assert.equal(f.count.keys, 0); assert.equal(f.count.clicks, 0);
});

test('strict Enter: an unknown dispatch never falls back or retries', async () => {
  let calls = 0, keys = 0;
  await assert.rejects(dispatchCheckoutEnter({ cdp: async () => { calls++; throw Error('unknown'); }, pressKey: async () => keys++ }), /unknown/);
  assert.equal(calls, 1); assert.equal(keys, 0);
});

test('keyUp failure after activation never sends a second keyDown', async () => {
  const types = [];
  await assert.rejects(dispatchCheckoutEnter({ cdp: async (method, p) => { types.push(p.type); if (p.type === 'keyUp') throw Error('unknown'); } }), /unknown/);
  assert.deepEqual(types, ['keyDown', 'keyUp']);
});

test('no native key channel: nothing is sent', async () => {
  await assert.rejects(dispatchCheckoutEnter({ pressKey: async () => assert.fail('must not fall back') }), /no payment was sent/);
});
