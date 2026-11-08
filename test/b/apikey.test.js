// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getApiKey, defaultKeyring } from '../../src/cli/apikey.js';
import { main } from '../../src/cli/main.js';

/** Tests never reach the network: the key check is faked. */
const OK_CHECK = async () => /** @type {const} */ ('ok');
import { tempHome } from './helpers.js';

const KEY = 'sk-ant-test-abc123';
const NO_KEY_MSG = 'No Anthropic API key. Run `ontologizer key set` in a terminal, or set ANTHROPIC_API_KEY.';

function fakeKeyring() {
  return {
    v: /** @type {string|null} */ (null), sets: 0, deletes: 0,
    get() { return this.v; },
    set(/** @type {string} */ k) { this.sets++; this.v = k; },
    delete() { this.deletes++; const had = this.v != null; this.v = null; return had; },
  };
}
/** @param {string[]} answers */
function fakeAsk(answers) {
  const f = async () => { f.calls++; return answers[Math.min(f.calls - 1, answers.length - 1)]; };
  f.calls = 0;
  return f;
}
function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; } }; }

test('prompts once, stores in the keychain, then reads it back without asking', async () => {
  const kr = fakeKeyring(); const ask = fakeAsk([KEY]); const stderr = cap();
  const r1 = await getApiKey({ keyring: kr, env: {}, interactive: true, validate: OK_CHECK, ask, stderr });
  assert.deepEqual(r1, { key: KEY, source: 'prompt' });
  assert.equal(ask.calls, 1);
  assert.equal(kr.sets, 1);
  assert.equal(kr.v, KEY);
  const r2 = await getApiKey({ keyring: kr, env: {}, interactive: true, validate: OK_CHECK, ask, stderr });
  assert.deepEqual(r2, { key: KEY, source: 'keychain' });
  assert.equal(ask.calls, 1);
});

test('planted fault: a keyring whose set() is a no-op makes the second call ask again', async () => {
  const kr = { get: () => null, set: () => {}, delete: () => false };
  const ask = fakeAsk([KEY]);
  await getApiKey({ keyring: kr, env: {}, interactive: true, validate: OK_CHECK, ask, stderr: cap() });
  await getApiKey({ keyring: kr, env: {}, interactive: true, validate: OK_CHECK, ask, stderr: cap() });
  assert.equal(ask.calls, 2); // so the test above would fail on a getApiKey that never stores
});

test('env key wins and the keyring is never read', async () => {
  const kr = { get() { throw new Error('keyring read'); }, set() { throw new Error('keyring write'); }, delete: () => false };
  const ask = async () => { throw new Error('asked'); };
  const r = await getApiKey({ keyring: kr, env: { ANTHROPIC_API_KEY: KEY }, interactive: true, validate: OK_CHECK, ask });
  assert.deepEqual(r, { key: KEY, source: 'env' });
});

test('planted fault: a keyring-first implementation would throw with that keyring', async () => {
  const kr = { get() { throw new Error('keyring read'); }, set() {}, delete: () => false };
  const keyringFirst = async () => { kr.get(); return getApiKey({ keyring: kr, env: { ANTHROPIC_API_KEY: KEY } }); };
  await assert.rejects(keyringFirst(), /keyring read/);
});

test('no key and not interactive: exact message, never asks', async () => {
  const kr = fakeKeyring(); const ask = fakeAsk([KEY]);
  await assert.rejects(getApiKey({ keyring: kr, env: {}, interactive: false, ask }), (e) => {
    assert.equal(/** @type {Error} */ (e).message, NO_KEY_MSG); return true;
  });
  assert.equal(ask.calls, 0);
});

test('a bad answer then a good one: asks twice and returns the second', async () => {
  const kr = fakeKeyring(); const ask = fakeAsk(['hello', KEY]); const stderr = cap();
  const r = await getApiKey({ keyring: kr, env: {}, interactive: true, validate: OK_CHECK, ask, stderr });
  assert.equal(r.key, KEY);
  assert.equal(ask.calls, 2);
  assert.match(stderr.out, /does not look like/);
});

test('three bad answers reject and nothing is stored', async () => {
  const kr = fakeKeyring(); const ask = fakeAsk(['hello', 'nope', '']);
  await assert.rejects(getApiKey({ keyring: kr, env: {}, interactive: true, validate: OK_CHECK, ask, stderr: cap() }), /No valid Anthropic API key/);
  assert.equal(ask.calls, 3);
  assert.equal(kr.sets, 0);
});

