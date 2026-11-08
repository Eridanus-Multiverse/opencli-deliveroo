// Pure helpers and payment gates. No browser, no network. All data is fake.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertConfirmedTotal, assertNoTipOrDonation, assertPreviewMatches, assertUnderCap, basketFingerprint,
  clampLimit, firstOf, fmtPence, formatRating, geohash, guardPage, maskAddress, maskPostcode, maxTotalPence,
  menuUrl, money, pence, pickAddress, scrubUrl, versionAtLeast,
} from '../lib.js';

test('geohash matches the public reference value and truncates as a prefix', () => {
  assert.equal(geohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
  assert.ok(geohash(51.5, -0.1, 12).startsWith(geohash(51.5, -0.1, 6)));
  assert.equal(geohash(0, 0, 4), 's000');
});

test('postcode masking keeps only area letters and first digit', () => {
  assert.equal(maskPostcode('ZZ11ZZ'), 'ZZ1**');
  assert.equal(maskPostcode('ZZ19 9ZZ'), 'ZZ1**'); // deliberately collides: one more character leaks a sector
  assert.equal(maskPostcode('Z1A1ZZ'), 'Z1**');
  assert.equal(maskPostcode(''), '(none)');
  for (const pc of ['ZZ11ZZ', 'ZZ199ZZ']) assert.ok(!maskPostcode(pc).includes(pc));
});

test('pickAddress returns id/postcode/coordinates only, never the street', () => {
  const locs = [
    { id: 'a', postcode: 'ZZ11ZZ', formattedAddress: 'MUST-NOT-LEAK', coordinates: [-0.1, 51.5] },
    { id: 'b', postcode: 'ZZ199ZZ', formattedAddress: 'MUST-NOT-LEAK', coordinates: [-0.2, 51.4] },
  ];
  const picked = pickAddress(locs);
  assert.equal(picked.id, 'a');
  assert.ok(!JSON.stringify(picked).includes('MUST-NOT-LEAK'));
  assert.equal(pickAddress(locs, 'ZZ19').id, 'b');
  assert.throws(() => pickAddress(locs, 'NW1'));
  assert.throws(() => pickAddress([]));
});

test('page guard stops on login and captcha', () => {
  assert.throws(() => guardPage({ guard: 'auth' }), /log in/i);
  assert.throws(() => guardPage({ guard: 'captcha' }), /captcha/i);
  assert.throws(() => guardPage(null));
  guardPage({ guard: '' });
});

test('money and ratings are formatted separately', () => {
  assert.equal(money({ code: 'GBP', fractional: 1250 }), '£12.50');
  assert.equal(money({ formatted: '£3.99' }), '£3.99');
  assert.equal(money('£2.00'), '£2.00');
  assert.equal(money(null), '');
  assert.equal(money(4.8), '0.05'); // why ratings must never go through money()
  assert.equal(formatRating(4.8), '4.8');
  assert.equal(formatRating(5), '5.0');
  assert.equal(formatRating('4.8'), '4.8');
  assert.equal(formatRating({ ratingValue: 4.6 }), '4.6');
  assert.equal(formatRating('New'), 'New');
  assert.equal(formatRating({}), '');
});

test('outgoing URLs keep only q; no location or tracking parameter survives', () => {
  assert.equal(scrubUrl('https://deliveroo.co.uk/restaurants/london/test?geohash=s00000000000&q=ramen'),
    'https://deliveroo.co.uk/restaurants/london/test?q=ramen');
  for (const leaky of [
    'https://deliveroo.co.uk/x?geohash=s00000000000',
    'https://deliveroo.co.uk/x?lat=51.5000&lng=-0.1000',
    'https://deliveroo.co.uk/x?postcode=ZZ11ZZ',
    'https://deliveroo.co.uk/x?place_id=abc&sp_id=123&utm_source=x',
  ]) {
    const cleaned = scrubUrl(leaky);
    for (const secret of ['s00000000000', '51.5000', '-0.1000', 'ZZ11ZZ', 'place_id', 'sp_id', 'utm_']) {
      assert.ok(!cleaned.includes(secret), secret + ' leaked: ' + cleaned);
    }
  }
  assert.equal(scrubUrl(''), '');
  assert.ok(scrubUrl('not a url').startsWith('https://deliveroo.co.uk/'));
});

test('menuUrl is a trust boundary: only https deliveroo.co.uk', () => {
  assert.match(menuUrl('fixture-ramen'), /^https:\/\/deliveroo\.co\.uk\/menu\/[^/]+\/[^/]+\/fixture-ramen$/);
  assert.equal(menuUrl('https://deliveroo.co.uk/menu/london/test/x?y=1'), 'https://deliveroo.co.uk/menu/london/test/x');
  assert.equal(menuUrl('/menu/london/test/x?y=1'), 'https://deliveroo.co.uk/menu/london/test/x');
  for (const bad of ['https://evil.example/menu/x', 'https://deliveroo.co.uk.evil.example/x', 'http://deliveroo.co.uk/x',
    'javascript:alert(1)', '//evil.example/x', '']) {
    assert.throws(() => menuUrl(bad), bad);
  }
});

test('small helpers', () => {
  assert.equal(firstOf({ a: { b: 'x' } }, ['nope', 'a.b']), 'x');
  assert.equal(clampLimit(999, 15, 30), 30);
  assert.equal(clampLimit(undefined, 15, 30), 15);
  assert.ok(versionAtLeast('1.8.7', '1.8.7'));
  assert.ok(versionAtLeast('1.10.0', '1.8.7'));
  assert.ok(versionAtLeast('v2.0.0-beta.1', '1.8.7'));
  assert.ok(!versionAtLeast('1.8.6', '1.8.7'));
  assert.ok(!versionAtLeast('', '1.8.7'));
});

test('money arithmetic is in integer pence', () => {
  assert.equal(pence('£3.75'), 375);
  assert.equal(pence('3.75'), 375);
  assert.equal(pence('£0.00'), 0);
  assert.equal(pence('-£1.00'), -100);
  assert.equal(pence('£1,234.50'), 123450);
  assert.equal(pence('free'), null);
  assert.equal(pence(''), null);
  assert.equal(fmtPence(375), '£3.75');
  assert.equal(fmtPence(-100), '-£1.00');
  assert.equal(pence('£0.10') + pence('£0.20'), pence('£0.30'));
});

test('basket fingerprint ignores order, catches any item change', () => {
  const L1 = [{ name: 'Fixture Dumplings', qty: 1, price: '£4.10' }, { name: 'Fixture Noodles', qty: 2, price: '£19.80' }];
  const L2 = [L1[1], L1[0]];
  assert.equal(basketFingerprint('Shop', L1), basketFingerprint('Shop', L2));
  assert.notEqual(basketFingerprint('Shop', L1), basketFingerprint('Shop', [{ ...L1[0], qty: 2 }, L1[1]]));
  assert.notEqual(basketFingerprint('Shop', L1), basketFingerprint('Other Shop', L1));
});

test('preview gate: fresh, total within 50p, same fingerprint', () => {
  const NOW = Date.parse('2026-01-01T12:00:00Z');
  const fp = basketFingerprint('Fixture Kitchen', [{ name: 'Fixture Fries', qty: 1, price: '£3.20' }]);
  const fresh = { at: new Date(NOW - 60000).toISOString(), total_pence: 529, fingerprint: fp };
  assert.ok(assertPreviewMatches({ preview: fresh, now: NOW, totalPence: 529, fingerprint: fp }));
  assert.ok(assertPreviewMatches({ preview: fresh, now: NOW, totalPence: 579, fingerprint: fp }));
  assert.ok(assertPreviewMatches({ preview: fresh, now: NOW, totalPence: 479, fingerprint: fp }));
  assert.throws(() => assertPreviewMatches({ preview: fresh, now: NOW, totalPence: 580, fingerprint: fp }), /£0.50/);
  assert.throws(() => assertPreviewMatches({ preview: null, now: NOW, totalPence: 529, fingerprint: fp }));
  assert.throws(() => assertPreviewMatches({ preview: { ...fresh, at: new Date(NOW - 11 * 60000).toISOString() }, now: NOW, totalPence: 529, fingerprint: fp }));
  assert.throws(() => assertPreviewMatches({ preview: { ...fresh, at: new Date(NOW + 60000).toISOString() }, now: NOW, totalPence: 529, fingerprint: fp }));
  assert.throws(() => assertPreviewMatches({ preview: fresh, now: NOW, totalPence: 529, fingerprint: 'deadbeefdeadbeef' }), /basket changed/);
  assert.throws(() => assertPreviewMatches({ preview: fresh, now: NOW, totalPence: 700, fingerprint: fp }),
    e => e.message.includes('£5.29') && e.message.includes('£7.00'));
  assert.throws(() => assertConfirmedTotal(529, -1));
  assert.throws(() => assertConfirmedTotal(529, 5.5));
});

test('optional spending cap from DELIVEROO_MAX_TOTAL', () => {
  assert.equal(maxTotalPence({}), null);
  assert.equal(maxTotalPence({ DELIVEROO_MAX_TOTAL: '' }), null);
  assert.equal(maxTotalPence({ DELIVEROO_MAX_TOTAL: '40' }), 4000);
  assert.equal(maxTotalPence({ DELIVEROO_MAX_TOTAL: '£12.50' }), 1250);
  for (const bad of ['abc', '0', '-5', '1e3', '40 pounds']) assert.throws(() => maxTotalPence({ DELIVEROO_MAX_TOTAL: bad }), bad);
  assert.ok(assertUnderCap({ totalPence: 4000, capPence: 4000 }));
  assert.ok(assertUnderCap({ totalPence: 999999, capPence: null }));
  assert.throws(() => assertUnderCap({ totalPence: 4001, capPence: 4000 }));
  assert.throws(() => assertUnderCap({ totalPence: null, capPence: null }));
});

test('tip and donation must be zero', () => {
  assert.ok(assertNoTipOrDonation({ tipPence: 0, charityPence: 0 }));
  assert.ok(assertNoTipOrDonation({ tipPence: null, charityPence: null }));
  assert.throws(() => assertNoTipOrDonation({ tipPence: 100, charityPence: 0 }));
  assert.throws(() => assertNoTipOrDonation({ tipPence: 0, charityPence: 52 }));
});

test('address masking: street and masked postcode only', () => {
  const masked = maskAddress('1 Example Road\nLondon, ZZ1 1ZZ\n+447700900123\nNo rider directions');
  assert.equal(masked, 'Example Road · ZZ1**');
  assert.equal(maskAddress('Flat 12, Sample Street\nLondon, ZZ9 9ZZ'), 'Sample Street · ZZ9**');
  assert.equal(maskAddress(''), '(unreadable)');
});

test('floor, flat, phone and rider instructions never leave the street projection', () => {
  for (const raw of [
    'Flat 42\n3rd floor\n17 Example Road\nLondon, ZZ1 1ZZ\nRider directions\nLeave at door code SECRET7788\n+447700900123',
    'Flat 42, 3rd floor, 17 Example Road\nLondon, ZZ1 1ZZ\nring SECRET7788',
    '3rd floor Flat 42 17 Example Road\nLondon, ZZ1 1ZZ\nMeet me with the order',
    '17 Example Road; 7788\nLondon, ZZ1 1ZZ\n3rd floor\nchoose a safe place',
  ]) {
    assert.equal(maskAddress(raw), 'Example Road · ZZ1**');
  }
});

test('map and delivery-option loading cannot change the street projection', () => {
  const before = '17 Example Road\nLondon, ZZ1 1ZZ';
  const after = before + '\nMap data ©2026 Google\nTerms\nReport a map error\nMeet me with the order\nchoose a safe place\nMake this a gift';
  assert.equal(maskAddress(after), maskAddress(before));
});

test('unknown address shapes cannot become raw display text', () => {
  for (const raw of [
    '', 'SECRET7788\nZZ1 1ZZ',
    'Flat 42\nFloor 3\nZZ1 1ZZ',
    '17 Example Road',
    '17 Example Road\n19 Sample Street\nZZ1 1ZZ',
    '17 Example Road\nZZ1 1ZZ\nZZ9 9ZZ',
    'Leave at Example Road\nZZ1 1ZZ',
  ]) assert.equal(maskAddress(raw), '(unreadable)');
});

test('Cloudflare wall wording is recognised by the page guard', async () => {
  const { GUARD_JS } = await import('../lib.js');
  const vm = await import('node:vm');
  const run = (text) => vm.runInNewContext(GUARD_JS, { location: { href: 'https://deliveroo.co.uk/menu/x' }, document: { title: '', body: { innerText: text } } });
  assert.equal(run('deliveroo.co.uk\nPerforming security verification'), 'captcha');
  assert.equal(run('Just a moment...'), 'captcha');
  assert.equal(run('Menu'), '');
});
