// Every registered command run against scripted fake pages. Assertions look at the
// final output (what would be printed), not intermediate values. No browser,
// no network; all data is fake. Coordinates (0, 0) sit in the Atlantic.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

const HOME = mkdtempSync(tmpdir() + '/deliveroo-cmd-');
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
test.after(() => rmSync(HOME, { recursive: true, force: true }));

const { getRegistry } = await import('@jackwener/opencli/registry');
const { formatRating, geohash, money, scrubUrl } = await import('../lib.js');
for (const m of ['restaurants', 'menu', 'basket', 'add', 'remove', 'checkout', 'doctor']) await import(`../${m}.js`);
const reg = getRegistry();
const cmd = (name) => reg.get('deliveroo/' + name).func;
const dump = (rows) => JSON.stringify(rows);

/** Fake page: goto/wait are no-ops, evaluate returns scripted values in order. */
function fakePage(...responses) {
  let i = 0;
  return {
    newTab: async () => 'fixture-owned-page', setActivePage: () => {}, closeTab: async () => {},
    goto: async () => {}, wait: async () => {},
    evaluate: async (js) => {
      if (js.includes("document.readyState === 'complete'")) return { guard: '', ready: true };
      if (i >= responses.length) throw new Error('fixture ran out of evaluate results (the command read the page more often than expected)');
      return responses[i++];
    },
  };
}

/** Recording fake page: write commands are judged by whether they reached for a button. */
function spyPage(...responses) {
  let i = 0;
  const scripts = [], keys = [];
  return {
    scripts, keys,
    goto: async () => {}, wait: async () => {},
    pressKey: async (k) => { keys.push(k); },
    cdp: async (method, p) => { if (p.type === 'keyDown') keys.push(p.key); },
    evaluate: async (js) => {
      scripts.push(String(js));
      if (i >= responses.length) throw new Error('fixture ran out of evaluate results (the command read the page more often than expected)');
      return responses[i++];
    },
  };
}
const ranScript = (p, needle) => p.scripts.some(s => s.includes(needle));

// gotoMenu reads the page three times: guard / router present / arrived.
const SHOP = (slug) => '/menu/london/test/' + slug;
const navTo = (slug) => [
  { guard: '', href: 'https://deliveroo.co.uk/restaurants/london/test', hasRouter: true },
  true,
  { guard: '', path: SHOP(slug), cards: 210 },
];
const seedAt = (lat, lon) => ({
  guard: '', loggedIn: true,
  locations: [{ id: 'fixture-1', postcode: 'ZZ11ZZ', formattedAddress: 'MUST-NOT-LEAK', coordinates: [lon, lat] }],
});

test('restaurants: ratings are not formatted as money', async () => {
  const rows = await cmd('restaurants')(fakePage(seedAt(51.5, -0.1), {
    guard: '', scanned: 3, count: 1, hood: 'Testville', warnings: [],
    rows: [
      { name: 'Fixture Ramen', url: '/menu/london/x/fixture-ramen', category: 'ramen', rating: 4.8, fee: { code: 'GBP', fractional: 249 }, eta: '25-35 min' },
      { name: 'Fixture Pizza', url: '/menu/london/x/fixture-pizza', category: 'italian', rating: { ratingValue: 4.2 }, fee: 199, eta: '30 min' },
    ],
  }), { limit: 15 });
  assert.equal(rows[0].rating, '4.8');
  assert.equal(rows[1].rating, '4.2');
  assert.ok(!dump(rows).includes('0.05'));
  assert.equal(rows[0].delivery_fee, '£2.49');
  assert.equal(rows[1].delivery_fee, '1.99');
  assert.equal(money(4.8), '0.05');
  assert.equal(formatRating(4.8), '4.8');
  assert.ok(!dump(rows).includes('MUST-NOT-LEAK'));
});

