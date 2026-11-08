// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fold, foldAll, emptyOntology } from '../../src/core/events.js';

const created = { t: 'ontology.created', at: 0, name: 'Demo', root: 'demo',
  brief: { context: '', subject: '', scope: '', purpose: '', level: 'beginner' }, categories: [] };
const asked = { t: 'chat.asked', at: 10, chatId: 'main', msgId: 'u1', text: 'What glue for clear parts?',
  images: [{ hash: 'abc', mime: 'image/png', w: 640, h: 480, bytes: 'SHOULD-BE-DROPPED' }], secret: 'x' };
const answered = { t: 'chat.answered', at: 20, chatId: 'main', msgId: 'a1', replyTo: 'u1', text: 'PVA glue.',
  citations: [{ nodeId: 'demo/pva', label: 'PVA glue', extra: 1 }], sources: [{ title: 'T', url: 'https://x' }],
  suggestions: [{ kind: 'research', nodeId: 'demo/pva', mode: 'general', label: 'More on PVA' }], usedWeb: true,
  debug: { tokens: 99 } };
const failed = { t: 'chat.failed', at: 30, chatId: 'main', replyTo: 'u2', error: 'rate limited' };

/** Problems with a fold's handling of chat events. Returns [] when correct. @param {typeof fold} f */
function checkChat(f) {
  const problems = [];
  const o = [created, asked, answered, failed].reduce((acc, e) => f(acc, /** @type {any} */ (e)), emptyOntology());
  const chat = /** @type {any[]} */ (o.chat ?? []);
  if (chat.map((m) => m.role).join() !== 'user,assistant,error') problems.push(`roles: ${chat.map((m) => m.role)}`);
  const s = JSON.stringify(chat);
  for (const leak of ['SHOULD-BE-DROPPED', 'secret', '"extra"', '"debug"']) if (s.includes(leak)) problems.push(`unknown field kept: ${leak}`);
  if (chat[2]?.msgId !== 'err:u2' || chat[2]?.text !== 'rate limited') problems.push('chat.failed message wrong');
  const again = f(o, /** @type {any} */ (asked));
  if ((again.chat ?? []).length !== 3) problems.push('repeated msgId appended twice');
  return problems;
}

test('empty and pre-chat maps fold to chat: []', () => {
  assert.deepEqual(emptyOntology().chat, []);
  const lines = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(foldAll(lines).chat, []);
});

test('chat events append in order, keep only contract fields, ignore repeats', () => {
  assert.deepEqual(checkChat(fold), []);
  const o = foldAll(/** @type {any} */ ([created, asked, answered]));
  assert.deepEqual(o.chat[0], { role: 'user', chatId: 'main', msgId: 'u1', text: 'What glue for clear parts?', at: 10,
    images: [{ hash: 'abc', mime: 'image/png', w: 640, h: 480 }] });
  assert.deepEqual(o.chat[1], { role: 'assistant', chatId: 'main', msgId: 'a1', replyTo: 'u1', text: 'PVA glue.', at: 20,
    citations: [{ nodeId: 'demo/pva', label: 'PVA glue' }], sources: [{ title: 'T', url: 'https://x' }],
    suggestions: [{ kind: 'research', nodeId: 'demo/pva', mode: 'general', label: 'More on PVA' }], usedWeb: true });
});

test('a chat event on an ontology object saved before 1.2.0 (no chat field) works', () => {
  const old = /** @type {any} */ ({ ...emptyOntology() });
  delete old.chat;
  assert.equal(fold(old, /** @type {any} */ (asked)).chat.length, 1);
  assert.equal(fold(old, /** @type {any} */ ({ t: 'insight', at: 1, text: 'x' })).chat, undefined); // untouched otherwise
});

test('planted faults: a fold that copies events whole, or ignores chat, is caught', () => {
  const copyWhole = (/** @type {any} */ o, /** @type {any} */ e) =>
    e.t?.startsWith('chat.') ? { ...o, chat: [...(o.chat ?? []), { ...e, role: { 'chat.asked': 'user', 'chat.answered': 'assistant', 'chat.failed': 'error' }[e.t] }] } : fold(o, e);
  assert.ok(checkChat(copyWhole).some((p) => p.startsWith('unknown field kept')));
  const ignore = (/** @type {any} */ o, /** @type {any} */ e) => (e.t?.startsWith('chat.') ? o : fold(o, e));
  assert.ok(checkChat(ignore).length > 0);
});
