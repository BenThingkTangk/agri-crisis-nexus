#!/usr/bin/env node
// Generate one salted scrypt account record for AGRIOS_AUTH_USERS_JSON.
//
// The raw password is read ONLY from stdin (never argv, so it never lands in
// your shell history or the process list) and is never printed or logged. The
// script emits a single JSON object containing the normalized email, display
// name, role, salt, and scrypt hash — safe to paste into the users array.
//
// Usage:
//   node scripts/hash-user.mjs --email ben@nirmata.example --name "Ben" --role owner
//   # then type the password at the prompt (input is hidden) and press Enter
//
//   # non-interactive (e.g. piping from a secret manager):
//   printf '%s' "$THE_PASSWORD" | node scripts/hash-user.mjs \
//     --email joel@nirmata.example --name "Joel" --role operator
//
// Combine two records into the env var:
//   AGRIOS_AUTH_USERS_JSON = [ {record1}, {record2} ]
//
// Roles: "owner" (high-impact actions, e.g. manual live-feed refresh) or
// "operator" (standard mission/intelligence access).

import { scryptSync, randomBytes } from 'node:crypto';
import { SCRYPT_PARAMS, ACCOUNT_ROLES } from '../api/_accounts.js';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function fail(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }

const email = String(arg('email') || '').trim().toLowerCase();
const name = String(arg('name') || '').trim();
const role = String(arg('role') || '').trim().toLowerCase();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('--email must be a valid email address');
if (!name || name.length > 80) fail('--name is required (1-80 chars)');
if (ACCOUNT_ROLES.indexOf(role) === -1) fail('--role must be one of: ' + ACCOUNT_ROLES.join(', '));

// Read the password from stdin without echoing when interactive.
function readPassword() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const interactive = stdin.isTTY;
    if (interactive) {
      process.stderr.write('Password (input hidden): ');
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    let done = false;
    function finish() {
      if (done) return; done = true;
      if (interactive) { try { stdin.setRawMode(false); } catch (e) {} process.stderr.write('\n'); }
      stdin.pause();
      stdin.removeListener('data', onData);
      resolve(buf);
    }
    stdin.on('end', finish);
    function onData(ch) {
      for (const c of ch) {
        const code = c.charCodeAt(0);
        if (c === '\n' || c === '\r' || code === 4) { // Enter or Ctrl-D
          finish();
          return;
        } else if (code === 3) { // Ctrl-C
          if (interactive) { try { stdin.setRawMode(false); } catch (e) {} }
          process.exit(130);
        } else if (code === 127 || code === 8) { // backspace / delete
          buf = buf.slice(0, -1);
        } else {
          buf += c;
        }
      }
    }
    stdin.on('data', onData);
  });
}

const password = await readPassword();
if (password.length < 10) fail('password must be at least 10 characters');
if (password.length > 400) fail('password is too long');

const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
  N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
}).toString('hex');

// Only non-secret derivation material is printed. The raw password is discarded.
process.stdout.write(JSON.stringify({ email, name, role, salt, hash }) + '\n');
