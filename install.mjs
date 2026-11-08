#!/usr/bin/env node
// Installer and setup check. No postinstall hooks; it runs only when you call it.
//
//   npx github:Eridanus-Multiverse/opencli-deliveroo            install or update, then check
//   npx github:Eridanus-Multiverse/opencli-deliveroo --force    replace a different existing adapter
//   npx github:Eridanus-Multiverse/opencli-deliveroo doctor     check only
//
// opencli loads user adapters from ~/.opencli/clis/<site>/ (see its README,
// "Quickly draft a private local adapter"), so the adapter files go to
// ~/.opencli/clis/deliveroo/.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_OPENCLI, versionAtLeast } from './lib.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const MARKER = '.installed-by-opencli-deliveroo';
const FILES = readdirSync(SRC).filter(f => f.endsWith('.js')).concat('LICENSE');
const say = (s) => console.log(s);
const fail = (s) => { console.error(s); process.exit(1); };

function opencli(args) {
  // Windows needs a shell to run the npm-installed opencli.cmd.
  return spawnSync('opencli', args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000 });
}

function checkOpencli() {
  if (!versionAtLeast(process.versions.node, '20.0.0')) fail('Node.js ' + process.versions.node + ' is too old: install Node.js 20 or newer from https://nodejs.org, then run this again.');
  const r = opencli(['--version']);
  const v = String(r.stdout || '').trim();
  if (r.error || r.status !== 0 || !v) fail('opencli is not installed: run "npm install -g @jackwener/opencli", then run this again.');
  if (!versionAtLeast(v, MIN_OPENCLI)) fail('opencli ' + v + ' is too old (need ' + MIN_OPENCLI + '+): run "npm install -g @jackwener/opencli@latest", then run this again.');
  say('ok  opencli ' + v);
}

function install(force) {
  const base = join(homedir(), '.opencli');
  const target = join(base, 'clis', 'deliveroo');
  const version = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).version;
  const same = () => FILES.every(f => existsSync(join(target, f)) && readFileSync(join(target, f)).equals(readFileSync(join(SRC, f))));
  let present = false;
  try { lstatSync(target); present = true; } catch { /* not installed */ }
  if (present) {
    const ours = existsSync(join(target, MARKER));
    if (ours && same()) return say('ok  adapter already installed and up to date at ' + target);
    if (!ours && !force) fail('A different deliveroo adapter already exists at ' + target + ': re-run with --force to replace it (the old one is kept as a backup).');
    if (!ours) {
      const backup = join(base, 'deliveroo-backup-' + Date.now()); // outside clis/, so opencli does not load it
      renameSync(target, backup);
      say('moved the previous adapter to ' + backup);
    }
  }
  // Stage outside clis/ and swap in with one rename, so opencli never sees half a copy.
  const stage = join(base, '.deliveroo-staging-' + process.pid);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const f of FILES) copyFileSync(join(SRC, f), join(stage, f));
  writeFileSync(join(stage, MARKER), version + '\n');
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true }); // only reached for our own older install or after the backup
  renameSync(stage, target);
  say('ok  installed opencli-deliveroo ' + version + ' to ' + target);
}

function doctor() {
  const r = opencli(['deliveroo', 'doctor']);
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status === 0) return say(out.trim());
  if (/extension|bridge|daemon|not connected/i.test(out)) fail('Chrome is not connected to opencli: open Chrome, install or enable the OpenCLI extension (README Quick start, step 3), then run: opencli deliveroo doctor');
  if (/unknown command|not found|no such/i.test(out)) fail('opencli cannot see the deliveroo adapter: run this installer again without "doctor".');
  fail(out.trim() || 'opencli deliveroo doctor failed without output: run "opencli doctor" to check the browser connection.');
}

const args = process.argv.slice(2);
checkOpencli();
if (!args.includes('doctor')) install(args.includes('--force'));
doctor();
