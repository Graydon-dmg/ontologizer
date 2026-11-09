// @ts-check
import * as tokens from '../shared/tokens.js';
import { loadChoice, applyTheme } from '../shell/theme.js';
import { mountServerPanel } from '../shell/ui/server.js';
import { getSession, signIn, listMaps, checkContext, startBuild, nextStep, cleanAnswers, addAnswers, safeNext, describeFailure, relTime } from './flow.js';

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
const f = globalThis.fetch.bind(globalThis);

// Follow the OS theme (or the choice saved by the map page).
{
  /** @type {Storage|null} */
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  const mq = matchMedia('(prefers-color-scheme: light)');
  const apply = () => applyTheme(document, loadChoice(storage), mq.matches, tokens, (t, init) => new CustomEvent(t, init));
  mq.addEventListener('change', apply);
  apply();
}

/** @type {string} */
let tenant = 'default';
/** @type {(() => void)|null} */
let afterSignIn = null;

/** @param {HTMLElement} el @param {boolean} busy */
const setBusy = (el, busy) => { for (const b of el.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (b).disabled = busy; };

/** Show the token form; `then` runs after a successful sign in. @param {() => void} then */
function needSignIn(then) {
  afterSignIn = then;
  $('signin-msg').textContent = '';
  if (!$('signin-dialog').open) $('signin-dialog').showModal();
  $('signin-token').focus();
}

$('signin-form').addEventListener('submit', async (/** @type {Event} */ e) => {
  e.preventDefault();
  const form = $('signin-form');
  setBusy(form, true);
  const r = await signIn(f, $('signin-token').value.trim());
  setBusy(form, false);
  if (!r.ok) {
    $('signin-msg').textContent = r.status === 401 ? 'That token was not accepted.' : r.error || 'Sign in failed.';
    return;
  }
  if (typeof r.body?.tenant === 'string') tenant = r.body.tenant;
  $('signin-token').value = '';
  $('signin-dialog').close();
  const next = afterSignIn;
  afterSignIn = null;
  if (next) next(); else boot();
});

// ---- map list ----
async function loadMaps() {
  const msg = $('maps-msg');
  const list = $('maps-list');
  msg.textContent = 'Loading…';
  const r = await listMaps(f, tenant);
  if (r.status === 401) { msg.textContent = ''; needSignIn(loadMaps); return; }
  if (!r.ok) {
    list.replaceChildren();
    msg.textContent = r.status === 403 ? 'This token cannot list maps (it needs the read scope).' : describeFailure(r).text;
    return;
  }
  const maps = Array.isArray(r.body) ? r.body : [];
  list.replaceChildren();
  msg.textContent = maps.length ? '' : 'No maps yet. Click New map to build one.';
  for (const m of maps) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/v1/t/${encodeURIComponent(tenant)}/maps/${encodeURIComponent(m.id)}/view`;
    const name = document.createElement('span');
    name.className = 'map-name';
    name.textContent = m.name || m.id;
    const root = document.createElement('span');
    root.className = 'map-root';
    root.textContent = m.root ?? '';
    a.append(name, root);
    if (m.draft) {
      const d = document.createElement('span');
      d.className = 'map-draft';
      d.textContent = 'draft';
      a.append(d);
    }
    const meta = document.createElement('span');
    meta.className = 'map-meta';
    meta.textContent = `${m.nodes ?? 0} nodes · ${relTime(m.updatedAt)}`;
    a.append(meta);
    li.append(a);
    list.append(li);
  }
}

// ---- New map dialog ----
/** @type {{ round: number, context: string, answers: { id: string, answer: string }[], brief: any, name: string, step: 'context'|'questions'|'confirm', questions: any[] }} */
const st = { round: 0, context: '', answers: [], brief: null, name: 'untitled', step: 'context', questions: [] };

/** @param {'context'|'questions'|'confirm'} step */
function show(step) {
  st.step = step;
  $('step-context').hidden = step !== 'context';
  $('step-questions').hidden = step !== 'questions';
  $('step-confirm').hidden = step !== 'confirm';
  $('new-go').textContent = step === 'confirm' ? 'Build' : 'Continue';
}

function resetNew() {
  Object.assign(st, { round: 0, context: '', answers: [], brief: null, name: 'untitled', questions: [] });
  $('new-context').value = '';
  $('new-msg').textContent = '';
  show('context');
}

function openNew() {
  resetNew();
  $('new-dialog').showModal();
  $('new-context').focus();
}

/** @param {any} q */
function questionEl(q) {
  const fs = document.createElement('fieldset');
  fs.className = 'q';
  fs.dataset.id = q.id;
  const lg = document.createElement('legend');
  lg.textContent = q.text;
  fs.append(lg);
  const group = `q-${q.id}`;
  for (const opt of /** @type {string[]} */ (q.options ?? [])) {
    const l = document.createElement('label');
    const i = document.createElement('input');
    i.type = 'radio'; i.name = group; i.value = opt;
    l.append(i, document.createTextNode(opt));
    fs.append(l);
  }
  const lo = document.createElement('label');
  const io = document.createElement('input');
  io.type = 'radio'; io.name = group; io.value = '\u0000other';
  lo.append(io, document.createTextNode('Other'));
  const t = document.createElement('input');
  t.type = 'text'; t.className = 'other-text'; t.setAttribute('aria-label', `Other answer: ${q.text}`);
  t.addEventListener('input', () => { io.checked = true; });
  fs.append(lo, t);
  return fs;
}

/** @returns {{ id: string, answer: string }[]} */
function readAnswers() {
  const out = [];
  for (const fs of $('step-questions').querySelectorAll('fieldset')) {
    const sel = /** @type {HTMLInputElement|null} */ (fs.querySelector('input[type=radio]:checked'));
    if (!sel) continue;
    const answer = sel.value === '\u0000other' ? /** @type {HTMLInputElement} */ (fs.querySelector('.other-text')).value : sel.value;
    out.push({ id: /** @type {HTMLElement} */ (fs).dataset.id ?? '', answer });
  }
  return cleanAnswers(out);
}

/** @param {{ kind: string, [k: string]: any }} step */
function render(step) {
  if (step.kind === 'questions') {
    st.round = step.round;
    st.questions = step.questions;
    $('step-questions').replaceChildren(...step.questions.map(questionEl));
    show('questions');
    return;
  }
  st.brief = step.brief;
  st.name = step.name;
  const dl = document.createElement('dl');
  dl.className = 'brief';
  for (const [k, v] of /** @type {[string, string][]} */ ([['Subject', step.brief.subject], ['Scope', step.brief.scope], ['Purpose', step.brief.purpose], ['Level', step.brief.level], ['Suggested name', step.name]])) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v || '—';
    dl.append(dt, dd);
  }
  $('step-confirm').replaceChildren(dl);
  show('confirm');
}

/** @param {import('./flow.js').Res} r @param {() => void} retry */
function fail(r, retry) {
  const d = describeFailure(r);
  if (d.kind === 'auth') { $('new-dialog').close(); needSignIn(() => { $('new-dialog').showModal(); retry(); }); return; }
  $('new-msg').textContent = d.text;
}

async function runCheck() {
  const r = await checkContext(f, tenant, st.context, st.answers);
  if (!r.ok) { fail(r, runCheck); return; }
  render(nextStep({ round: st.round, result: r.body, context: st.context }));
}

async function runBuild() {
  const r = await startBuild(f, tenant, { brief: st.brief, name: st.name });
  if (!r.ok) { fail(r, runBuild); return; }
  location.href = /** @type {any} */ (r).viewUrl;
}

$('new-form').addEventListener('submit', async (/** @type {Event} */ e) => {
  e.preventDefault();
  const form = $('new-form');
  $('new-msg').textContent = '';
  if (st.step === 'context') {
    st.context = $('new-context').value.trim();
    if (!st.context) { $('new-msg').textContent = 'Describe what you want to explore first.'; return; }
    st.round = 0;
    st.answers = [];
  } else if (st.step === 'questions') {
    // Answers add up over the rounds, as in the CLI.
    st.answers = addAnswers(st.answers, readAnswers());
  }
  setBusy(form, true);
  try {
    if (st.step === 'confirm') await runBuild(); else await runCheck();
  } finally { setBusy(form, false); }
});
$('new-cancel').addEventListener('click', () => $('new-dialog').close());
$('new-map').addEventListener('click', openNew);

// ---- boot ----
async function boot() {
  const s = await getSession(f);
  if (s.status === 401) { needSignIn(boot); return; }
  if (!s.ok) { $('maps-msg').textContent = describeFailure(s).text; return; }
  tenant = s.body.tenant;
  const back = safeNext(location.search);
  if (back) { location.replace(back); return; }
  mountServerPanel($('server-panel'), { tenant, fetch: f, popover: false });
  loadMaps();
}
boot();