test('a keyring.set that throws still returns the key and warns on stderr', async () => {
  const kr = { get: () => null, set() { throw new Error('no keychain'); }, delete: () => false };
  const stderr = cap();
  const r = await getApiKey({ keyring: kr, env: {}, interactive: true, validate: OK_CHECK, ask: fakeAsk([KEY]), stderr });
  assert.deepEqual(r, { key: KEY, source: 'prompt' });
  assert.match(stderr.out, /Could not save the key to the keychain/);
  assert.ok(!stderr.out.includes(KEY));
});

test('defaultKeyring with ONTOLOGIZER_KEYRING=none is empty, a no-op, and loads no native module', () => {
  const kr = defaultKeyring({ ONTOLOGIZER_KEYRING: 'none' });
  assert.equal(kr.get(), null);
  assert.equal(kr.set(KEY), undefined);
  assert.equal(kr.get(), null); // set did nothing
  assert.equal(kr.delete(), false);
  const req = createRequire(import.meta.url);
  assert.ok(!Object.keys(req.cache).some((f) => f.includes('@napi-rs/keyring')), 'native keyring module was loaded');
});

/** @param {Record<string,string>} env @param {any} kr */
function run(argv, env, kr, extra = {}) {
  const stdout = cap(); const stderr = cap(); const home = tempHome();
  const p = main(argv, {
    env: { ...process.env, ONTOLOGIZER_HOME: home, ...env }, home, stdout, stderr,
    interactive: false, keyring: kr, openBrowser: async () => {}, onSignal: () => () => {}, validateKey: OK_CHECK, ...extra,
  });
  return p.then((code) => ({ code, stdout, stderr }));
}

test('key command: env key is reported by source, never printed', async () => {
  const { code, stdout, stderr } = await run(['key'], { ANTHROPIC_API_KEY: KEY }, fakeKeyring());
  assert.equal(code, 0);
  assert.match(stdout.out, /environment/);
  assert.ok(!(stdout.out + stderr.out).includes(KEY));
  assert.ok(!(stdout.out + stderr.out).includes('abc123'));
});

test('key command: keychain key is reported by source, never printed', async () => {
  const kr = fakeKeyring(); kr.v = KEY;
  const { code, stdout, stderr } = await run(['key'], {}, kr);
  assert.equal(code, 0);
  assert.match(stdout.out, /keychain/);
  assert.ok(!(stdout.out + stderr.out).includes('abc123'));
});

test('key command: no key exits 1', async () => {
  const { code, stdout } = await run(['key'], {}, fakeKeyring());
  assert.equal(code, 1);
  assert.match(stdout.out, /none: run ontologizer key set/);
});

test('key clear calls delete() on the keyring', async () => {
  const kr = fakeKeyring(); kr.v = KEY;
  const { code, stdout } = await run(['key', 'clear'], {}, kr);
  assert.equal(code, 0);
  assert.equal(kr.deletes, 1);
  assert.equal(kr.v, null);
  assert.match(stdout.out, /Removed the key/);
});

test('key set without a terminal exits 1 and asks nothing', async () => {
  const kr = fakeKeyring(); const ask = fakeAsk([KEY]);
  const { code, stderr } = await run(['key', 'set'], {}, kr, { ask });
  assert.equal(code, 1);
  assert.match(stderr.out, /needs a terminal/);
  assert.equal(ask.calls, 0);
  assert.equal(kr.sets, 0);
});

test('key set in a terminal stores the key and warns when env also has one', async () => {
  const kr = fakeKeyring(); const ask = fakeAsk([KEY]);
  const { code, stdout, stderr } = await run(['key', 'set'], { ANTHROPIC_API_KEY: 'sk-ant-test-envone' }, kr, { ask, interactive: true });
  assert.equal(code, 0);
  assert.equal(kr.v, KEY);
  assert.match(stdout.out, /takes precedence/);
  assert.ok(!(stdout.out + stderr.out).includes('abc123'));
});

// ---- key check before storing (1.1.0) ----
import http from 'node:http';
import { checkKey, promptAndStoreKey, PROMPT_REJECTED_MSG, UNVERIFIED_MSG } from '../../src/cli/apikey.js';

test('a key Anthropic rejects is not stored: the user is told and asked again (same 3 tries)', async () => {
  const kr = fakeKeyring(); const stderr = cap();
  const order = [];
  const BAD = 'sk-ant-test-rejected-1'; const GOOD = 'sk-ant-test-good-2';
  const validate = async (/** @type {string} */ k) => { order.push(`check:${k === GOOD ? 'good' : 'bad'}`); return k === GOOD ? 'ok' : 'rejected'; };
  const origSet = kr.set.bind(kr);
  kr.set = (/** @type {string} */ k) => { order.push('set'); origSet(k); };
  const r = await getApiKey({ keyring: kr, env: {}, interactive: true, ask: fakeAsk([BAD, GOOD]), stderr, validate });
  assert.equal(r.key, GOOD);
  assert.equal(kr.v, GOOD);
  assert.deepEqual(order, ['check:bad', 'check:good', 'set'], 'checked before storing, rejected key never stored');
  assert.ok(stderr.out.includes(PROMPT_REJECTED_MSG));
  assert.ok(!stderr.out.includes(BAD) && !stderr.out.includes(GOOD), 'a key appeared in the output');
  // Planted fault: a check that accepts everything would have stored the rejected key.
  const kr2 = fakeKeyring();
  await getApiKey({ keyring: kr2, env: {}, interactive: true, ask: fakeAsk([BAD, GOOD]), stderr: cap(), validate: OK_CHECK });
  assert.equal(kr2.v, BAD);
});