test('error branches never carry location precision', async () => {
  const GEO = geohash(0, 0, 12);
  assert.equal(GEO, 's00000000000');
  const noDelivery = dump(await cmd('restaurants')(fakePage(seedAt(0, 0), { guard: '', scanned: 0, rows: [], warnings: ['LOCATION_NO_DELIVERY'] }), { limit: 15 }));
  assert.ok(!noDelivery.includes(GEO));
  assert.ok(noDelivery.includes('ZZ1**'));
  assert.ok(!noDelivery.includes('ZZ11ZZ'));

  const nothing = dump(await cmd('restaurants')(fakePage(seedAt(0, 0), { guard: '', scanned: 137, rows: [], warnings: [] }), { limit: 15, q: 'ramen' }));
  assert.ok(!nothing.includes(GEO) && !nothing.includes('geohash'));
  assert.ok(nothing.includes('q=ramen'), 'the keyword is kept for diagnosis');
  assert.ok(nothing.includes('137'));

  const realish = dump(await cmd('restaurants')(fakePage(seedAt(51.5, -0.1), { guard: '', scanned: 0, rows: [], warnings: [] }), { limit: 15 }));
  for (const secret of [geohash(51.5, -0.1, 12), '51.5', '-0.1', 'ZZ11ZZ']) assert.ok(!realish.includes(secret), secret);

  const menuNothing = dump(await cmd('menu')(fakePage(...navTo('fixture-ramen'), { guard: '', rows: [], scanned: 0, shop: '', href: 'https://deliveroo.co.uk/menu/london/x/fixture-ramen?geohash=' + GEO }),
    { restaurant: SHOP('fixture-ramen'), limit: 40 }));
  assert.ok(!menuNothing.includes(GEO));
  assert.equal(scrubUrl('https://deliveroo.co.uk/x?geohash=' + GEO), 'https://deliveroo.co.uk/x');
});

test('zero matches never fall back to the unfiltered list', async () => {
  const feed = { guard: '', scanned: 2, count: 2, hood: 'Testville', warnings: [], rows: [
    { name: 'Fixture Pizza', url: '/menu/x/fixture-pizza', category: 'italian', rating: 4.5 },
    { name: 'Fixture Curry', url: '/menu/x/fixture-curry', category: 'indian', rating: 4.1 },
  ] };
  const miss = await cmd('restaurants')(fakePage(seedAt(0, 0), feed), { limit: 15, q: 'ramen' });
  assert.equal(miss.length, 1);
  assert.match(dump(miss), /No restaurant matches/);
  assert.ok(!/Fixture Pizza|Fixture Curry/.test(dump(miss)));
  const hit = dump(await cmd('restaurants')(fakePage(seedAt(0, 0), feed), { limit: 15, q: 'curry' }));
  assert.ok(hit.includes('Fixture Curry') && !hit.includes('Fixture Pizza'));

  const menuRows = { guard: '', scanned: 2, shop: 'Fixture Kitchen', href: 'https://deliveroo.co.uk' + SHOP('fixture-kitchen'), rows: [
    { category: 'Mains', name: 'Fixture Noodles', price: 990, id: 'i1', desc: 'broth' },
    { category: 'Sides', name: 'Fixture Dumplings', price: 410, id: 'i2', desc: 'steamed' },
  ] };
  const missM = await cmd('menu')(fakePage(...navTo('fixture-kitchen'), menuRows), { restaurant: SHOP('fixture-kitchen'), limit: 40, q: 'vegan' });
  assert.equal(missM.length, 1);
  assert.match(dump(missM), /No dish name or description contains/);
  assert.match(dump(missM), /2 dishes on this menu/);
  const hitM = dump(await cmd('menu')(fakePage(...navTo('fixture-kitchen'), menuRows), { restaurant: SHOP('fixture-kitchen'), limit: 40, q: 'dumpling' }));
  assert.ok(hitM.includes('Fixture Dumplings') && !hitM.includes('Fixture Noodles'));
});

