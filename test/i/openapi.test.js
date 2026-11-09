// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// GET /v1/openapi.json is made from src/ops.js. Its structure is checked offline (no validator package).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS, openApi, COST_NOTE } from '../../src/ops.js';
import { boot, req } from './helpers-service.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Problems in a schema (it must be an object; nested schemas checked too). @param {any} s @param {string} at @param {string[]} out
 */
function schemaProblems(s, at, out) {
  if (s === true || s === false) return;
  if (!s || typeof s !== 'object' || Array.isArray(s)) { out.push(`${at}: a schema must be an object`); return; }
  if (s.type !== undefined && !(typeof s.type === 'string' || (Array.isArray(s.type) && s.type.every((/** @type {any} */ t) => typeof t === 'string')))) out.push(`${at}: bad type`);
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((/** @type {any} */ r) => typeof r !== 'string'))) out.push(`${at}: required must list names`);
  if (Array.isArray(s.required) && s.properties) {
    for (const r of s.required) if (!(r in s.properties)) out.push(`${at}: required "${r}" is not a property`);
  }
  for (const [k, v] of Object.entries(s.properties ?? {})) schemaProblems(v, `${at}.properties.${k}`, out);
  if (s.items) schemaProblems(s.items, `${at}.items`, out);
  for (const k of ['oneOf', 'anyOf', 'allOf']) for (const [i, v] of (s[k] ?? []).entries()) schemaProblems(v, `${at}.${k}[${i}]`, out);
}

/**
 * An OpenAPI 3.1 structure check: the parts every tool reading it relies on.
 * @param {any} doc @returns {string[]}
 */
export function openApiProblems(doc) {
  /** @type {string[]} */
  const p = [];
  if (doc?.openapi !== '3.1.0') p.push(`openapi is ${doc?.openapi}, not 3.1.0`);
  if (typeof doc?.info?.title !== 'string' || typeof doc?.info?.version !== 'string') p.push('info needs a title and a version');
  if (!doc?.paths || typeof doc.paths !== 'object') { p.push('no paths'); return p; }
  const schemes = Object.keys(doc.components?.securitySchemes ?? {});
  const ids = new Set();
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith('/')) p.push(`${path}: a path starts with /`);
    const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const [method, op] of Object.entries(/** @type {any} */ (item))) {
      const at = `${method.toUpperCase()} ${path}`;
      if (!METHODS.includes(method)) { p.push(`${at}: not an HTTP method`); continue; }
      if (typeof op.operationId !== 'string' || !op.operationId) p.push(`${at}: no operationId`);
      else if (ids.has(op.operationId)) p.push(`${at}: operationId ${op.operationId} used twice`);
      ids.add(op.operationId);
      if (!op.responses || !Object.keys(op.responses).length) p.push(`${at}: no responses`);
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        if (!/^[1-5]\d\d$|^default$/.test(code)) p.push(`${at}: response code ${code}`);
        if (typeof /** @type {any} */ (r)?.description !== 'string') p.push(`${at}: response ${code} has no description`);
        for (const [type, media] of Object.entries(/** @type {any} */ (r)?.content ?? {})) schemaProblems(/** @type {any} */ (media).schema, `${at} ${code} ${type}`, p);
      }
      const params = op.parameters ?? [];
      const seen = new Set();
      for (const prm of params) {
        const key = `${prm.in}:${prm.name}`;
        if (seen.has(key)) p.push(`${at}: parameter ${key} twice`);
        seen.add(key);
        if (!['path', 'query', 'header', 'cookie'].includes(prm.in)) p.push(`${at}: parameter ${prm.name} in ${prm.in}`);
        if (prm.in === 'path' && prm.required !== true) p.push(`${at}: path parameter ${prm.name} must be required`);
        if (prm.in === 'path' && !inPath.includes(prm.name)) p.push(`${at}: path parameter ${prm.name} is not in the path`);
        schemaProblems(prm.schema, `${at} parameter ${prm.name}`, p);
      }
      for (const name of inPath) {
        if (!params.some((/** @type {any} */ x) => x.in === 'path' && x.name === name)) p.push(`${at}: path parameter {${name}} is not declared`);
      }
      if (method === 'post' && !op.requestBody?.content?.['application/json']?.schema) p.push(`${at}: a POST needs a JSON request body`);
      if (op.requestBody) schemaProblems(op.requestBody.content?.['application/json']?.schema, `${at} body`, p);
      for (const req of op.security ?? []) for (const name of Object.keys(req)) if (!schemes.includes(name)) p.push(`${at}: unknown security scheme ${name}`);
    }
  }
  return p;
}

