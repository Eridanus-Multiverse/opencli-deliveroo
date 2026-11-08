// Feed-page lifecycle and live-state reads. Fake page objects only.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { FEED_STATE_JS, RECENT_ADDRESSES_JS, readRecentAddresses, readRestaurantCards, withFeedPage } from '../feed-page.js';

function page(statuses = [{ guard: '', ready: true }]) {
  const calls = [];
  return { calls,
    newTab: async url => { calls.push(['new', url]); return 'own-id'; },
    setActivePage: id => calls.push(['bind', id]),
    closeTab: async id => calls.push(['close', id]),
    goto: async () => { throw new Error('Navigation rejected'); },
    wait: async () => {},
    evaluate: async () => statuses.length > 1 ? statuses.shift() : statuses[0],
  };
}

test('consecutive reads each use a newly owned tab, never a duplicate goto', async () => {
  const p = page();
  for (let i = 0; i < 2; i++) assert.equal(await withFeedPage(p, async () => 'fresh data'), 'fresh data');
  assert.deepEqual(p.calls.map(c => c[0]), ['new', 'bind', 'close', 'new', 'bind', 'close']);
  assert.ok(p.calls.filter(c => c[0] === 'close').every(c => c[1] === 'own-id'));
});

test('waits for the live state before reading', async () => {
  const states = [{ ready: false }, { ready: true }];
  const p = page(states);
  await withFeedPage(p, async () => assert.equal(states.length, 1));
});

test('auth, challenge, timeout and read errors all close only the new tab', async () => {
  for (const status of [{ guard: 'auth' }, { guard: 'captcha' }, { ready: false }]) {
    const p = page([status]);
    await assert.rejects(withFeedPage(p, async () => assert.fail('must not read')));
    assert.deepEqual(p.calls.at(-1), ['close', 'own-id']);
  }
  const p = page();
  await assert.rejects(withFeedPage(p, async () => { throw new Error('parse failure'); }), /parse failure/);
  assert.deepEqual(p.calls.at(-1), ['close', 'own-id']);
});

test('missing new-tab id never reads or closes another page', async () => {
  const p = page();
  p.newTab = async () => undefined;
  await assert.rejects(withFeedPage(p, async () => assert.fail('must not read')), /not created/);
  assert.deepEqual(p.calls, []);
});

function addressContext(state, text = '') {
  const current = { memoizedProps: { value: { store: { getState: () => state } } } };
  // The stale SSR snapshot and the alternate fiber are deliberate traps.
  const root = { stateNode: { current }, memoizedProps: { store: { getState: () => { throw new Error('stale'); } } } };
  return {
    window: { __NEXT_DATA__: { props: { initialState: { location: { recentAddresses: { locations: [] } } } } } },
    document: { body: { innerText: text }, getElementById: () => ({ '__reactContainer$fixture': root }) },
    location: { href: 'https://deliveroo.co.uk/restaurants/london/test' },
  };
}
const liveState = () => ({ config: { user: { id: 1 } }, home: {}, location: { recentAddresses: { loading: false, error: null, locations: [
  { postcode: 'ZZ11ZZ', coordinates: [0, 0], formattedAddress: 'PRIVATE-STREET', phone: 'PRIVATE-PHONE' },
] } } });

test('reads the live store, not the empty SSR snapshot, and exports only lookup fields', () => {
  const result = vm.runInNewContext(RECENT_ADDRESSES_JS, addressContext(liveState()));
  assert.deepEqual(JSON.parse(JSON.stringify(result.locations)), [{ postcode: 'ZZ11ZZ', coordinates: [0, 0] }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('auth, challenge and missing or failed live state stay explicit', () => {
  const auth = liveState(); auth.config.user = {};
  assert.equal(vm.runInNewContext(RECENT_ADDRESSES_JS, addressContext(auth)).guard, 'auth');
  assert.equal(vm.runInNewContext(RECENT_ADDRESSES_JS, addressContext(liveState(), 'Just a moment')).guard, 'captcha');
  for (const state of [null, { ...liveState(), location: { recentAddresses: { error: 'PRIVATE' } } }]) {
    const result = vm.runInNewContext(RECENT_ADDRESSES_JS, addressContext(state));
    assert.ok(result.addressError);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('fiber walk is bounded and cycle safe', () => {
  const f = {}; f.child = f;
  const context = { document: { getElementById: () => ({ '__reactContainer$fixture': f }) } };
  assert.equal(vm.runInNewContext(FEED_STATE_JS, context, { timeout: 1000 }), null);
});

test('waits for addresses to load; a timeout never falls back to a default area', async () => {
  let calls = 0;
  const result = await readRecentAddresses({ evaluate: async () => ++calls === 1 ? { loading: true } : { locations: [{ postcode: 'fixture' }] }, wait: async () => {} });
  assert.equal(calls, 2); assert.equal(result.locations.length, 1);
  calls = 0;
  await assert.rejects(readRecentAddresses({ evaluate: async () => { calls++; return { loading: true }; }, wait: async () => {} }), /10 seconds/);
  assert.equal(calls, 10);
});

test('restaurant cards deduplicate and never export location or tracking parameters', () => {
  const link = (href, name) => ({ href, querySelector: selector => selector.includes('partner-name') ? { textContent: name } : null, getAttribute: () => '' });
  const links = [link('https://deliveroo.co.uk/menu/london/test/shop?geohash=PRIVATE&sp_id=PRIVATE', 'Fixture Ramen'),
    link('https://deliveroo.co.uk/menu/london/test/shop?geohash=OTHER', 'Duplicate'),
    link('https://example.org/menu/shop', 'External'), link('https://deliveroo.co.uk/menu/shop', '')];
  const rows = readRestaurantCards({ querySelectorAll: () => links });
  assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Fixture Ramen');
  assert.equal(rows[0].url, 'https://deliveroo.co.uk/menu/london/test/shop');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|OTHER|geohash|sp_id/);
});