test('three rejected keys: nothing stored, the prompt gives up', async () => {
  const kr = fakeKeyring(); let sets = 0;
  kr.set = () => { sets++; };
  const ask = fakeAsk(['sk-ant-test-a1', 'sk-ant-test-a2', 'sk-ant-test-a3']);
  await assert.rejects(
    getApiKey({ keyring: kr, env: {}, interactive: true, ask, stderr: cap(), validate: async () => 'rejected' }),
    /No valid Anthropic API key/);
  assert.equal(sets, 0);
  assert.equal(ask.calls, 3);
});

test('no network (or a check that throws): the key is saved with a warning', async () => {
  for (const validate of [async () => /** @type {const} */ ('unverified'), async () => { throw new Error('boom'); }]) {
    const kr = fakeKeyring(); const stderr = cap();
    const r = await promptAndStoreKey({ keyring: kr, ask: fakeAsk(['sk-ant-test-offline']), stderr, validate: /** @type {any} */ (validate) });
    assert.equal(r, 'sk-ant-test-offline');
    assert.equal(kr.v, 'sk-ant-test-offline');
    assert.ok(stderr.out.includes(UNVERIFIED_MSG));
    assert.ok(!stderr.out.includes('sk-ant-test-offline') && !stderr.out.includes('boom'));
  }
});

test('`key set` checks the key too: rejected, then accepted; neither key is printed', async () => {
  const kr = fakeKeyring();
  const BAD = 'sk-ant-test-keyset-bad'; const GOOD = 'sk-ant-test-keyset-good';
  const { code, stdout, stderr } = await run(['key', 'set'], {}, kr, {
    interactive: true, ask: fakeAsk([BAD, GOOD]),
    validateKey: async (/** @type {string} */ k) => (k === GOOD ? 'ok' : 'rejected'),
  });
  assert.equal(code, 0, stderr.out);
  assert.equal(kr.v, GOOD);
  assert.ok(stderr.out.includes(PROMPT_REJECTED_MSG));
  for (const s of [stdout.out, stderr.out]) assert.ok(!s.includes(BAD) && !s.includes(GOOD));
});

test('checkKey against a local fake API: 401 rejected, 200 ok, unreachable unverified; no real network', async () => {
  /** @type {http.Server[]} */ const servers = [];
  /** @param {number} status */
  const fakeApi = (status) => new Promise((resolve) => {
    const seen = { auth: '', hits: 0 };
    const s = http.createServer((req, res) => {
      seen.hits++;
      // This SDK sends the key as "Authorization: Bearer <key>" (older ones used x-api-key).
      seen.auth = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '');
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(status === 200
        ? JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null })
        : JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid key' } }));
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${/** @type {any} */ (s.address()).port}` }));
  });
  const prev = process.env.ANTHROPIC_BASE_URL;
  try {
    /** @type {any} */ const bad = await fakeApi(401);
    process.env.ANTHROPIC_BASE_URL = bad.url;
    assert.equal(await checkKey('sk-ant-test-check-401'), 'rejected');
    assert.ok(bad.seen.hits >= 1, 'the check did not reach the local fake API');
    assert.ok(bad.seen.auth.endsWith('sk-ant-test-check-401')); // the key went only into the request header
    /** @type {any} */ const good = await fakeApi(200);
    process.env.ANTHROPIC_BASE_URL = good.url;
    assert.equal(await checkKey('sk-ant-test-check-200'), 'ok');
    assert.ok(good.seen.hits >= 1);
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'; // nothing listens there
    assert.equal(await checkKey('sk-ant-test-check-down'), 'unverified');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev;
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  }
});

// ---- review fixes: 403/500/hang are unverified; base URL policy ----
import { resolveBaseURL, makeClient, DEFAULT_BASE_URL } from '../../src/cli/apikey.js';

/** A local fake API answering `status` (or never, for 0). @param {number} status */
function localApi(status) {
  return new Promise((resolve) => {
    const seen = { hits: 0 };
    const s = http.createServer((req, res) => {
      seen.hits++;
      if (status === 0) return; // never answers
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'x', message: 'x' } }));
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, seen, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${/** @type {any} */ (s.address()).port}` } }));
  });
}

