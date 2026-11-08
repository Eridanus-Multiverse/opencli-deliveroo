// One-time confirm codes for checkout.
//
// `checkout --preview` reads the checkout page, saves that snapshot together
// with a random code, and prints the code. `checkout --confirm <code>` pays
// only if the code matches the latest preview, the preview is under 10 minutes
// old, and the live page still matches it (same basket fingerprint, total
// within 50p, same payment method, same street-level address, no tip or
// donation, under the optional cap). The code is consumed right before the
// single payment keypress, so one code can place at most one order. A newer
// preview replaces the previous code.
//
// ponytail: the code is a human-in-the-loop speed bump, not authentication.
// Any process running as your user can read the state file.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ADDRESS_UNREADABLE, PREVIEW_MAX_AGE_MS,
  assertNoTipOrDonation, assertPreviewMatches, assertUnderCap,
} from './lib.js';

/** Where the pending preview lives: the user's opencli state dir. */
export const pendingPath = () => join(homedir(), '.opencli', 'state', 'deliveroo-checkout.json');

/** Save the snapshot with a fresh code (atomic write, owner-only). Returns the code. */
export function issueCode(snapshot, path = pendingPath()) {
  const code = randomBytes(4).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify({ ...snapshot, code }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return code;
}

/** The latest preview, or null if there is none. A corrupt file is an error, not "none". */
export function loadPending(path = pendingPath()) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error('Cannot read the pending checkout (' + e.message + '). Not paying.');
  }
  try { return JSON.parse(text); } catch {
    throw new Error('The pending checkout file is corrupt. Not paying; run a new preview.');
  }
}

/** Cheap checks before touching the browser: a matching, unexpired code. */
export function checkCode({ pending, code, now }) {
  if (!pending) throw new Error('No pending checkout. Run `opencli deliveroo checkout --preview` first. Not paying.');
  if (!code || typeof pending.code !== 'string' || String(code).trim().toLowerCase() !== pending.code) {
    throw new Error('Confirm code does not match the latest preview (each new preview replaces the old code). Not paying.');
  }
  const at = Date.parse(pending.at);
  if (!Number.isFinite(at) || now < at || now - at > PREVIEW_MAX_AGE_MS) {
    throw new Error('The preview for this code is older than ' + (PREVIEW_MAX_AGE_MS / 60000) + ' minutes. Not paying; run a new preview.');
  }
  return true;
}

// Street + masked postcode only; the city part picks up stray page text.
const addrKey = (a) => {
  const parts = String(a ?? '').split(' · ');
  const street = parts[0]?.trim();
  const postcode = parts.at(-1)?.trim();
  if (parts.length < 2 || !street || street === ADDRESS_UNREADABLE || !/^[A-Z]{1,2}\d\*\*$/.test(postcode)) return null;
  return street + '|' + postcode;
};

/**
 * Every gate, run against a fresh read of the checkout page. Called once
 * before a dry run reports success and again right before the code is consumed.
 */
export function verifyConfirm({ pending, code, live, tipPence, charityPence, capPence, now = Date.now() }) {
  checkCode({ pending, code, now });
  assertPreviewMatches({ preview: pending, now, totalPence: live.total_pence, fingerprint: live.fingerprint });
  assertUnderCap({ totalPence: live.total_pence, capPence });
  assertNoTipOrDonation({ tipPence, charityPence });
  const method = (v) => String(v ?? '').trim();
  if (!method(live.payment) || method(live.payment) !== method(pending.payment)) {
    throw new Error('The selected payment method changed since the preview. Not paying; run a new preview.');
  }
  const savedAddress = addrKey(pending.address), liveAddress = addrKey(live.address);
  if (!savedAddress || !liveAddress || savedAddress !== liveAddress) {
    throw new Error('The delivery address changed since the preview (street or postcode). Not paying; run a new preview.');
  }
  return true;
}

/**
 * Consume the code. Renaming the file is atomic: of two concurrent confirms,
 * exactly one rename succeeds. After this returns the code is gone for good,
 * whatever happens next; a failed or unknown payment needs a new preview.
 */
export function claimCode({ code, path = pendingPath() }) {
  const used = path + '.used';
  try { renameSync(path, used); } catch (e) {
    if (e.code === 'ENOENT') throw new Error('This confirm code was already used or replaced. Not paying.');
    throw new Error('Could not consume the confirm code (' + e.message + '). Not paying.');
  }
  // A preview that ran in between would have replaced our code: we just consumed
  // someone else's, so stop (fail closed; that preview must be redone).
  const claimed = loadPending(used);
  if (!claimed || claimed.code !== String(code).trim().toLowerCase()) {
    throw new Error('A newer preview replaced this confirm code. Not paying.');
  }
  // Persist the rename before paying. Windows cannot open a directory; the rename already happened.
  let dir;
  try { dir = openSync(dirname(path), 'r'); fsyncSync(dir); } catch { /* best effort */ } finally { if (dir !== undefined) closeSync(dir); }
  return true;
}
