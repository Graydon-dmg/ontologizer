// @ts-check
// Shared by the service-mode tests: a router on a free loopback port with the stub engine.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startService } from '../../src/server/service.js';
import { createEngine } from '../../src/cli/engine-stub.js';
import { createToken, tokensPath } from '../../src/server/tokens.js';

export const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-i-'));

/** @param {string} name */
export function fixtureEvents(name) {
  return fs.readFileSync(new URL(`../../fixtures/${name}.events.jsonl`, import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * A stub engine whose fuse makes a draft at once (the stub's own fuse calls no model, so it fails).
 * @param {{ store: any, id: string }} o
 */
export function stubEngine({ store, id }) {
  const e = createEngine({ store, id });
  return {
    ...e,
    /** @param {string} _a @param {string} _b @param {any} opts */
    async fuse(_a, _b, opts) {
      const draftId = store.createDraft({ context: 'fused' }, opts.into ?? 'fused');
      store.append(draftId, { t: 'ontology.created', at: 0, name: opts.into ?? 'fused', root: 'fused', brief: {}, categories: [] });
      opts.onDraft?.(draftId);
      return draftId;
    },
  };
}

/**
 * @param {{ home?: string, tokens?: Array<{ name: string, tenant?: string, scopes?: string[] }>,
 *   host?: string, allowHosts?: string[], makeEngine?: any, maxBuilds?: number, log?: (l: string) => void,
 *   maxQueued?: number, maxChecks?: number, maxStreamsPerToken?: number, idleMs?: number, pingMs?: number }} [o]
 */
export async function boot(o = {}) {
  const home = o.home ?? tempHome();
  /** @type {Record<string, string>} */
  const secrets = {};
  for (const t of o.tokens ?? []) secrets[t.name] = createToken(tokensPath(home), t).token;
  const srv = await startService({
    home, host: o.host ?? '127.0.0.1', port: 0, allowHosts: o.allowHosts ?? [], maxBuilds: o.maxBuilds ?? 2,
    tokensFile: o.tokens ? tokensPath(home) : null,
    makeEngine: o.makeEngine ?? (async (/** @type {any} */ x) => stubEngine(x)),
    version: 'test', log: o.log,
    ...(o.maxQueued !== undefined ? { maxQueued: o.maxQueued } : {}), ...(o.maxChecks !== undefined ? { maxChecks: o.maxChecks } : {}),
    ...(o.maxStreamsPerToken !== undefined ? { maxStreamsPerToken: o.maxStreamsPerToken } : {}),
    ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}), ...(o.pingMs !== undefined ? { pingMs: o.pingMs } : {}),
  });
  return { home, srv, secrets, origin: `http://127.0.0.1:${srv.port}` };
}

/**
 * One raw request (any Host, any headers). Resolves { status, headers, body }.
 * @param {string} url the server's url @param {string} p
 * @param {{ method?: string, headers?: Record<string, string>, body?: any }} [o]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string, json: () => any }>}
 */
export function req(url, p, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: u.hostname, port: u.port, path: p, method,
      headers: { ...(data !== null ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: /** @type {number} */ (res.statusCode), headers: res.headers, body: d, json: () => JSON.parse(d) }));
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
}

/**
 * Read SSE data events until `n` arrived or the time is up.
 * @param {string} url @param {string} p @param {number} n @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, events: any[] }>}
 */
export function readSse(url, p, n, headers = {}, timeoutMs = 5000) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    /** @type {any[]} */
    const events = [];
    let buf = '';
    let status = 0;
    const r = http.get({ host: u.hostname, port: u.port, path: p, headers }, (res) => {
      status = /** @type {number} */ (res.statusCode);
      if (status !== 200) { res.resume(); resolve({ status, events }); return; }
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        // Stop at exactly n: one chunk can carry many events (newer Node versions deliver bigger chunks).
        while (events.length < n && (i = buf.indexOf('\n\n')) >= 0) {
          const msg = buf.slice(0, i); buf = buf.slice(i + 2);
          if (msg.startsWith('data: ')) events.push(JSON.parse(msg.slice(6)));
        }
        if (events.length >= n) { r.destroy(); resolve({ status, events }); }
      });
    });
    r.on('error', (e) => { if (events.length < n) reject(e); });
    setTimeout(() => { r.destroy(); resolve({ status, events }); }, timeoutMs).unref();
  });
}

/** A map in a tenant's store, from a fixture. @param {string} home @param {string} tenant @param {string} id */
export async function seed(home, tenant, id, fixture = 'plastic-modeling') {
  const { openStore } = await import('../../src/core/store.js');
  return openStore(home, { tenant }).importEvents(id, fixtureEvents(fixture));
}
