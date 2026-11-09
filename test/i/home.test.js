// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as flow from '../../web/home/flow.js';

const root = new URL('../../', import.meta.url);
/** @param {string} p */
const read = (p) => readFileSync(new URL(p, root), 'utf8');

/** @param {string} html @returns {string[]} */
function checkHtml(html) {
  const problems = [];
  for (const needle of ['id="new-map"', 'id="server-panel"', 'id="server-tokens"', '<!--importmap-->']) {
    if (!html.includes(needle)) problems.push(`missing ${needle}`);
  }
  return problems;
}

test('home page has the New map button, server panel, token list and importmap placeholder', () => {
  const html = read('web/home/index.html');
  assert.deepEqual(checkHtml(html), []);
  assert.ok(checkHtml(html.replace('id="new-map"', 'id="x"')).some((p) => p.includes('new-map')), 'planted fault');
});

/** @param {string} src @returns {string[]} */
export function colorLiterals(src) {
  const problems = [];
  if (/#[0-9a-fA-F]{3,8}\b/.test(src)) problems.push('hex color');
  if (/\b(?:rgba?|hsla?)\(/.test(src)) problems.push('rgb/hsl color');
  return problems;
}

test('home and server panel files carry no color literal', () => {
  for (const p of ['web/home/home.css', 'web/home/flow.js', 'web/home/main.js', 'web/shell/ui/server.js', 'web/shell/server-panel.js']) {
    assert.deepEqual(colorLiterals(read(p)), [], p);
  }
  assert.ok(colorLiterals('a { color: #ff0000 }').length, 'planted fault');
  assert.ok(colorLiterals('a { color: rgb(1,2,3) }').length, 'planted fault');
});

/** A fake fetch that answers check/build from a script and counts calls.
 * @param {(n: number) => any} checkReply */
function fakeFetch(checkReply) {
  const calls = { check: 0, build: 0, /** @type {any[]} */ bodies: [] };
  /** @type {any} */
  const fn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    assert.equal(init.credentials, 'same-origin');
    if (url.endsWith('/maps/check')) {
      assert.equal(init.headers['content-type'], 'application/json');
      calls.check++;
      const r = checkReply(calls.check);
      return { status: r.status ?? 200, json: async () => r.body };
    }
    if (url.endsWith('/maps') && init.method === 'POST') {
      calls.build++;
      calls.bodies.push(JSON.parse(init.body));
      return { status: 202, json: async () => ({ id: 'm1', viewUrl: '/v1/t/default/maps/m1/view', eventsUrl: '/e' }) };
    }
    throw new Error('unexpected ' + url);
  };
  return { fn, calls };
}

const NOT_READY = { body: { ready: false, questions: [{ id: 'q1', text: 'Which?', options: ['a', 'b'] }] } };

/** Drive the dialog like the UI: returns what was built and how many checks ran.
 * @param {number} max @param {(n: number) => any} reply */
async function drive(max, reply) {
  const { fn, calls } = fakeFetch(reply);
  let round = 0;
  /** @type {any} */ let step;
  for (let guard = 0; guard < 20; guard++) {
    const r = await flow.checkContext(fn, 'default', 'ctx', []);
    step = flow.nextStep({ round, result: r.body, context: 'ctx' });
    if (step.kind === 'confirm') break;
    round = step.round;
  }
  const b = await flow.startBuild(fn, 'default', { brief: step.brief, name: step.name });
  return { calls, step, b, max };
}

/** @param {{ calls: { check: number } }} d @returns {string[]} */
function checkCount(d) {
  return d.calls.check > 3 ? [`${d.calls.check} check calls`] : [];
}

test('never more than three check calls; fallback brief when never ready', async () => {
  const d = await drive(3, () => NOT_READY);
  assert.deepEqual(checkCount(d), []);
  assert.equal(d.calls.check, 3);
  assert.deepEqual(d.calls.bodies[0], { brief: { context: 'ctx', subject: 'ctx', scope: '', purpose: '', level: 'beginner' }, name: 'untitled' });
  assert.equal(flow.MAX_ROUNDS, 3);
});

test('planted fault: a driver that keeps asking is reported', async () => {
  const { fn, calls } = fakeFetch(() => NOT_READY);
  for (let i = 0; i < 4; i++) await flow.checkContext(fn, 'default', 'ctx', []);
  assert.ok(checkCount({ calls }).length > 0);
});

test('ready on round 0 builds at once with the returned brief and name', async () => {
  const brief = { context: 'c', subject: 's', scope: 'sc', purpose: 'p', level: 'advanced' };
  const d = await drive(3, () => ({ body: { ready: true, brief, name: 'nice' } }));
  assert.equal(d.calls.check, 1);
  assert.deepEqual(d.calls.bodies[0], { brief, name: 'nice' });
  assert.equal(d.b.ok, true);
  assert.equal(/** @type {any} */ (d.b).viewUrl, '/v1/t/default/maps/m1/view');
});

test('questions come back for rounds 1 and 2, then the fallback', () => {
  const r = NOT_READY.body;
  assert.equal(flow.nextStep({ round: 0, result: r, context: 'c' }).kind, 'questions');
  assert.equal(flow.nextStep({ round: 1, result: r, context: 'c' }).kind, 'questions');
  assert.equal(flow.nextStep({ round: 2, result: r, context: 'c' }).kind, 'confirm');
});

test('a 401 surfaces as status 401; network failure as status 0; 403 and server errors have text', async () => {
  const f401 = /** @type {any} */ (async () => ({ status: 401, json: async () => ({ ok: false, error: 'no token' }) }));
  const r = await flow.checkContext(f401, 'default', 'c', []);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(flow.describeFailure(r).kind, 'auth');
  const down = /** @type {any} */ (async () => { throw new Error('offline'); });
  const n = await flow.listMaps(down, 'default');
  assert.deepEqual([n.ok, n.status], [false, 0]);
  assert.match(flow.describeFailure({ ok: false, status: 403 }).text, /build scope/);
  assert.equal(flow.describeFailure({ ok: false, status: 500, error: 'boom' }).text, 'boom');
});

test('sign in posts the token; list and session are plain GETs', async () => {
  /** @type {any[]} */ const seen = [];
  const f = /** @type {any} */ (async (/** @type {string} */ u, /** @type {any} */ i) => { seen.push([u, i.method, i.body]); return { status: 200, json: async () => ({ ok: true, tenant: 't' }) }; });
  await flow.signIn(f, 'tok');
  await flow.getSession(f);
  await flow.listMaps(f, 't');
  assert.deepEqual(seen, [['/v1/session', 'POST', '{"token":"tok"}'], ['/v1/session', 'GET', undefined], ['/v1/t/t/maps', 'GET', undefined]]);
});

/** Problems for a `safeNext` implementation: good paths must pass, hostile values must give null.
 * @param {(search: string) => string|null} fn @returns {string[]} */
function checkSafeNext(fn) {
  /** @type {string[]} */
  const problems = [];
  for (const p of ['/v1/t/default/maps/demo/view', '/v1/t/a-b9/maps/m-1/view']) {
    const got = fn('?next=' + encodeURIComponent(p));
    if (got !== p) problems.push(`good path ${p} gave ${got}`);
  }
  const hostile = [
    '//evil.example/x', '/\\evil.example', 'https://evil.example/v1/t/default/maps/demo/view', 'javascript:alert(1)',
    '/v1/t/default/maps/demo/view/extra', '/v1/t/default/maps/demo/view?x=1', '/v1/t/default/maps/demo/view#h',
    '/v1/t/default/maps/demo', '/v1/t/default/maps/demo/view\n', '/v1/t/../maps/demo/view', '/v1/t/default/maps//view',
    '%2F%2Fevil.example', '/v1/t/default/maps/demo%2Fview', '/v1/t/default%2Fx/maps/demo/view', '/V1/t/default/maps/demo/view', '',
  ];
  for (const h of hostile) {
    for (const search of ['?next=' + encodeURIComponent(h), '?next=' + encodeURIComponent(encodeURIComponent(h))]) {
      const got = fn(search);
      if (got !== null) problems.push(`hostile ${JSON.stringify(h)} gave ${got}`);
    }
  }
  if (fn('') !== null || fn('?other=1') !== null) problems.push('missing next gave a path');
  return problems;
}

test('safeNext accepts only same-origin map page paths', () => {
  assert.deepEqual(checkSafeNext(flow.safeNext), []);
});

test('planted fault: a safeNext that only checks for a leading slash is reported', () => {
  const naive = (/** @type {string} */ s) => { const v = new URLSearchParams(s).get('next'); return v && v.startsWith('/') ? v : null; };
  const problems = checkSafeNext(naive);
  assert.ok(problems.some((p) => p.includes('//evil.example/x')));
});

/** Run three rounds through nextStep + checkContext; returns the bodies the server saw and the answers carried.
 * @param {(prev: any[], next: any[]) => any[]} add @returns {Promise<any[]>} */
async function threeRounds(add) {
  /** @type {any[]} */ const bodies = [];
  /** @type {any} */
  const fn = async (/** @type {string} */ _u, /** @type {any} */ init) => {
    bodies.push(JSON.parse(init.body));
    return { status: 200, json: async () => NOT_READY.body };
  };
  /** @type {{ id: string, answer: string }[]} */
  let answers = [];
  let round = 0;
  for (let i = 0; i < 3; i++) {
    const r = await flow.checkContext(fn, 'default', 'ctx', answers);
    const step = flow.nextStep({ round, result: r.body, context: 'ctx' });
    if (step.kind !== 'questions') break;
    round = step.round;
    answers = add(answers, [{ id: `q${i + 1}`, answer: ` a${i + 1} ` }, { id: 'skip', answer: '  ' }]);
  }
  return bodies;
}

/** @param {any[]} bodies @returns {string[]} */
function checkCarried(bodies) {
  /** @type {string[]} */
  const problems = [];
  if (bodies.length !== 3) problems.push(`${bodies.length} check calls`);
  const ids = (bodies[2]?.answers ?? []).map((/** @type {any} */ a) => a.id);
  if (JSON.stringify(ids) !== '["q1","q2"]') problems.push(`third check carried ${JSON.stringify(ids)}`);
  return problems;
}

test('answers add up across three rounds: the third check carries rounds 1 and 2', async () => {
  const bodies = await threeRounds(flow.addAnswers);
  assert.deepEqual(checkCarried(bodies), []);
  assert.deepEqual(bodies[2].answers, [{ id: 'q1', answer: 'a1' }, { id: 'q2', answer: 'a2' }]);
});

test('planted fault: an addAnswers that replaces is reported', async () => {
  const bodies = await threeRounds((_prev, next) => flow.cleanAnswers(next));
  assert.ok(checkCarried(bodies).length > 0);
});

test('addAnswers keeps order, replaces a repeated id in place and does not mutate', () => {
  const prev = [{ id: 'a', answer: '1' }, { id: 'b', answer: '2' }];
  const out = flow.addAnswers(prev, [{ id: 'a', answer: ' 9 ' }, { id: 'c', answer: '3' }, { id: 'd', answer: '' }]);
  assert.deepEqual(out, [{ id: 'a', answer: '9' }, { id: 'b', answer: '2' }, { id: 'c', answer: '3' }]);
  assert.deepEqual(prev, [{ id: 'a', answer: '1' }, { id: 'b', answer: '2' }]);
});
