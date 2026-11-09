// @ts-check
// Request and round logic for the maps home and the New map dialog. No DOM: `fetch` is passed in.
// Every helper returns { ok, status, body } and never throws on an HTTP error; a network
// failure is { ok: false, status: 0, error }.

/** The most `check` calls before building (round 0, 1, 2), as the CLI. */
export const MAX_ROUNDS = 3;

/** @typedef {{ ok: boolean, status: number, body?: any, error?: string }} Res */
/** @typedef {{ context: string, subject: string, scope: string, purpose: string, level: string }} Brief */
/** @typedef {{ id: string, text: string, options: string[] }} Question */

/**
 * @param {typeof fetch} fetchFn @param {string} path @param {{ method?: string, body?: any }} [init]
 * @returns {Promise<Res>}
 */
export async function request(fetchFn, path, init = {}) {
  /** @type {RequestInit} */
  const opts = { method: init.method ?? 'GET', credentials: 'same-origin' };
  if (init.body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(init.body);
  }
  try {
    const r = await fetchFn(path, opts);
    /** @type {any} */
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    const status = r.status;
    const ok = status >= 200 && status < 300 && body?.ok !== false;
    return ok ? { ok, status, body } : { ok: false, status, body, error: typeof body?.error === 'string' ? body.error : `Request failed (${status}).` };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** @param {typeof fetch} f */
export const getSession = (f) => request(f, '/v1/session');

/** @param {typeof fetch} f @param {string} token */
export const signIn = (f, token) => request(f, '/v1/session', { method: 'POST', body: { token } });

/** @param {string} tenant */
const root = (tenant) => `/v1/t/${encodeURIComponent(tenant)}`;

/** @param {typeof fetch} f @param {string} tenant */
export const listMaps = (f, tenant) => request(f, `${root(tenant)}/maps`);

/** @param {typeof fetch} f @param {string} tenant @param {string} context @param {{ id: string, answer: string }[]} answers */
export const checkContext = (f, tenant, context, answers) =>
  request(f, `${root(tenant)}/maps/check`, { method: 'POST', body: { context, answers } });

/** @param {typeof fetch} f @param {string} tenant @param {{ brief: Brief, name?: string, depth?: number }} spec */
export async function startBuild(f, tenant, spec) {
  const r = await request(f, `${root(tenant)}/maps`, { method: 'POST', body: spec });
  if (r.ok && r.status === 202 && typeof r.body?.viewUrl === 'string') return { ...r, viewUrl: /** @type {string} */ (r.body.viewUrl) };
  if (r.ok) return { ok: false, status: r.status, body: r.body, error: 'The server did not return a map to open.' };
  return r;
}

/** @param {string} context @returns {Brief} */
export const fallbackBrief = (context) => ({ context, subject: context, scope: '', purpose: '', level: 'beginner' });

/**
 * Decide the next step after round `round` (0-based) returned `result`.
 * - ready -> confirm with the returned brief and name
 * - not ready and rounds remain -> questions
 * - not ready after the last round -> confirm with the fallback brief
 * @param {{ round: number, result: any, context: string }} s
 * @returns {{ kind: 'questions', questions: Question[], round: number } | { kind: 'confirm', brief: Brief, name: string }}
 */
export function nextStep({ round, result, context }) {
  if (result?.ready && result.brief) return { kind: 'confirm', brief: result.brief, name: result.name || 'untitled' };
  const questions = Array.isArray(result?.questions) ? result.questions : [];
  if (round + 1 >= MAX_ROUNDS || !questions.length) {
    return { kind: 'confirm', brief: fallbackBrief(context), name: 'untitled' };
  }
  return { kind: 'questions', questions, round: round + 1 };
}

/** Answers from the form: one entry per question that has a non-empty answer.
 * @param {{ id: string, answer: string }[]} list @returns {{ id: string, answer: string }[]} */
export const cleanAnswers = (list) => list.map((a) => ({ id: a.id, answer: String(a.answer ?? '').trim() })).filter((a) => a.answer);

/** Add a round of answers to the earlier ones: all of `prev`, then the cleaned `next`.
 * A question answered again keeps its place and takes the newer answer.
 * @param {{ id: string, answer: string }[]} prev @param {{ id: string, answer: string }[]} next
 * @returns {{ id: string, answer: string }[]} */
export function addAnswers(prev, next) {
  const out = prev.map((a) => ({ ...a }));
  for (const a of cleanAnswers(next)) {
    const i = out.findIndex((o) => o.id === a.id);
    if (i >= 0) out[i] = a; else out.push(a);
  }
  return out;
}

const NEXT_PATH = /^\/v1\/t\/[a-z0-9][a-z0-9-]{0,62}\/maps\/[a-z0-9][a-z0-9-]*\/view$/;

/** The page to return to after sign in: the decoded `next` value of `location.search`, only when it
 * is a same-origin map page path; anything else is null.
 * @param {string} search @returns {string|null} */
export function safeNext(search) {
  const v = new URLSearchParams(String(search ?? '')).get('next');
  return v !== null && NEXT_PATH.test(v) ? v : null;
}

/** Message for a failed response; `kind: 'auth'` means show the token form.
 * @param {Res} r @returns {{ kind: 'auth'|'message', text: string }} */
export function describeFailure(r) {
  if (r.status === 401) return { kind: 'auth', text: 'Sign in with a token to continue.' };
  if (r.status === 403) return { kind: 'message', text: 'This token cannot build maps (it needs the build scope).' };
  return { kind: 'message', text: r.error || 'Something went wrong.' };
}

/** "3 min ago" style, else a short date. @param {number|string|undefined} t @param {number} [now] */
export function relTime(t, now = Date.now()) {
  const ms = typeof t === 'number' ? t : Date.parse(String(t));
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}