test('basket: unreadable is never reported as empty', async () => {
  const basket = cmd('basket');
  const seedPage = { guard: '', href: 'https://deliveroo.co.uk/restaurants/london/test' };
  const noLink = { guard: '', ready: true, hasRoot: true, loading: false, url: '', count: '0' };
  await assert.rejects(basket(fakePage(seedPage, noLink), {}), e => /Basket unreadable/.test(e.message) && !/Basket is empty/.test(e.message));

  const withLink = { guard: '', ready: true, hasRoot: true, loading: false, url: 'https://deliveroo.co.uk' + SHOP('fixture-kitchen'), count: '0' };
  const realEmpty = { guard: '', rows: [], shop: 'Fixture Kitchen', empty: true };
  assert.match(dump(await basket(fakePage(seedPage, withLink, ...navTo('fixture-kitchen'), 0, realEmpty), {})), /Basket is empty/);

  const blank = { guard: '', rows: [], shop: 'Fixture Kitchen', empty: false };
  await assert.rejects(basket(fakePage(...navTo('fixture-kitchen'), 0, ...Array(10).fill(blank)), { restaurant: SHOP('fixture-kitchen') }), /Basket unreadable/);

  const full = { guard: '', rows: [{ qty: 1, name: 'Fixture Fries', price: '£3.20' }, { qty: 5, name: 'Fixture Burger, Medium', price: '£52.50' }], shop: 'Fixture Kitchen', empty: false };
  const rows = dump(await basket(fakePage(...navTo('fixture-kitchen'), 0, full, { guard: '', subtotal: '£55.70' }), { restaurant: SHOP('fixture-kitchen') }));
  assert.ok(rows.includes('Fixture Burger, Medium') && rows.includes('"qty":"5"'));
  assert.ok(rows.includes('£55.70'));
});

test('add: never guesses, never clicks Add when unsure', async () => {
  const add = cmd('add');
  const R = SHOP('fixture-kitchen');
  const ambiguous = spyPage(...navTo('fixture-kitchen'), 0, { guard: '', scanned: 210, hits: [
    { name: 'Fixture Dip Ketchup', exact: false, price: '£0.40' }, { name: 'Fixture Dip Mayo', exact: false, price: '£0.40' },
  ] });
  const rowsAmb = dump(await add(ambiguous, { restaurant: R, item: 'Fixture Dip', qty: 1 }));
  assert.ok(rowsAmb.includes('which one?') && rowsAmb.includes('Fixture Dip Mayo') && rowsAmb.includes('Ketchup'));
  assert.ok(!ranScript(ambiguous, 'btn.click()'));

  const none = spyPage(...navTo('fixture-kitchen'), 0, { guard: '', scanned: 210, hits: [] });
  assert.match(dump(await add(none, { restaurant: R, item: 'Nonexistent Dish', qty: 1 })), /not found/);
  assert.ok(!ranScript(none, 'btn.click()'));

  const needSpec = spyPage(...navTo('fixture-kitchen'), 0,
    { guard: '', scanned: 210, hits: [{ name: 'Fixture Meal Deal', exact: true, price: '£7.10' }] },
    true, { guard: '', modal: true }, 0, true,
    { name: 'Fixture Meal Deal', addText: 'Add for £7.10', groups: [
      { title: 'Choose a main · Required', required: true, checked: 0, options: ['Fixture Wrap', 'Fixture Bowl'] },
      { title: 'Choose a drink · Required', required: true, checked: 1, options: ['Fixture Cola', 'Fixture Lemonade'] },
    ] });
  const rowsSpec = dump(await add(needSpec, { restaurant: R, item: 'Fixture Meal Deal', qty: 1 }));
  assert.ok(rowsSpec.includes('needs options') && rowsSpec.includes('Fixture Wrap'));
  assert.ok(!rowsSpec.includes('Fixture Cola'), 'an answered group is not listed again');
  assert.ok(!ranScript(needSpec, 'btn.click()'));

  const dry = spyPage(...navTo('fixture-kitchen'), 0,
    { guard: '', scanned: 210, hits: [{ name: 'Fixture Dip Mayo', exact: true, price: '£0.40' }] },
    true, { guard: '', modal: true }, 0, true,
    { name: 'Fixture Dip Mayo', addText: 'Add for £0.40', groups: [] },
    true,
    // Sidebar names carry the chosen option; match by prefix and report the existing quantity.
    { guard: '', shop: 'Fixture Kitchen', empty: false, rows: [{ qty: 3, name: 'Fixture Dip Mayo, Large', price: '£1.20' }] });
  const rowsDry = dump(await add(dry, { restaurant: R, item: 'Fixture Dip Mayo', qty: 1, 'dry-run': true }));
  assert.ok(rowsDry.includes('dry-run') && rowsDry.includes('Add for £0.40') && rowsDry.includes('already has x3'));
  assert.ok(!ranScript(dry, 'btn.click()'));

  // A real add is confirmed only by the quantity increase of rows that start with the dish name.
  const real = spyPage(...navTo('fixture-kitchen'), 0,
    { guard: '', scanned: 62, hits: [{ name: 'Fixture Burger', exact: true, price: '£10.50' }] },
    true, { guard: '', modal: true }, 0,
    { modal: true, hit: true },
    { name: 'Fixture Burger', addText: 'Add for £10.50', groups: [{ title: 'How would you like it cooked? · Required', required: true, checked: 1, options: ['Medium', 'Well Done'] }] },
    { guard: '', shop: 'Fixture Kitchen', empty: false, rows: [{ qty: 1, name: 'Fixture Fries', price: '£3.20' }, { qty: 1, name: 'Fixture Burger, Well Done', price: '£10.50' }] },
    true,
    { guard: '', shop: 'Fixture Kitchen', empty: false, rows: [{ qty: 1, name: 'Fixture Fries', price: '£3.20' }, { qty: 2, name: 'Fixture Burger, Well Done', price: '£21.00' }] });
  const rowsReal = dump(await add(real, { restaurant: R, item: 'Fixture Burger', qty: 1, option: 'Well Done' }));
  assert.ok(rowsReal.includes('"added"') && rowsReal.includes('x2'));
  assert.ok(ranScript(real, 'btn.click()'));
});

