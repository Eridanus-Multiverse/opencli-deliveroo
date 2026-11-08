// Installer against a temp HOME and a fake `opencli` on PATH. Never touches the real ~/.opencli.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const INSTALL = fileURLToPath(new URL('../install.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'deliveroo-install-'));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

const bin = join(ROOT, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'opencli'), '#!/bin/sh\n' +
  'if [ "$1" = "--version" ]; then echo "$FAKE_OPENCLI_VERSION"; exit 0; fi\n' +
  'if [ "$FAKE_BRIDGE" = "down" ]; then echo "Error: Extension not connected" >&2; exit 1; fi\n' +
  'echo "deliveroo login ok"\n');
chmodSync(join(bin, 'opencli'), 0o755);
writeFileSync(join(bin, 'opencli.cmd'), '@echo off\r\n' +
  'if "%1"=="--version" (echo %FAKE_OPENCLI_VERSION%& exit /b 0)\r\n' +
  'if "%FAKE_BRIDGE%"=="down" (echo Error: Extension not connected 1>&2& exit /b 1)\r\n' +
  'echo deliveroo login ok\r\n');

function install(home, args = [], env = {}) {
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  const r = spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8', env: {
    ...process.env, HOME: home, USERPROFILE: home, [pathKey]: bin + delimiter + process.env[pathKey],
    FAKE_OPENCLI_VERSION: '1.8.7', FAKE_BRIDGE: 'up', ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}
const freshHome = () => mkdtempSync(join(ROOT, 'home-'));
const target = (home) => join(home, '.opencli', 'clis', 'deliveroo');

test('fresh install copies the adapter, then runs doctor', () => {
  const home = freshHome();
  const r = install(home);
  assert.equal(r.code, 0, r.out);
  for (const f of ['checkout.js', 'confirm.js', 'lib.js', 'doctor.js', 'LICENSE', '.installed-by-opencli-deliveroo']) assert.ok(existsSync(join(target(home), f)), f);
  assert.ok(!existsSync(join(target(home), 'install.mjs')) && !existsSync(join(target(home), 'test')));
  assert.match(r.out, /installed opencli-deliveroo/);
  assert.match(r.out, /deliveroo login ok/);
  assert.ok(!readdirSync(join(home, '.opencli')).some(n => n.startsWith('.deliveroo-staging')), 'no staging leftovers');
});

test('idempotent: a second run changes nothing; our own older install is updated without --force', () => {
  const home = freshHome();
  install(home);
  assert.match(install(home).out, /already installed and up to date/);
  writeFileSync(join(target(home), 'lib.js'), '// older version\n');
  const r = install(home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /installed/);
  assert.notEqual(readFileSync(join(target(home), 'lib.js'), 'utf8'), '// older version\n');
});

test('a different existing adapter is never overwritten without --force', () => {
  const home = freshHome();
  mkdirSync(target(home), { recursive: true });
  writeFileSync(join(target(home), 'mine.js'), '// someone else\n');
  const refused = install(home);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /--force/);
  assert.ok(existsSync(join(target(home), 'mine.js')));
  const forced = install(home, ['--force']);
  assert.equal(forced.code, 0, forced.out);
  const backups = readdirSync(join(home, '.opencli')).filter(n => n.startsWith('deliveroo-backup-'));
  assert.equal(backups.length, 1);
  assert.ok(existsSync(join(home, '.opencli', backups[0], 'mine.js')), 'backup kept outside clis/');
  assert.ok(!existsSync(join(target(home), 'mine.js')));
});

test('each failed check prints one plain next step', () => {
  const old = install(freshHome(), [], { FAKE_OPENCLI_VERSION: '1.8.6' });
  assert.equal(old.code, 1); assert.match(old.out, /too old .*npm install -g @jackwener\/opencli@latest/);
  const down = install(freshHome(), [], { FAKE_BRIDGE: 'down' });
  assert.equal(down.code, 1); assert.match(down.out, /Chrome is not connected to opencli/);
});

test('"doctor" only checks, never installs', () => {
  const home = freshHome();
  const r = install(home, ['doctor']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(target(home)));
});