test('the OpenAPI document is well formed, covers every public op, and leaves out the page\'s own routes', () => {
  const doc = openApi({ version: '9.9.9' });
  assert.deepEqual(openApiProblems(doc), []);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc, 'plain JSON');
  const opsIn = Object.values(doc.paths).flatMap((item) => Object.values(item).flatMap((o) => o['x-ontologizer'].ops));
  for (const op of OPS) {
    if (op.internal) assert.ok(!opsIn.includes(op.name), `${op.name} is internal`);
    else assert.ok(opsIn.includes(op.name), `${op.name} is in OpenAPI`);
  }
  // The jobs share POST .../actions: one operation whose body is oneOf their inputs, each with its fixed type.
  const actions = doc.paths['/v1/t/{tenant}/maps/{id}/actions'].post;
  assert.equal(actions.operationId, 'view_action');
  assert.deepEqual(actions['x-ontologizer'].ops, ['view_action', 'research', 'explain', 'sources', 'fuse', 'rosetta']);
  assert.equal(actions.requestBody.content['application/json'].schema.oneOf.length, 6);
  assert.ok(actions.requestBody.content['application/json'].schema.oneOf.some((/** @type {any} */ s) => s.properties.type?.const === 'research' && s.required.includes('mode')));
  assert.equal(actions['x-ontologizer'].callsModel, true);
  assert.ok(actions.description.includes(COST_NOTE));
  assert.ok(doc.paths['/v1/t/{tenant}/maps'].post.responses[202], 'a build answers 202');
  assert.ok(doc.paths['/v1/t/{tenant}/maps/{id}/outline'].get.responses[200].content['text/markdown']);
  assert.deepEqual(doc.paths['/v1/t/{tenant}/maps/{id}/search'].get.parameters.map((/** @type {any} */ x) => `${x.in}:${x.name}`), ['path:tenant', 'path:id', 'query:q', 'query:limit']);
});

test('planted faults: an undeclared path parameter, a duplicate operationId, a POST without a body are reported', () => {
  const doc = openApi({ version: '1' });
  const undeclared = structuredClone(doc);
  const get = undeclared.paths['/v1/t/{tenant}/maps/{id}/nodes/{nodeId}'].get;
  get.parameters = get.parameters.filter((/** @type {any} */ x) => x.name !== 'nodeId');
  assert.deepEqual(openApiProblems(undeclared), ['GET /v1/t/{tenant}/maps/{id}/nodes/{nodeId}: path parameter {nodeId} is not declared']);
  const dup = structuredClone(doc);
  dup.paths['/v1/t/{tenant}/usage'].get.operationId = 'get_status';
  assert.ok(openApiProblems(dup).some((x) => /operationId get_status used twice/.test(x)));
  const nobody = structuredClone(doc);
  delete nobody.paths['/v1/t/{tenant}/maps/{id}/save'].post.requestBody;
  assert.ok(openApiProblems(nobody).some((x) => /POST needs a JSON request body/.test(x)));
});

test('GET /v1/openapi.json serves the same document with no token; other methods 405', async () => {
  const { srv, origin } = await boot({ tokens: [{ name: 'ci', scopes: ['read'] }] });
  try {
    const r = await req(origin, '/v1/openapi.json');
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /application\/json/);
    assert.deepEqual(r.json(), openApi({ version: 'test' }));
    assert.ok(!/ont_[A-Za-z0-9_-]{43}/.test(r.body), 'no token in it');
    assert.equal((await req(origin, '/v1/openapi.json', { method: 'POST', body: {} })).status, 405);
  } finally { await srv.close(); }
});