test('checkKey: 403 (a proxy or firewall) and 500 are unverified, not rejected; a silent server times out', async () => {
  const quiet = cap();
  for (const status of [403, 500]) {
    /** @type {any} */ const api = await localApi(status);
    try {
      assert.equal(await checkKey('sk-ant-test-x', { env: api.env, stderr: quiet }), 'unverified', String(status));
      assert.ok(api.seen.hits >= 1);
    } finally { api.s.closeAllConnections?.(); api.s.close(); }
  }
  /** @type {any} */ const hang = await localApi(0);
  try {
    const t = Date.now();
    assert.equal(await checkKey('sk-ant-test-x', { env: hang.env, stderr: quiet, timeoutMs: 300 }), 'unverified');
    const ms = Date.now() - t;
    assert.ok(ms < 2000, `took ${ms} ms`);
    assert.equal(hang.seen.hits, 1, 'no retries (maxRetries 0)');
  } finally { hang.s.closeAllConnections?.(); hang.s.close(); }
  // Planted fault: the old rule (403 → rejected) would lock out users behind a 403 proxy.
  const oldRule = (/** @type {number} */ st) => (st === 401 || st === 403 ? 'rejected' : 'unverified');
  assert.equal(oldRule(403), 'rejected');
});

test('the prompt says it is checking the key before the call', async () => {
  const stderr = cap(); const order = [];
  const write = stderr.write.bind(stderr);
  stderr.write = (/** @type {string} */ s) => { if (s.startsWith('Checking')) order.push('notice'); return write(s); };
  await promptAndStoreKey({ keyring: fakeKeyring(), ask: fakeAsk(['sk-ant-test-n']), stderr,
    validate: async () => { order.push('check'); return 'ok'; } });
  assert.deepEqual(order, ['notice', 'check']);
  assert.ok(stderr.out.includes('Checking the key with Anthropic…'));
});

test('base URL policy: explicit default; https or local http honoured with one notice; anything else refused', async () => {
  const err = cap();
  assert.equal(resolveBaseURL({ env: {}, stderr: err, state: { shown: false } }), DEFAULT_BASE_URL);
  assert.equal(err.out, '', 'no notice for the default');
  for (const bad of ['http://evil.example', 'http://10.0.0.5:8080', 'ftp://x', 'not a url', 'https://user:pw@proxy.example']) {
    assert.throws(() => resolveBaseURL({ env: { ANTHROPIC_BASE_URL: bad }, stderr: err, state: { shown: false } }),
      (e) => /ANTHROPIC_BASE_URL/.test(/** @type {Error} */ (e).message) && !/sk-ant/.test(/** @type {Error} */ (e).message), bad);
  }
  const state = { shown: false }; const note = cap();
  assert.equal(resolveBaseURL({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic/' }, stderr: note, state }), 'https://proxy.example/anthropic');
  resolveBaseURL({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic/' }, stderr: note, state });
  assert.equal(note.out, 'Using Anthropic API at proxy.example (from ANTHROPIC_BASE_URL)\n', 'one notice per process');
  for (const ok of ['http://localhost:8080', 'http://127.0.0.1:9']) {
    assert.ok(resolveBaseURL({ env: { ANTHROPIC_BASE_URL: ok }, stderr: cap(), state: { shown: false } }).startsWith('http://'));
  }
  // The real clients use it: the default is passed explicitly; a refused URL stops makeClient.
  const client = /** @type {any} */ (await makeClient('sk-ant-test-x', { env: {}, stderr: cap() }));
  assert.equal(client.baseURL, DEFAULT_BASE_URL);
  await assert.rejects(makeClient('sk-ant-test-x', { env: { ANTHROPIC_BASE_URL: 'http://evil.example' }, stderr: cap() }), /ANTHROPIC_BASE_URL/);
  // A refused URL also stops the key prompt: nothing is checked or stored.
  const kr = fakeKeyring();
  await assert.rejects(promptAndStoreKey({ keyring: kr, ask: fakeAsk(['sk-ant-test-y']), stderr: cap(),
    validate: (k) => checkKey(k, { env: { ANTHROPIC_BASE_URL: 'http://evil.example' }, stderr: cap() }) }), /ANTHROPIC_BASE_URL/);
  assert.equal(kr.v, null);
  // Planted fault: a resolver that accepts any URL would send the key to http://evil.example.
  const acceptsAnything = (/** @type {string} */ u) => u;
  assert.equal(acceptsAnything('http://evil.example'), 'http://evil.example');
});
