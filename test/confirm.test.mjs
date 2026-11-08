// One-time confirm codes: issue, verify, consume once. Temp files only; all data is fake.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { basketFingerprint } from '../lib.js';
import { checkCode, claimCode, issueCode, loadPending, verifyConfirm } from '../confirm.js';

const CONFIRM_JS = new URL('../confirm.js', import.meta.url).href;
const items = [{ qty: 1, name: 'Fixture Fries', price: '£3.20' }];
const snapshot = (over = {}) => ({
  at: new Date().toISOString(), shop: 'Fixture Kitchen', items, total_pence: 529,
  fingerprint: basketFingerprint('Fixture Kitchen', items), payment: 'Test Card', address: 'Example Road · ZZ1**', ...over,
});
const live = (over = {}) => snapshot(over);
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'deliveroo-confirm-'));
  return { dir, path: join(dir, 'state', 'deliveroo-checkout.json'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('issued code round-trips and is the only thing that unlocks the preview', () => {
  const t = tmp();
  try {
    assert.equal(loadPending(t.path), null);
    const code = issueCode(snapshot(), t.path);
    assert.match(code, /^[0-9a-f]{8}$/);
    const pending = loadPending(t.path);
    assert.equal(pending.code, code);
    assert.ok(checkCode({ pending, code, now: Date.now() }));
    assert.ok(checkCode({ pending, code: ' ' + code.toUpperCase() + ' ', now: Date.now() }));
    assert.throws(() => checkCode({ pending, code: '00000000', now: Date.now() }), /does not match/);
    assert.throws(() => checkCode({ pending, code: '', now: Date.now() }), /does not match/);
    assert.throws(() => checkCode({ pending: null, code, now: Date.now() }), /No pending/);
    assert.throws(() => checkCode({ pending, code, now: Date.now() + 11 * 60000 }), /older than/);
    if (process.platform !== 'win32') assert.equal(statSync(t.path).mode & 0o777, 0o600);
  } finally { t.done(); }
});

test('a newer preview replaces the old code', () => {
  const t = tmp();
  try {
    const first = issueCode(snapshot(), t.path);
    const second = issueCode(snapshot(), t.path);
    assert.notEqual(first, second);
    assert.throws(() => checkCode({ pending: loadPending(t.path), code: first, now: Date.now() }));
  } finally { t.done(); }
});

test('corrupt state is an error, not "no preview"', () => {
  const t = tmp();
  try {
    issueCode(snapshot(), t.path);
    writeFileSync(t.path, '{not json');
    assert.throws(() => loadPending(t.path), /corrupt/);
  } finally { t.done(); }
});

test('verifyConfirm: every gate', () => {
  const pending = { ...snapshot(), code: 'abcdef12' };
  const ok = { pending, code: 'abcdef12', live: live(), tipPence: null, charityPence: null, capPence: null };
  assert.ok(verifyConfirm(ok));
  assert.ok(verifyConfirm({ ...ok, live: live({ total_pence: 579 }) }), 'fee drift within 50p is allowed');
  assert.throws(() => verifyConfirm({ ...ok, live: live({ total_pence: 580 }) }), /£0.50/);
  assert.throws(() => verifyConfirm({ ...ok, live: live({ fingerprint: 'deadbeefdeadbeef' }) }), /basket changed/);
  assert.throws(() => verifyConfirm({ ...ok, live: live({ payment: 'Other Card' }) }), /payment method/);
  assert.throws(() => verifyConfirm({ ...ok, live: live({ payment: '' }) }), /payment method/);
  assert.throws(() => verifyConfirm({ ...ok, live: live({ address: 'Sample Street · ZZ1**' }) }), /address/);
  assert.throws(() => verifyConfirm({ ...ok, live: live({ address: '(unreadable)' }) }), /address/);
  assert.throws(() => verifyConfirm({ ...ok, pending: { ...pending, address: '(unreadable)' }, live: live({ address: '(unreadable)' }) }), /address/);
  assert.throws(() => verifyConfirm({ ...ok, tipPence: 100 }), /tip/);
  assert.throws(() => verifyConfirm({ ...ok, charityPence: 25 }), /donation/);
  assert.throws(() => verifyConfirm({ ...ok, capPence: 500 }), /DELIVEROO_MAX_TOTAL/);
  assert.throws(() => verifyConfirm({ ...ok, code: 'ffffffff' }), /does not match/);
  assert.throws(() => verifyConfirm({ ...ok, now: Date.now() + 11 * 60000 }), /older than/);
});

test('a code is consumed exactly once', () => {
  const t = tmp();
  try {
    const code = issueCode(snapshot(), t.path);
    assert.ok(claimCode({ code, path: t.path }));
    assert.ok(!existsSync(t.path));
    assert.equal(loadPending(t.path), null);
    assert.throws(() => claimCode({ code, path: t.path }), /already used/);
  } finally { t.done(); }
});

test('claiming after a newer preview fails closed', () => {
  const t = tmp();
  try {
    const old = issueCode(snapshot(), t.path);
    issueCode(snapshot(), t.path);
    assert.throws(() => claimCode({ code: old, path: t.path }), /newer preview/);
  } finally { t.done(); }
});

test('five processes racing for one code: exactly one wins', async () => {
  const t = tmp();
  try {
    const code = issueCode(snapshot(), t.path);
    const script = `import { claimCode } from ${JSON.stringify(CONFIRM_JS)};
      try { claimCode({ code: ${JSON.stringify(code)}, path: ${JSON.stringify(t.path)} }); process.stdout.write('WON'); }
      catch { process.stdout.write('LOST'); }`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('error', reject);
      child.on('close', () => resolve(out));
    });
    const results = await Promise.all(Array.from({ length: 5 }, run));
    assert.equal(results.filter(r => r === 'WON').length, 1, results.join(','));
    assert.equal(results.filter(r => r === 'LOST').length, 4, results.join(','));
  } finally { t.done(); }
});
