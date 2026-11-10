// @ts-check
import * as tokens from '../shared/tokens.js';
import { loadChoice, applyTheme } from '../shell/theme.js';
import { mountServerPanel } from '../shell/ui/server.js';
import { renameFlow, deleteFlow, openPanel } from '../shell/ui/manage.js';
import { allowed, listTrash, restoreMap, purgeText, nameProblem, failText } from '../shell/manage.js';
import { getSession, signIn, listMaps, checkContext, startBuild, listSources, buildBody, nextStep, cleanAnswers, addAnswers, safeNext, newMapRequested, describeFailure, relTime } from './flow.js';

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
/** The caller's scopes (which row buttons to show; the server decides). @type {string[]} */
let scopes = [];
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
  if (Array.isArray(r.body?.scopes)) scopes = r.body.scopes;
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
    if (m.visibility === 'private') {
      const b = document.createElement('span');
      b.className = 'map-private';
      b.textContent = 'Private';
      a.append(b);
    }
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
    li.append(a, rowActions(m));
    list.append(li);
  }
}

/**
 * Rename (Save, for a draft) and Delete for one map row. Buttons the caller's scopes would be refused
 * are left out; the server checks again.
 * @param {any} m a row of GET maps
 */
function rowActions(m) {
  const box = document.createElement('span');
  box.className = 'row-actions';
  const can = allowed(scopes, Boolean(m.draft));
  const label = m.name || m.id;
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'map-rename';
  rename.textContent = m.draft ? 'Save as…' : 'Rename';
  rename.setAttribute('aria-label', `${m.draft ? 'Save' : 'Rename'} ${label}`);
  rename.hidden = !can.rename;
  rename.addEventListener('click', async () => {
    const url = await renameFlow(rename, { fetch: f, tenant, id: m.id, name: label, align: 'right' });
    if (url) loadMaps();
  });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'map-delete';
  del.textContent = 'Delete';
  del.setAttribute('aria-label', `Delete ${label}`);
  del.hidden = !can.remove;
  del.addEventListener('click', async () => {
    if (await deleteFlow(del, { fetch: f, tenant, id: m.id, name: label, align: 'right' })) { loadMaps(); loadTrash(); }
  });
  box.append(rename, del);
  return box;
}

// ---- the trash ----
async function loadTrash() {
  const section = $('trash-section');
  const list = $('trash-list');
  const msg = $('trash-msg');
  // Only a token that could restore something sees the trash (the server lists only those items).
  if (!scopes.includes('build') && !scopes.includes('admin')) { section.hidden = true; return; }
  const r = await listTrash(f, tenant);
  if (!r.ok || !Array.isArray(r.body)) { section.hidden = r.status === 404 || r.status === 403; msg.textContent = r.ok ? '' : failText(r); list.replaceChildren(); return; }
  section.hidden = r.body.length === 0;
  msg.textContent = '';
  list.replaceChildren();
  for (const t of r.body) {
    const li = document.createElement('li');
    const item = document.createElement('span');
    item.className = 'trash-item';
    const name = document.createElement('span');
    name.className = 'map-name';
    name.textContent = t.name || t.id;
    item.append(name);
    if (t.visibility === 'private') {
      const b = document.createElement('span');
      b.className = 'map-private';
      b.textContent = 'Private';
      item.append(b);
    }
    if (t.draft) {
      const d = document.createElement('span');
      d.className = 'map-draft';
      d.textContent = 'draft';
      item.append(d);
    }
    const meta = document.createElement('span');
    meta.className = 'map-meta';
    meta.textContent = `deleted ${relTime(t.deletedAt)} · ${purgeText(t.purgeAt)}`;
    item.append(meta);
    const box = document.createElement('span');
    box.className = 'row-actions';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'trash-restore';
    restore.textContent = 'Restore';
    restore.setAttribute('aria-label', `Restore ${t.name || t.id}`);
    restore.addEventListener('click', () => restoreItem(restore, t));
    box.append(restore);
    li.append(item, box);
    list.append(li);
  }
}

/**
 * Restore one item; if its name is taken now, ask for another (the panel, placed by fitPanel).
 * @param {HTMLElement} btn @param {any} t a trash row
 */
async function restoreItem(btn, t) {
  btn.setAttribute('disabled', '');
  const r = await restoreMap(f, tenant, t.trashId);
  btn.removeAttribute('disabled');
  if (r.ok) { loadMaps(); loadTrash(); return; }
  if (r.status !== 409) { $('trash-msg').textContent = failText(r); return; }
  openPanel(btn, {
    title: 'Restore under another name',
    text: `The name “${t.id}” is not available now.`,
    input: { label: 'Name', value: `${t.id.replace(/^draft-/, 'map-')}-restored`.slice(0, 63) },
    confirm: 'Restore', align: 'right',
    onConfirm: async (as) => {
      const bad = nameProblem(as);
      if (bad) return bad;
      const again = await restoreMap(f, tenant, t.trashId, as);
      if (!again.ok) return failText(again);
      loadMaps(); loadTrash();
      return null;
    },
  });
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

/** Sources the picker offered; null when it is hidden. @type {{ name: string, visibility: string }[]|null} */
let offered = null;

/** @param {{ name: string, visibility: string }[]} list */
function renderPicker(list) {
  const box = $('sources-picker');
  offered = list.length ? list : null;
  box.replaceChildren();
  box.hidden = !offered;
  if (!offered) return;
  const lg = document.createElement('legend');
  lg.textContent = 'Sources';
  box.append(lg);
  for (const s of offered) {
    const l = document.createElement('label');
    l.className = 'src';
    const i = document.createElement('input');
    i.type = 'checkbox'; i.value = s.name; i.checked = true;
    l.append(i, document.createTextNode(s.name));
    if (s.visibility === 'private') {
      const m = document.createElement('span');
      m.className = 'src-private';
      m.textContent = 'private';
      l.append(m);
    }
    box.append(l);
  }
  if (offered.some((s) => s.visibility === 'private')) {
    const h = document.createElement('p');
    h.className = 'muted';
    h.textContent = 'A map built from a private source becomes private.';
    box.append(h);
  }
}

function openNew() {
  resetNew();
  renderPicker([]);
  listSources(f, tenant).then(renderPicker);
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
  const r = await startBuild(f, tenant, buildBody({ brief: st.brief, name: st.name }, {
    shown: !!offered,
    checked: [...$('sources-picker').querySelectorAll('input[type=checkbox]:checked')].map((/** @type {any} */ i) => i.value),
  }));
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
  scopes = Array.isArray(s.body.scopes) ? s.body.scopes : [];
  const back = safeNext(location.search);
  if (back) { location.replace(back); return; }
  mountServerPanel($('server-panel'), { tenant, fetch: f, popover: false });
  loadMaps();
  loadTrash();
  // "New map" from a map page: open the dialog at once, and drop ?new=1 so a reload does not reopen it.
  const wanted = newMapRequested(location.search);
  if (wanted.open) {
    history.replaceState(history.state, '', `${location.pathname}${wanted.search}${location.hash}`);
    openNew();
  }
}
boot();
