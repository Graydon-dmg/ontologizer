// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, listSources } from '../../web/home/flow.js';
import { explainModel, refItem, privateBadge } from '../../web/shell/explain.js';
import { panelRows, tokenLines, sourceLines, portsLine } from '../../web/shell/server-panel.js';

const brief = { context: 'c', subject: 's', scope: '', purpose: '', level: 'beginner' };

test('build body: sources only when the picker was shown, exactly the checked names', () => {
  assert.deepEqual(buildBody({ brief, name: 'n' }), { brief, name: 'n' });
  assert.deepEqual(buildBody({ brief, name: 'n' }, { shown: false, checked: ['wiki'] }), { brief, name: 'n' });
  assert.deepEqual(buildBody({ brief, name: 'n' }, { shown: true, checked: ['wiki'] }).sources, ['wiki']);
  assert.deepEqual(buildBody({ brief }, { shown: true, checked: [] }).sources, []);
  // planted fault: a builder that always sends sources, or sends unchecked ones, is caught
  const always = (/** @type {any} */ spec, /** @type {any} */ p) => ({ ...spec, sources: p.checked });
  assert.notDeepEqual(always({ brief }, { shown: false, checked: ['wiki'] }), buildBody({ brief }, { shown: false, checked: ['wiki'] }));
  const all = (/** @type {any} */ spec, /** @type {any} */ p) => ({ ...spec, sources: ['wiki', 'docs'] });
  assert.notDeepEqual(all({ brief }, { shown: true, checked: ['wiki'] }), buildBody({ brief }, { shown: true, checked: ['wiki'] }));
});

test('sources list: empty, 404 and errors keep the picker hidden', async () => {
  const mk = (/** @type {number} */ status, /** @type {any} */ body) => async () => ({ status, json: async () => body });
  assert.deepEqual(await listSources(/** @type {any} */ (mk(404, { ok: false })), 'default'), []);
  assert.deepEqual(await listSources(/** @type {any} */ (mk(200, [])), 'default'), []);
  assert.deepEqual(await listSources(/** @type {any} */ (async () => { throw new Error('x'); }), 'default'), []);
  assert.deepEqual(await listSources(/** @type {any} */ (mk(200, [{ name: 'wiki', visibility: 'private' }])), 'default'), [{ name: 'wiki', visibility: 'private' }]);
});

const onto = (/** @type {any} */ node) => /** @type {any} */ ({ nodes: { a: { id: 'a', label: 'A', ...node } }, jobs: {}, view: {}, lenses: {} });

test('explain model: refs are listed even with an article; web sources unchanged', () => {
  const web = { title: 'W', url: 'https://w.example/' };
  const ref = { source: 'wiki', ref: 'page/1', title: 'Page one', url: 'https://wiki.example/1' };
  const m = /** @type {any} */ (explainModel(onto({ sources: [web, ref], article: { summary: 's', sources: [web] } }), 'a'));
  assert.deepEqual(m.sources, [web]);
  assert.deepEqual(m.refs, [{ text: 'wiki · Page one', href: 'https://wiki.example/1' }]);
  const m2 = /** @type {any} */ (explainModel(onto({ sources: [web, ref] }), 'a'));
  assert.deepEqual(m2.sources, [web]);
  assert.equal(m2.refs.length, 1);
  assert.deepEqual(/** @type {any} */ (explainModel(onto({}), 'a')).refs, []);
});

test('a ref with an unsafe url is plain text; no title falls back to the ref', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'not a url', 'file:///etc/passwd']) {
    assert.equal(refItem({ source: 'wiki', ref: 'r', url }).href, null, url);
  }
  assert.deepEqual(refItem({ source: 'wiki', ref: 'r' }), { text: 'wiki · r', href: null });
  // planted fault: a helper that trusts any url would link javascript:
  const naive = (/** @type {any} */ r) => ({ text: r.source, href: r.url });
  assert.equal(naive({ source: 'w', url: 'javascript:alert(1)' }).href, 'javascript:alert(1)');
});

test('private badge: private once raised, never back', () => {
  let b = privateBadge({ visibility: 'public', privateSources: [] }, []);
  assert.equal(b.show, false);
  b = privateBadge({ visibility: 'private', privateSources: ['wiki'] }, [], b);
  assert.deepEqual(b, { show: true, title: 'Private: built from wiki' });
  // a later snapshot or event claiming public must not hide it (planted fault)
  b = privateBadge({ visibility: 'public', privateSources: [] }, [{ t: 'visibility.raised', to: 'public' }, { t: 'x', visibility: 'public' }], b);
  assert.equal(b.show, true);
  const live = privateBadge({ visibility: 'public' }, [{ t: 'visibility.raised', at: 1, to: 'private', reason: 'source', sources: ['docs', 'wiki'] }]);
  assert.deepEqual(live, { show: true, title: 'Private: built from docs, wiki' });
  assert.equal(privateBadge(null, []).show, false);
});

test('server panel: sources and ports shown when present, hidden for an I1 status', () => {
  const s = { tenant: 'default', store: 'files', auth: 'tokens', maps: 1,
    sources: [{ name: 'wiki', visibility: 'private', reachable: true }, { name: 'docs', visibility: 'public', reachable: false }],
    ports: { identity: 'tokens', policy: 'default', store: 'files', model: 'default' },
    tokens: [{ name: 'ci', scopes: ['read'], sources: ['wiki'] }, { name: 'v', scopes: ['read'] }] };
  assert.deepEqual(sourceLines(s), ['wiki — private, reachable', 'docs — public, unreachable']);
  assert.equal(portsLine(s), 'identity: tokens · policy: default · store: files · model: default');
  assert.deepEqual(tokenLines(s.tokens), ['ci — read · sources: wiki', 'v — read']);
  const i1 = { tenant: 'default', store: 'files', auth: 'open', maps: 0, tokens: [] };
  assert.equal(sourceLines(i1), null);
  assert.equal(portsLine(i1), null);
  assert.ok(panelRows(i1).length >= 4);
  // planted fault: an I1 status must not show a Sources section; a formatter defaulting to [] would
  assert.notEqual(sourceLines(i1), []);
});
