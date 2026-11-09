// @ts-check
// A 2D export and a 3D export pasted into one page, in either order: one element definition, the
// 3D export keeps its 3D view, the 2D export gets no 3D toggle. Runs the real built bundles in a
// small stand-in for the browser page (no DOM library in this repo), with planted faults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { bundleText } from './build-check.js';
import { viewsFor, REGISTRY_KEY, VIEWS_EVENT } from '../../web/embed/registry.js';

/** A page with just what the bundles touch while they load. */
function fakePage() {
  /** @type {Map<string, any>} */
  const defined = new Map();
  let defines = 0;
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  class FakeElement {
    constructor() { /** @type {Record<string, string>} */ this.attrs = {}; this.localName = ''; }
    /** @param {string} k */ getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    /** @param {string} k */ hasAttribute(k) { return k in this.attrs; }
    /** @param {string} k @param {string} v */ setAttribute(k, v) { this.attrs[k] = String(v); }
  }
  const document = {
    readyState: 'complete',
    /** @type {any} */ currentScript: null,
    /** @param {string} t @param {Function} fn */
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)?.add(fn); },
    /** @param {string} t @param {Function} fn */
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    /** @param {{ type: string }} e */
    dispatchEvent(e) { for (const fn of listeners.get(e.type) ?? []) fn(e); return true; },
    getElementById: () => null,
    createElement: () => new FakeElement(),
    documentElement: new FakeElement(),
  };
  const customElements = {
    /** @param {string} name @param {any} cls */
    define(name, cls) {
      if (defined.has(name)) throw new Error(`"${name}" has already been defined`);
      defined.set(name, cls);
      defines++;
    },
    /** @param {string} name */ get: (name) => defined.get(name),
  };
  class CustomEvent { /** @param {string} type */ constructor(type) { this.type = type; } }
  const ctx = vm.createContext({
    document, customElements, CustomEvent, HTMLElement: FakeElement, Event: CustomEvent,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    navigator: { userAgent: 'node' }, self: undefined, window: undefined,
  });
  ctx.self = ctx;
  ctx.window = ctx;
  /** One export: its <ontologizer-map>, then its <script> with the bundle. @param {string} code */
  const paste = (code) => {
    const map = new FakeElement();
    map.localName = 'ontologizer-map';
    document.currentScript = { previousElementSibling: map };
    vm.runInContext(code, ctx);
    document.currentScript = null;
    return map;
  };
  /** The views the element would offer this map. @param {any} map */
  const viewsOf = (map) => {
    const Cls = defined.get('ontologizer-map');
    const el = new Cls();
    el.attrs = map.attrs;
    // copied out of the page's realm, so deepEqual compares plain arrays
    return Array.from(el.views(), (/** @type {{ id: string }} */ v) => String(v.id));
  };
  return { paste, viewsOf, defined, defineCount: () => defines, ctx };
}

for (const order of /** @type {const} */ (['2D first', '3D first'])) {
  test(`a 2D and a 3D export on one page, ${order}: only the 3D one has the 3D view`, async () => {
    const two = await bundleText();
    const three = await bundleText(true);
    const page = fakePage();
    const [map2, map3] = order === '2D first'
      ? (() => { const a = page.paste(two); const b = page.paste(three); return [a, b]; })()
      : (() => { const b = page.paste(three); const a = page.paste(two); return [a, b]; })();
    assert.equal(page.defined.has('ontologizer-map'), true);
    assert.equal(page.defined.has('onto-sky'), true, 'the 3D view is defined in both orders');
    assert.equal(page.defineCount(), 3, 'ontologizer-map, onto-graph and onto-sky, each once');
    assert.equal(map2.getAttribute('data-views'), 'graph-2d');
    assert.equal(map3.getAttribute('data-views'), 'graph-2d sky-3d');
    assert.deepEqual(page.viewsOf(map2), ['graph-2d'], 'no 3D toggle on the 2D export');
    assert.deepEqual(page.viewsOf(map3), ['graph-2d', 'sky-3d'], 'the 3D export has its 3D view');
    // One registry for the page, on a symbol key: nothing enumerable added to the page, no prototype touched.
    assert.equal(page.ctx[REGISTRY_KEY]?.constructor?.name, 'Map');
    assert.equal(Object.getOwnPropertyDescriptor(page.ctx, REGISTRY_KEY)?.enumerable, false);
    assert.equal(Object.keys(page.ctx).some((k) => /ontologizer/i.test(k)), false);
  });
}

test('each bundle part that adds views tells the page, so a map drawn before the 3D add-on ran can offer it', async () => {
  const page = fakePage();
  let told = 0;
  page.ctx.document.addEventListener(VIEWS_EVENT, () => { told++; });
  page.paste(await bundleText(true));
  assert.equal(told, 2, 'the 2D part, then the 3D add-on');
});

test('two 2D exports on one page: one definition, neither has a 3D toggle', async () => {
  const two = await bundleText();
  const page = fakePage();
  const a = page.paste(two);
  const b = page.paste(two);
  assert.equal(page.defineCount(), 2);
  assert.deepEqual(page.viewsOf(a), ['graph-2d']);
  assert.deepEqual(page.viewsOf(b), ['graph-2d']);
});

test('planted fault: a 3D bundle wrapped whole in the old one-definition guard loses its 3D view', async () => {
  const two = await bundleText();
  const three = await bundleText(true);
  const page = fakePage();
  page.paste(two);
  const old = `if(!(globalThis.customElements&&customElements.get("ontologizer-map"))){${three}}`;
  const map3 = page.paste(old);
  assert.equal(page.defined.has('onto-sky'), false);
  assert.deepEqual(page.viewsOf(map3), ['graph-2d'], 'the planted bundle really drops 3D');
});

test('viewsFor: the attribute picks views; none, or naming none on the page, means all', () => {
  const all = [{ id: 'graph-2d', label: '2D', elementName: 'a' }, { id: 'sky-3d', label: '3D', elementName: 'b' }];
  assert.deepEqual(viewsFor('graph-2d', all).map((v) => v.id), ['graph-2d']);
  assert.deepEqual(viewsFor('sky-3d  graph-2d', all).map((v) => v.id), ['graph-2d', 'sky-3d']);
  assert.deepEqual(viewsFor(null, all), all);
  assert.deepEqual(viewsFor('', all), all);
  assert.deepEqual(viewsFor('nope', all), all);
});
