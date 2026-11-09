// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSources } from '../../src/server/sources.js';

/** @param {any} [over] */
const entry = (over = {}) => ({
  name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'public', allowTools: ['search'],
  headers: (/** @type {any} */ p) => ({ id: String(p?.id ?? '') }), ...over,
});

/**
 * A connect whose clients record events. A call with mode 'slow' waits on gate.promise,
 * 'boom' throws SECRET-CHARLIE, 'err' returns an isError result with SECRET-BRAVO, else ok.
 * @param {any[]} events
 */
function fakeConnect(events) {
  let n = 0;
  const gate = (() => { /** @type {() => void} */ let open = () => {}; const promise = new Promise((r) => { open = () => r(undefined); }); return { promise, open }; })();
  const connect = async (/** @type {any} */ _e, /** @type {any} */ headers) => {
    const id = `${headers.id ?? ''}#${++n}`;
    events.push({ op: 'open', id });
    return {
      async listTools() {
        events.push({ op: 'use', id });
        return { tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] };
      },
      async callTool(/** @type {any} */ { arguments: a }) {
        events.push({ op: 'use', id }, { op: 'callStart', id });
        try {
          if (a?.mode === 'slow') await gate.promise;
          if (a?.mode === 'boom') throw new Error('SECRET-CHARLIE down');
          if (a?.mode === 'err') return { isError: true, content: [{ type: 'text', text: 'SECRET-BRAVO denied' }] };
          return { content: [{ type: 'text', text: 'fine' }] };
        } finally { events.push({ op: 'callEnd', id }); }
      },
      async close() { events.push({ op: 'close', id }); },
    };
  };
  return { connect, gate };
}

/** A close that is not of the least recently used open client is a problem. @param {{ op: string, id: string }[]} events */
function closedNotLru(events) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, number>} */
  const used = new Map();
  events.forEach((e, t) => {
    if (e.op === 'open' || e.op === 'use') used.set(e.id, t);
    if (e.op === 'close') {
      const oldest = [...used.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
      if (oldest !== e.id) problems.push(`closed ${e.id} but ${oldest} was least recently used`);
      used.delete(e.id);
    }
  });
  return problems;
}

/** A close while a call is in flight on that client is a problem. @param {{ op: string, id: string }[]} events */
function closedWhileInUse(events) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, number>} */
  const inflight = new Map();
  for (const e of events) {
    if (e.op === 'callStart') inflight.set(e.id, (inflight.get(e.id) ?? 0) + 1);
    if (e.op === 'callEnd') inflight.set(e.id, (inflight.get(e.id) ?? 0) - 1);
    if (e.op === 'close' && (inflight.get(e.id) ?? 0) > 0) problems.push(`closed ${e.id} while a call was in flight`);
  }
  return problems;
}

/** The raw secret must not appear anywhere in the result. @param {any} result @param {string} secret */
function leaksError(result, secret) {
  return JSON.stringify(result).includes(secret) ? [`result contains ${secret}`] : [];
}

test('LRU: past maxClients the least recently used idle client is closed (planted fault: closing the newest)', async () => {
  /** @type {any[]} */ const events = [];
  const { connect } = fakeConnect(events);
  const s = createSources([entry()], { connect, maxClients: 2 });
  try {
    await s.toolset({ id: 'a' }, ['wiki']);
    await s.toolset({ id: 'b' }, ['wiki']);
    await s.toolset({ id: 'a' }, ['wiki']); // a is now more recent than b
    await s.toolset({ id: 'c' }, ['wiki']);
    assert.deepEqual(events.filter((e) => e.op === 'close').map((e) => e.id), ['b#2']);
    assert.deepEqual(closedNotLru(events), []);
    // planted: a cache that closed the most recently used client
    const bad = [{ op: 'open', id: 'a' }, { op: 'open', id: 'b' }, { op: 'use', id: 'a' }, { op: 'close', id: 'a' }];
    assert.equal(closedNotLru(bad).length, 1);
    // the cap holds: two clients still open
    const open = events.filter((e) => e.op === 'open').length - events.filter((e) => e.op === 'close').length;
    assert.equal(open, 2);
  } finally { await s.close(); }
});

test('refcount: forget does not close a client in use; it closes after (planted fault: closing at once)', async () => {
  /** @type {any[]} */ const events = [];
  const { connect, gate } = fakeConnect(events);
  const s = createSources([entry()], { connect });
  try {
    const ts = await s.toolset({ id: 'x' }, ['wiki']);
    assert.ok(ts);
    const slow = ts.call('wiki__search', { mode: 'slow' });
    while (!events.some((e) => e.op === 'callStart')) await new Promise((r) => setTimeout(r, 1));
    const boom = await ts.call('wiki__search', { mode: 'boom' }); // fails, so the client is forgotten
    assert.equal(boom.isError, true);
    assert.equal(events.some((e) => e.op === 'close'), false); // still in use
    assert.deepEqual(closedWhileInUse(events), []);
    gate.open();
    const done = await slow;
    assert.equal(done.isError, false);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(events.filter((e) => e.op === 'close').map((e) => e.id), ['x#1']);
    assert.deepEqual(closedWhileInUse(events), []);
    // the next use reconnects
    await ts.call('wiki__search', {});
    assert.equal(events.filter((e) => e.op === 'open').length, 2);
    // planted: a forget that closes at once
    const bad = [{ op: 'open', id: 'x' }, { op: 'callStart', id: 'x' }, { op: 'close', id: 'x' }, { op: 'callEnd', id: 'x' }];
    assert.equal(closedWhileInUse(bad).length, 1);
  } finally { gate.open(); await s.close(); }
});

test('private source errors never reach the model as raw text (planted fault: raw text)', async () => {
  const { connect } = fakeConnect([]);
  const s = createSources([entry({ visibility: 'private' }), entry({ name: 'pub' })], { connect });
  try {
    const priv = await s.toolset({}, ['wiki']);
    const pub = await s.toolset({}, ['pub']);
    assert.ok(priv && pub);
    const want = 'The source wiki returned an error.';
    for (const [mode, secret] of [['err', 'SECRET-BRAVO'], ['boom', 'SECRET-CHARLIE']]) {
      const r = await priv.call('wiki__search', { mode });
      assert.equal(r.text, want, mode);
      assert.equal(r.isError, true);
      assert.equal(r.source, 'wiki');
      assert.equal(r.visibility, 'private');
      assert.deepEqual(leaksError(r, secret), []);
    }
    const open = await pub.call('pub__search', { mode: 'err' });
    assert.equal(open.isError, true);
    assert.equal(open.text, 'SECRET-BRAVO denied');
    // planted: the raw text is reported
    assert.equal(leaksError({ text: 'The wiki source failed: SECRET-CHARLIE down' }, 'SECRET-CHARLIE').length, 1);
  } finally { await s.close(); }
});
