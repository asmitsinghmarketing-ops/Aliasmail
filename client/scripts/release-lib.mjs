// Shared helpers for the app release scripts (release-android.mjs, release-desktop.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(CLIENT, '..');

/** Run a command, streaming its output; rejects when it exits non-zero. */
export function run(command, args, { cwd = ROOT, env = {} } = {}) {
  console.log(`\n> ${command} ${args.join(' ')}   (in ${path.relative(ROOT, cwd) || '.'})`);
  return new Promise((resolve, reject) => {
    // .cmd/.bat (npm, npx, gradlew) need a shell on Windows.
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}

/** Run a command and return its standard output. */
export function capture(command, args, { cwd = ROOT, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(command)} failed: ${(err || out).trim().slice(0, 400)}`))));
  });
}

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** "--version 1.2.0" style flags. */
export function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : true;
}

/** Bump the last numeric part: 1.1 -> 1.2, 1.0.3 -> 1.0.4. */
export function bumpVersion(version) {
  const parts = String(version).split('.').map((n) => Number.parseInt(n, 10) || 0);
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

/** Rewrite a file but keep its existing line endings (Windows checkouts use CRLF). */
export function writeKeepingEol(file, original, next) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(file, next.replace(/\r?\n/g, eol));
}

export function done(lines) {
  console.log(`\n${'='.repeat(64)}\n${lines.join('\n')}\n${'='.repeat(64)}`);
}
