// @ts-check
// One map's /api/* routes: events (SSE), snapshot, maps, attachments, action, chat. Shared by the
// one-map server (index.js, at "/api/...") and the service router (service.js, under each map's base).
import fs from 'node:fs';
import { TYPES, json, plain, readBody as readJsonBody } from './http.js';
import { MAX_BODY as MAX_CHAT_BODY, TOO_LARGE, ChatError, readCappedBody, drainCapped, validateChat, storeAttachment, findAttachment, imageSize, relayAsk } from './chat.js';

const PING_MS = 15000;

/** @param {number} ms @param {{ timers: Set<any> }} c */
function sleep(ms, c) {
  return new Promise((res) => {
    const t = setTimeout(() => { c.timers.delete(t); res(undefined); }, ms);
    c.timers.add(t);
  });
}

/** @typedef {{ url: string, close: () => Promise<void> }} DraftServer */

/**
 * @param {{ store: any, engine: any, id: string, replay?: null | { speed: number },
 *   openDraft?: null | ((draftId: string) => Promise<DraftServer>), onFuseSettled?: (draftId: string) => void,
 *   originOk?: (origin: string|undefined) => boolean,
 *   chatTimeouts?: { idleMs?: number, totalMs?: number }, pingMs?: number }} opts
 * openDraft makes a fused draft reachable and says where (the one-map server starts a second server;
 * the service router answers with the draft's view URL). Without it, fuse is refused.
 * onFuseSettled says a fuse has stopped writing into its draft (done or failed).
 * originOk decides the Origin of POST /api/action and /api/chat (default: any).
 * pingMs is the event stream's keep-alive interval (tests make it short).
 */