test('remove: uses the page controls, never "Delete all items"', async () => {
  const remove = cmd('remove');
  const R = SHOP('fixture-kitchen');
  const missing = spyPage(...navTo('fixture-kitchen'), 0, { guard: '', shop: 'Fixture Kitchen', empty: false, rows: [{ qty: 1, name: 'Fixture Wrap', price: '£4.80' }] });
  const rowsMiss = dump(await remove(missing, { item: 'Fixture Soup', restaurant: R }));
  assert.ok(rowsMiss.includes('not in basket') && rowsMiss.includes('Fixture Wrap'));
  assert.ok(!ranScript(missing, 'rm.click()'));

  const dryRm = spyPage(...navTo('fixture-kitchen'), 0, { guard: '', shop: 'Fixture Kitchen', empty: false, rows: [{ qty: 1, name: 'Fixture Dip Mayo', price: '£0.40' }] });
  const rowsDry = dump(await remove(dryRm, { item: 'Mayo', restaurant: R, 'dry-run': true }));
  assert.ok(rowsDry.includes('dry-run') && rowsDry.includes('Remove item'));
  assert.ok(!ranScript(dryRm, 'rm.click()'));

  const realRm = spyPage(...navTo('fixture-kitchen'), 0,
    { guard: '', shop: 'Fixture Kitchen', empty: false, rows: [{ qty: 1, name: 'Fixture Dip Mayo', price: '£0.40' }] },
    { gone: false, clicked: true }, true, { gone: true },
    { guard: '', shop: 'Fixture Kitchen', empty: true, rows: [] });
  assert.match(dump(await remove(realRm, { item: 'Mayo', restaurant: R })), /"removed"/);
  assert.ok(ranScript(realRm, 'rm.click()') && ranScript(realRm, '/^Remove item$/i'));
  assert.ok(!ranScript(realRm, 'Delete all items'));

  const dec = (qty) => [{ gone: false, clicked: true, qty }, false];
  const partial = spyPage(...navTo('fixture-kitchen'), 0,
    { guard: '', shop: 'Fixture Kitchen', empty: false, rows: [{ qty: 1, name: 'Fixture Fries', price: '£3.20' }, { qty: 5, name: 'Fixture Burger, Medium', price: '£52.50' }] },
    ...dec(5), ...dec(4), ...dec(3), ...dec(2), { done: true, qty: 1 },
    { guard: '', shop: 'Fixture Kitchen', empty: false, rows: [{ qty: 1, name: 'Fixture Fries', price: '£3.20' }, { qty: 1, name: 'Fixture Burger, Medium', price: '£10.50' }] });
  assert.match(dump(await remove(partial, { item: 'Fixture Burger', restaurant: R, qty: 4 })), /reduced to x1/);
  assert.ok(ranScript(partial, 'Decrease quantity') && !ranScript(partial, 'Delete all items'));
});

