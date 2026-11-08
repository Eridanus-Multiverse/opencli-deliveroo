// deliveroo restaurants: read-only list of restaurants that deliver to a saved address.
//
// Located by an address saved in your Deliveroo account (default: most recent;
// --address picks one by postcode). The address stays in the page: output only
// carries the masked postcode.
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  AREA, GUARD_JS, clampLimit, firstOf, formatRating, guardPage,
  maskPostcode, money, pickAddress, scrubUrl,
} from './lib.js';
import { FEED_STATE_JS as STATE_JS, RESTAURANT_CARDS_JS, readRecentAddresses, withFeedPage } from './feed-page.js';

cli({
  site: 'deliveroo',
  name: 'restaurants',
  access: 'read',
  description: 'Deliveroo restaurants: list restaurants delivering to your saved address (read-only)',
  domain: 'deliveroo.co.uk',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'q', positional: true, required: false, help: 'Keyword or cuisine, e.g. ramen / pizza; omit to list all' },
    { name: 'limit', type: 'int', default: 15, help: 'Max restaurants (<=15)' },
    { name: 'address', type: 'string', help: 'Pick a saved address by postcode; default is the most recently used one' },
  ],
  columns: ['name', 'cuisine', 'rating', 'delivery_fee', 'eta', 'url'],
  navigateBefore: false,
  func: async (page, kwargs) => withFeedPage(page, async () => {
    const limit = clampLimit(kwargs.limit, 15, 15);
    const q = String(kwargs.q || '').trim();

    // 1) Read the saved addresses.
    const seed = await readRecentAddresses(page);
    guardPage(seed);
    if (seed.addressError) throw new Error('Could not read saved addresses: ' + seed.addressError);
    if (!seed.loggedIn) {
      throw new Error('Not logged in to Deliveroo. Log in yourself in Chrome; this tool never touches login.');
    }

    const addr = pickAddress(seed.locations, kwargs.address);

    // 2) Load the feed for that address's geohash.
    const feedUrl = 'https://deliveroo.co.uk/restaurants/' + AREA + '?geohash=' + addr.geohash
      + (q ? '&q=' + encodeURIComponent(q) : '');
    await page.goto(feedUrl);
    await page.wait(5);

    const data = await page.evaluate(`
      (() => {
        const guard = ${GUARD_JS};
        if (guard) return { guard };
        const s = ${STATE_JS};
        const feed = (s.home || {}).feed || {};
        const meta = feed.meta || {};

        const out = ${RESTAURANT_CARDS_JS};
        return {
          guard: '',
          rows: out,
          scanned: out.length,
          city: meta.location && meta.location.cityName,
          hood: meta.location && meta.location.neighborhoodName,
          count: (meta.restaurantCount || {}).results,
          warnings: (meta.warnings || []).map(w => w && w.type).filter(Boolean),
        };
      })()
    `);
    guardPage(data);

    // Error branches follow the same privacy rule: the geohash is metre-level,
    // so errors name the address only by its masked postcode.
    if ((data.warnings || []).includes('LOCATION_NO_DELIVERY')) {
      return [{
        name: `Deliveroo does not deliver to this address (${maskPostcode(addr.postcode)})`,
        cuisine: '', rating: '', delivery_fee: '', eta: '',
        url: '',
      }];
    }

    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      // Do not pretend there are no restaurants nearby; say the reader may be broken.
      return [{
        name: `No restaurants found (scanned ${data.scanned} candidates). Deliveroo may have changed its page.`,
        cuisine: '', rating: '', delivery_fee: '', eta: '',
        url: scrubUrl(feedUrl),
      }];
    }

    // The URL q already filtered server-side; filter again by name/cuisine.
    // Zero matches means zero matches: never fall back to the unfiltered list.
    let picked = rows;
    if (q) {
      const needle = q.toLowerCase();
      picked = rows.filter(r =>
        String(r.name).toLowerCase().includes(needle) ||
        String(r.category).toLowerCase().includes(needle));
      if (!picked.length) {
        return [{
          name: `- No restaurant matches "${q.slice(0, 40)}" (0 of ${rows.length} nearby) -`,
          cuisine: '', rating: '', delivery_fee: '', eta: '', url: '',
        }];
      }
    }

    const out = picked.slice(0, limit).map(r => ({
      name: String(r.name).slice(0, 48) + (r.open === false ? ' (closed)' : ''),
      cuisine: String(r.category || '').slice(0, 24),
      rating: formatRating(r.rating),
      delivery_fee: money(r.fee),
      eta: String(typeof r.eta === 'object' ? firstOf(r.eta, ['title', 'text', 'value']) : (r.eta || '')).slice(0, 18),
      url: r.url || (r.uname ? 'uname:' + r.uname : ''),
    }));

    // Footer: which address (masked) and how many restaurants.
    out.push({
      name: `- ${data.count ?? picked.length} restaurants · delivering to ${maskPostcode(addr.postcode)} ${data.hood ? '(' + data.hood + ')' : ''} -`,
      cuisine: '', rating: '', delivery_fee: '', eta: '', url: '',
    });
    return out;
  }),
});