export function createMapHandler({ store, engine, id, replay = null, openDraft = null, onFuseSettled = () => {}, originOk = () => true, chatTimeouts = {}, pingMs = PING_MS }) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set();
  let closed = false;
  // Replay sessions never write view actions to the store (a rehearsal must not change the saved
  // demo): they keep the view here and push view.changed straight to this session's open streams.
  /** @type {Set<(ev: any) => void>} */
  const liveSenders = new Set();
  /** @type {any} */
  let replayView = null;
  /** Running rosetta runs on this map, by normalized persona. @type {Map<string, { jobId: string, lensId: string|null }>} */
  const rosettaRuns = new Map();
  let rosettaSeq = 0;
  /** Running fuses, by "with|into". @type {Map<string, { jobId: string, draftId: string|null, url: string|null }>} */
  const fuseRuns = new Map();
  let fuseSeq = 0;
  /** Servers started for fused drafts; they close with this one. @type {Set<DraftServer>} */
  const children = new Set();
  const currentView = () => (replay ? (replayView ??= structuredClone(store.read(id).view)) : store.read(id).view);

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  const readBody = (req, res) => readJsonBody(req, res);

  /**
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {number} from
   * @param {() => boolean} valid whether the caller may still read (checked on every ping and before every
   *   event; false ends the stream: a revoked token or an expired session stops receiving at once)
   */
  function sse(req, res, from, valid = () => true) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': open\n\n');
    sseClients.add(res);
    const conn = { timers: new Set(), gone: false };
    /** @type {Array<[any, number]>} */
    const buffer = [];
    let live = false;
    let nextIdx = from;
    /** @param {any} ev */
    const send = (ev) => {
      if (conn.gone) return;
      if (!valid()) { cleanup(); res.end(); return; }
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    /** @param {any} ev */
    const sendLive = (ev) => send(ev);
    liveSenders.add(sendLive);
    // In replay, live appends (the reader's own clicks) go out at once instead of waiting for the
    // paced replay to finish; the replay loop then skips any index already sent live.
    /** @type {Set<number>} */
    const sentLive = new Set();
    const unsubscribe = store.subscribe(id, (/** @type {any} */ ev, /** @type {number} */ idx) => {
      if (conn.gone) return;
      if (replay) { if (idx >= from) { sentLive.add(idx); send(ev); } return; }
      if (!live) { buffer.push([ev, idx]); return; }
      if (idx >= nextIdx) { nextIdx = idx + 1; send(ev); }
    });
    const ping = setInterval(() => {
      if (conn.gone) return;
      if (!valid()) { cleanup(); res.end(); return; }
      res.write(': ping\n\n');
    }, pingMs);
    const cleanup = () => {
      if (conn.gone) return;
      conn.gone = true;
      clearInterval(ping);
      for (const t of conn.timers) clearTimeout(t);
      try { unsubscribe(); } catch { /* ignore */ }
      sseClients.delete(res);
      liveSenders.delete(sendLive);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);

    (async () => {
      let prevAt = null;
      let i = from;
      for await (const ev of store.events(id, { from })) {
        if (conn.gone) return;
        if (replay && prevAt !== null) {
          const wait = (Number(ev.at) - prevAt) / (replay.speed || 1);
          if (wait > 0) await sleep(wait, conn);
          if (conn.gone) return;
        }
        prevAt = Number(ev.at);
        if (replay) { if (!sentLive.has(i)) send(ev); }
        else if (i >= nextIdx) { nextIdx = i + 1; send(ev); }
        i++;
      }
      if (conn.gone) return;
      for (const [ev, idx] of buffer) {
        if (idx >= nextIdx) { nextIdx = idx + 1; send(ev); }
      }
      buffer.length = 0;
      live = true;
    })().catch(() => cleanup());
  }


  /** @param {any} v */
  const isId = (v) => typeof v === 'string' && v.length > 0;

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function action(req, res) {
    const body = await readBody(req, res);
    if (!body) return;
    /** @param {string} error */
    const bad = (error) => json(res, 400, { ok: false, error });
    /** @param {Record<string, any>} patch */
    const viewEvent = (patch) => {
      const ev = { t: 'view.changed', at: store.now(id), patch };
      if (!replay) return store.append(id, ev);
      const v = currentView();
      replayView = { ...v, ...patch, filter: patch.filter ? { ...v.filter, ...patch.filter } : v.filter };
      for (const send of liveSenders) send(ev);
    };
    switch (body.type) {
      case 'expand':
      case 'collapse': {
        if (!isId(body.nodeId)) return bad('nodeId must be a non-empty string');
        const cur = /** @type {string[]} */ (currentView().collapsed || []);
        const rest = cur.filter((n) => n !== body.nodeId);
        const collapsed = body.type === 'collapse' ? [...rest, body.nodeId] : rest;
        viewEvent({ collapsed });
        return json(res, 202, { ok: true });
      }
      case 'focus':
        if (!isId(body.nodeId)) return bad('nodeId must be a non-empty string');
        viewEvent({ focus: body.nodeId });
        return json(res, 202, { ok: true });
      case 'layout':
        if (!isId(body.value)) return bad('value must be a non-empty string');
        viewEvent({ layout: body.value });
        return json(res, 202, { ok: true });
      case 'lens':
        if (body.value !== null && !isId(body.value)) return bad('value must be a string or null');
        viewEvent({ lens: body.value });
        return json(res, 202, { ok: true });
      case 'filter':
        if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
          return bad('value must be an object');
        }
        viewEvent({ filter: body.value });
        return json(res, 202, { ok: true });
      case 'research':
      case 'explain':
      case 'sources': {
        if (!isId(body.nodeId)) return bad('nodeId must be a non-empty string');
        /** @type {Record<string, any>} */
        let job = { kind: body.type, nodeId: body.nodeId };
        if (body.type === 'research') {
          if (body.mode !== 'context' && body.mode !== 'general') return bad("mode must be 'context' or 'general'");
          job = { kind: 'research', nodeId: body.nodeId, mode: body.mode };
        }
        const r = await engine.enqueue(job, { priority: 10 });
        const jobId = typeof r === 'string' ? r : (r?.jobId ?? r?.id);
        return json(res, 202, jobId === undefined ? { ok: true } : { ok: true, jobId });
      }
      case 'rosetta': {
        const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
        if (!persona || persona.length > 120) return bad('persona must be a non-empty string of at most 120 characters');
        if (body.name !== undefined && body.name !== null &&
            (typeof body.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.name))) {
          return bad('name must be lowercase letters, digits and hyphens, at most 40 characters');
        }
        const name = typeof body.name === 'string' ? body.name : undefined;
        const key = persona.toLowerCase();
        const running = rosettaRuns.get(key);
        if (running) return json(res, 202, { ok: true, jobId: running.jobId, ...(running.lensId ? { lensId: running.lensId } : {}) });
        return json(res, 202, await startRosetta(persona, name, key));
      }
      case 'fuse': {
        if (typeof body.with !== 'string' || !body.with.trim()) return bad('with must be a map id or name');
        const r = store.resolve(body.with.trim());
        if (r === null) return bad(`no map named "${body.with}"`);
        if (typeof r === 'object') return bad(`"${body.with}" is ambiguous: ${r.ambiguous.join(', ')}`);
        if (r === id) return bad('fuse needs a different map than this one');
        if (body.into !== undefined && body.into !== null &&
            (typeof body.into !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.into))) {
          return bad('into must be lowercase letters, digits and hyphens, at most 40 characters');
        }
        if (!openDraft) return bad('fuse is not available in this session');
        const into = typeof body.into === 'string' ? body.into : undefined;
        const key = `${r}|${into ?? ''}`;
        const running = fuseRuns.get(key);
        if (running) return json(res, 202, fuseReply(running));
        return json(res, 202, await startFuse(r, into, key));
      }
      default:
        return bad(`unknown action type: ${String(body.type)}`);
    }
  }

  /**
   * Start engine.rosetta without waiting for it to finish (it runs batch after batch). It is wrapped
   * in job events so the shell's jobs tray shows it and its errors. Answers with the lensId as soon as
   * the lens.added event appears (at most 3 s), which engine.rosetta emits first.
   * @param {string} persona @param {string|undefined} name @param {string} key
   */
  async function startRosetta(persona, name, key) {
    const jobId = `rosetta-${process.pid}-${++rosettaSeq}`;
    const job = { id: jobId, kind: 'rosetta', persona };
    const run = { jobId, lensId: /** @type {string|null} */ (null) };
    rosettaRuns.set(key, run);
    /** @type {(v: any) => void} */
    let gotLens = () => {};
    const lensSeen = new Promise((r) => { gotLens = r; });
    const off = store.subscribe(id, (/** @type {any} */ ev) => {
      if (ev.t === 'lens.added' && ev.lens?.id && !run.lensId && ev.lens.persona?.trim().toLowerCase() === key) {
        run.lensId = ev.lens.id;
        gotLens(ev.lens.id);
      }
    });
    store.append(id, { t: 'job.queued', at: store.now(id), job });
    store.append(id, { t: 'job.started', at: store.now(id), job });
    const finished = Promise.resolve()
      .then(() => engine.rosetta(id, persona, { name }))
      .then(
        (lensId) => {
          if (!run.lensId && typeof lensId === 'string') run.lensId = lensId;
          try { store.append(id, { t: 'job.done', at: store.now(id), job }); } catch { /* store gone */ }
        },
        (/** @type {any} */ err) => {
          const error = err && (err.status === 401 || err.name === 'AuthenticationError')
            ? 'Your Anthropic API key was rejected: run ontologizer key set'
            : String(err?.message ?? err);
          try { store.append(id, { t: 'job.failed', at: store.now(id), job: { ...job, error } }); } catch { /* store gone */ }
        },
      )
      .finally(() => { off(); rosettaRuns.delete(key); gotLens(null); })
      .catch(() => {}); // never an unhandled rejection: errors are already job.failed events
    /** @type {any} */
    let t;
    await Promise.race([lensSeen, finished, new Promise((r) => { t = setTimeout(r, 3000); })]);
    clearTimeout(t);
    return { ok: true, jobId, ...(run.lensId ? { lensId: run.lensId } : {}) };
  }

  /** @param {{ jobId: string, draftId: string|null, url: string|null }} run */
  function fuseReply(run) {
    return { ok: true, jobId: run.jobId, ...(run.draftId ? { draftId: run.draftId } : {}), ...(run.url ? { url: run.url } : {}) };
  }

  /**
   * Fuse this map with `withId` into a new draft, made reachable by openDraft (a second server in this
   * process on the one-map server; the draft's own view URL in service mode). The run is wrapped in
   * job events on THIS map (kind 'fuse'); job.done carries draftId and url. Answers as soon as the
   * draft is reachable (engine.fuse's onDraft), or after at most 5 s.
   * @param {string} withId @param {string|undefined} into @param {string} key
   */
  async function startFuse(withId, into, key) {
    const jobId = `fuse-${process.pid}-${++fuseSeq}`;
    const job = { id: jobId, kind: 'fuse', with: withId, ...(into ? { into } : {}) };
    const run = { jobId, draftId: /** @type {string|null} */ (null), url: /** @type {string|null} */ (null) };
    fuseRuns.set(key, run);
    /** @type {(v: any) => void} */
    let ready = () => {};
    const served = new Promise((r) => { ready = r; });
    /** @type {Promise<void>|null} */
    let serving = null;
    let failed = false;
    /** @type {{ url: string, close: () => Promise<void> } | null} */
    let childServer = null;
    /** Start the draft's server once. @param {string} draftId */
    const serveDraft = (draftId) => {
      if (serving || closed) return serving;
      run.draftId = draftId;
      serving = (async () => {
        const child = await /** @type {NonNullable<typeof openDraft>} */ (openDraft)(draftId);
        if (closed || failed) { await child.close(); return; }
        children.add(child);
        run.url = child.url;
        ready(child.url);
        childServer = child;
      })().catch(() => { ready(null); });
      return serving;
    };
    store.append(id, { t: 'job.queued', at: store.now(id), job });
    store.append(id, { t: 'job.started', at: store.now(id), job });
    const finished = Promise.resolve()
      .then(() => engine.fuse(id, withId, { into, onDraft: (/** @type {string} */ d) => { serveDraft(d); } }))
      .then(async (draftId) => {
        if (typeof draftId === 'string') await serveDraft(draftId); // an engine without onDraft
        try {
          store.append(id, { t: 'job.done', at: store.now(id),
            job: { ...job, ...(run.draftId ? { draftId: run.draftId } : {}), ...(run.url ? { url: run.url } : {}) } });
        } catch { /* store gone */ }
      }, async (/** @type {any} */ err) => {
        // A failed fuse leaves no server behind for its half-made draft.
        failed = true;
        if (serving) await serving;
        if (childServer) { children.delete(childServer); await childServer.close().catch(() => {}); }
        run.url = null;
        const error = err && (err.status === 401 || err.name === 'AuthenticationError')
          ? 'Your Anthropic API key was rejected: run ontologizer key set'
          : String(err?.message ?? err);
        try { store.append(id, { t: 'job.failed', at: store.now(id), job: { ...job, error } }); } catch { /* store gone */ }
      })
      .finally(() => {
        fuseRuns.delete(key);
        ready(null);
        if (run.draftId) { try { onFuseSettled(run.draftId); } catch { /* never breaks the fuse */ } }
      })
      .catch(() => {}); // never an unhandled rejection: errors are already job.failed events
    /** @type {any} */
    let t;
    await Promise.race([served, finished, new Promise((r) => { t = setTimeout(r, 5000); })]);
    clearTimeout(t);
    return fuseReply(run);
  }

  // One chat request in flight per map (per server).
  let chatBusy = false;
  /** The response of the chat in flight, so close() can stop it. @type {import('node:http').ServerResponse|null} */
  let chatRes = null;

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function chat(req, res) {
    /** @param {number} status @param {string} error @param {boolean} [drop] close the socket (body past the cap) */
    const fail = (status, error, drop = false) => {
      res.writeHead(status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', ...(drop ? { Connection: 'close' } : {}) });
      res.end(JSON.stringify({ ok: false, error }));
      if (drop) res.on('finish', () => req.destroy());
    };
    /** Refuse before reading: drain the body (up to the cap) first, so fetch gets the message. */
    const refuse = async (/** @type {number} */ status, /** @type {string} */ error) => {
      const within = await drainCapped(req, MAX_CHAT_BODY);
      fail(within ? status : 413, within ? error : TOO_LARGE, !within);
    };
    const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') return refuse(415, 'Content-Type must be application/json.');
    if (chatBusy) return refuse(409, 'A chat answer is already being written for this map: wait for it to finish.');
    chatBusy = true;
    chatRes = res;
    try {
      let raw;
      try {
        raw = await readCappedBody(req, MAX_CHAT_BODY);
      } catch (/** @type {any} */ err) {
        if (err instanceof ChatError) return fail(err.status, err.message, err.status === 413);
        return fail(400, 'Could not read the message.', true);
      }
      let input;
      try {
        let parsed;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ChatError(400, 'The body is not valid JSON.'); }
        const v = validateChat(parsed);
        const home = store.root;
        const images = v.images.map((im) => {
          const hash = storeAttachment(home, id, im);
          const size = imageSize(im.buf, im.ext);
          return { mime: im.mime, data: im.buf.toString('base64'), hash, ...(size ? { w: size.w, h: size.h } : {}) };
        });
        input = { text: v.text, images, lens: v.lens ?? null };
      } catch (/** @type {any} */ err) {
        if (err instanceof ChatError) return fail(err.status, err.message);
        return fail(500, 'Could not save the image.'); // e.g. a disk error; never a 400
      }
      await relayAsk({ engine, req, res, input, ...chatTimeouts });
    } finally {
      chatBusy = false;
      chatRes = null;
    }
  }


  /**
   * Answer one of this map's /api/* routes. `rawPath` starts with "/api/". Resolves true when it
   * answered, false when the path is not one of these routes (the caller answers 404).
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   * @param {string} rawPath @param {URLSearchParams} query
   * @param {{ valid?: () => boolean }} [o] valid: whether the caller may still read an event stream
   */
  async function handleApi(req, res, rawPath, query, o = {}) {
    const method = req.method || 'GET';
    if (rawPath === '/api/action' || rawPath === '/api/chat') {
      if (method !== 'POST') { plain(res, 405, 'method not allowed'); return true; }
      if (!originOk(req.headers.origin)) { plain(res, 403, 'forbidden origin'); return true; }
      await (rawPath === '/api/chat' ? chat(req, res) : action(req, res));
      return true;
    }
    if (rawPath === '/api/maps' || rawPath === '/api/snapshot' || rawPath === '/api/events' || rawPath.startsWith('/api/attachments/')) {
      if (method !== 'GET' && method !== 'HEAD') { plain(res, 405, 'method not allowed'); return true; }
    }
    if (rawPath === '/api/maps') {
      // Every other map, for the Fuse picker: saved maps first, then drafts (newest first in each).
      const rows = store.list({ drafts: true })
        .filter((/** @type {any} */ m) => m.id !== id)
        .map((/** @type {any} */ m) => ({ id: m.id, name: m.name, nodes: m.nodes, updatedAt: m.updatedAt, draft: Boolean(m.draft) }));
      rows.sort((a, b) => Number(a.draft) - Number(b.draft) || b.updatedAt - a.updatedAt);
      json(res, 200, rows);
      return true;
    }
    if (rawPath.startsWith('/api/attachments/')) {
      const hash = rawPath.slice('/api/attachments/'.length);
      const found = findAttachment(store.root, id, hash); // null unless hash is exactly 64 hex chars
      if (!found) { plain(res, 404, 'not found'); return true; }
      try {
        const data = await fs.promises.readFile(found.file);
        res.writeHead(200, {
          'Content-Type': found.mime,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Cache-Control': 'private, max-age=31536000, immutable',
        });
        res.end(data);
      } catch {
        plain(res, 404, 'not found');
      }
      return true;
    }
    if (rawPath === '/api/snapshot') { json(res, 200, store.read(id)); return true; }
    if (rawPath === '/api/events') {
      const from = Math.max(0, Number.parseInt(query.get('from') || '0', 10) || 0);
      sse(req, res, from, o.valid);
      return true;
    }
    return false;
  }

  return {
    handleApi,
    /** The streams open on this map right now. */
    streams: () => sseClients.size,
    /** Whether a chat answer is being written right now (it appends to the map). */
    chatting: () => chatBusy,
    /** End every stream, stop a chat in flight, and close any draft servers started for fuses. */
    async close() {
      if (closed) return;
      closed = true;
      for (const r of sseClients) r.end();
      if (chatRes) chatRes.destroy(); // the relay aborts the model call
      await Promise.all([...children].map((c) => c.close().catch(() => {})));
      children.clear();
    },
  };
}