test('checkout preview: reads everything, clicks nothing on the account, prints street-level address only', async () => {
  const checkout = cmd('checkout');
  const seen = {
    guard: '', shop: 'Fixture Kitchen',
    items: [{ qty: 1, name: 'Fixture Dip Mayo', price: '£0.40' }],
    fees: { subtotal: '£0.40', delivery: '£1.79', small_order: '£2.00', service: '£0.89', total: '£5.08' },
    other: [], parseErrors: [], fulfilment: 'Standard delivery', eta: '20 - 35 min',
    addressLines: ['1 Example Road', 'London, ZZ1 1ZZ'], payment: 'Test Card',
    paymentAction: 'Pay now', payNowText: 'Pay now £5.08', payNowAmount: '£5.08', payNowReady: true,
    href: 'https://deliveroo.co.uk/checkout/payment?branch_drn_id=99999&geohash=s00000000000', onCheckout: true,
  };
  // navigate, overlays, Go to checkout (has / armed / on), overlays, reveal, read
  const seq = (o, slug = 'fixture-kitchen') => [...navTo(slug), 0, { guard: '', has: true }, { guard: '', armed: true }, { guard: '', on: true }, 0, { guard: '', scrolled: 0 }, o];

  const p = spyPage(...seq(seen));
  const rows = await checkout(p, { restaurant: SHOP('fixture-kitchen') });
  const t = dump(rows);
  for (const n of ['Fixture Kitchen', 'Fixture Dip Mayo', '£0.40', '£1.79', '£2.00', '£0.89', '£5.08', 'Standard delivery', '20 - 35 min', 'Test Card', 'Example Road · ZZ1**']) {
    assert.ok(t.includes(n), 'preview is missing ' + n);
  }
  for (const secret of ['1 Example', 'ZZ1 1ZZ', 's00000000000', 'geohash', 'branch_drn_id']) assert.ok(!t.includes(secret), 'preview leaked ' + secret);
  assert.match(rows.at(-1).value, /^[0-9a-f]{8}$/);
  assert.ok(!ranScript(p, 'document.activeElement !== b'), 'preview touched Pay now');
  assert.ok(!ranScript(p, 'Increase quantity'));
  assert.deepEqual(p.keys, ['Enter'], 'only the Go to checkout Enter');
  assert.ok(p.scripts.some(s => s.includes('next') && s.includes('router')), 'entered the shop via the Next client router');

  await assert.rejects(checkout(spyPage(...seq({ ...seen, payNowText: 'Pay now £7.98', payNowAmount: '£7.98' })), { restaurant: SHOP('fixture-kitchen') }),
    e => /£5.08/.test(e.message) && /£7.98/.test(e.message));
  await assert.rejects(checkout(spyPage(...seq({ ...seen, payment: '' })), { restaurant: SHOP('fixture-kitchen') }), /payment method/);
  await assert.rejects(checkout(spyPage(...seq({ ...seen, other: [{ label: 'Mystery fee', amount: '£0.30' }], parseErrors: ['UNKNOWN_FEE'] })), { restaurant: SHOP('fixture-kitchen') }), /UNKNOWN_FEE/);
});

test('checkout --confirm without a valid code never opens the page', async () => {
  for (const code of ['00000000', 'not-a-code']) {
    const p = spyPage();
    await assert.rejects(cmd('checkout')(p, { confirm: code, restaurant: 'x' }), /does not match|No pending/);
    assert.equal(p.scripts.length, 0); assert.equal(p.keys.length, 0);
  }
});

test('doctor reports login state with one plain next step, read-only', async () => {
  const doctor = cmd('doctor');
  const ok = await doctor(fakePage(true));
  assert.equal(ok.find(r => r.check === 'deliveroo login').status, 'ok');
  assert.match(ok.find(r => r.check === 'opencli').status, /^ok /);
  const out = await doctor(fakePage(false));
  assert.match(out.find(r => r.check === 'deliveroo login').next, /log in at deliveroo\.co\.uk/);
  const walled = fakePage();
  walled.evaluate = async () => ({ guard: 'captcha' });
  assert.match((await doctor(walled)).find(r => r.check === 'deliveroo login').next, /human/);
});
