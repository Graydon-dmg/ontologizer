// @ts-check
import {
  chatThread, pendingQuestion, answerCitations, starterQuestions, acceptImages, chatBody, postChat,
  emptyAnswer, applyChatItem, suggestionAction, researchBusy, scaleSize, pickEncoding, MAX_IMAGES,
} from '../chat.js';
import { renderMarkdown } from '../chat-render.js';

/** The Chat pane (in the side panel) and the top-bar "Chat" button.
 * @param {HTMLElement} el  #chat @param {any} shell */
export function mountChat(el, shell) {
  el.classList.add('onto-chat');
  const mk = (/** @type {string} */ tag, /** @type {string} */ cls = '', /** @type {string} */ text = '') => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  // --- citations on the map: view.cite (persisted across view switches, cleared on background click)
  /** @type {string[]|null} */
  let cited = null;
  const applyCite = () => { const v = shell.activeView(); if (v && typeof v.cite === 'function') v.cite(cited); };
  /** @param {string[]|null} ids */
  const cite = (ids) => { cited = ids && ids.length ? ids : null; applyCite(); paintCiteState(); };
  const focusNode = (/** @type {string} */ id) => {
    shell.act({ type: 'focus', nodeId: id });
    const v = shell.activeView();
    if (v && typeof v.setFocus === 'function') v.setFocus(id);
  };
  const onCite = (/** @type {string} */ id) => { focusNode(id); cite([id]); };
  shell.on('view', applyCite);
  shell.on('select', (/** @type {any} */ d) => { if (d && !d.nodeId && cited) cite(null); });
  shell.on('side', (/** @type {any} */ d) => {
    if (d && d.active !== 'chat' && cited) cite(null);
    if (d && d.active === 'chat') { paint(); setTimeout(() => input.focus(), 0); }
  });

  // --- layout
  const log = mk('div', 'chat-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-label', 'Chat about this map');
  const citeBar = mk('div', 'chat-citebar');
  citeBar.hidden = true;
  const citeText = mk('span', '', 'Cited nodes are highlighted on the map.');
  const citeClear = /** @type {HTMLButtonElement} */ (mk('button', 'linkish', 'Clear'));
  citeClear.type = 'button';
  citeClear.addEventListener('click', () => cite(null));
  citeBar.append(citeText, citeClear);
  const paintCiteState = () => { citeBar.hidden = !cited; };

  const compose = mk('form', 'chat-compose');
  const thumbs = mk('div', 'chat-thumbs');
  const input = /** @type {HTMLTextAreaElement} */ (mk('textarea', 'chat-input'));
  input.rows = 2;
  input.maxLength = 4000;
  input.placeholder = 'Ask about this map…';
  input.setAttribute('aria-label', 'Your question');
  const row = mk('div', 'chat-row');
  const file = /** @type {HTMLInputElement} */ (mk('input'));
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/gif,image/webp';
  file.multiple = true;
  file.hidden = true;
  const attach = /** @type {HTMLButtonElement} */ (mk('button', 'chat-attach', 'Add image'));
  attach.type = 'button';
  attach.title = `Add up to ${MAX_IMAGES} images. You can also paste or drop them here.`;
  const send = /** @type {HTMLButtonElement} */ (mk('button', 'chat-send', 'Send'));
  send.type = 'submit';
  row.append(attach, file, send);
  const err = mk('div', 'chat-error');
  err.setAttribute('role', 'alert');
  const privacy = mk('p', 'chat-privacy', 'Questions and images are sent to Anthropic. Images are saved with this map.');
  compose.append(thumbs, input, row, err, privacy);
  el.append(log, citeBar, compose);

  // --- images: attach button, paste and drop; downscaled and re-encoded in the browser
  /** @type {{ mime: string, data: string, url: string, name: string }[]} */
  let images = [];
  const paintThumbs = () => {
    thumbs.replaceChildren(...images.map((im, i) => {
      const t = mk('span', 'chat-thumb');
      const img = /** @type {HTMLImageElement} */ (mk('img'));
      img.src = im.url;
      img.alt = im.name || `Image ${i + 1}`;
      const x = /** @type {HTMLButtonElement} */ (mk('button', 'chat-thumb-x', '×'));
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${img.alt}`);
      x.addEventListener('click', () => { images = images.filter((_, j) => j !== i); paintThumbs(); input.focus(); });
      t.append(img, x);
      return t;
    }));
    thumbs.hidden = images.length === 0;
    attach.disabled = images.length >= MAX_IMAGES;
  };
  /** @param {File} f */
  const encode = async (f) => {
    const bmp = await createImageBitmap(f);
    const { w, h } = scaleSize(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    const enc = pickEncoding(f.type);
    if (enc.mime === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const url = canvas.toDataURL(enc.mime, enc.quality);
    return { mime: enc.mime, data: url.slice(url.indexOf(',') + 1), url, name: f.name || '' };
  };
  /** @param {File[]} files */
  const addFiles = async (files) => {
    const { accepted, error } = acceptImages(images.length, files);
    err.textContent = error;
    for (const f of accepted) {
      try { images = [...images, await encode(f)].slice(0, MAX_IMAGES); }
      catch { err.textContent = 'That image could not be read.'; }
      paintThumbs();
    }
  };
  shell.chatAddFiles = addFiles; // for tests and drag-and-drop
  attach.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { addFiles([...(file.files || [])]); file.value = ''; });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('drop'); });
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); addFiles([...(e.dataTransfer?.files || [])]); });

  // --- sending and the live answer
  /** @type {import('../chat.js').LiveAnswer|null} */
  let live = null;
  let busy = false;
  const submit = async () => {
    if (busy) return;
    const body = chatBody(input.value, images, shell.snapshot().view.lens);
    if (!body) { input.focus(); return; }
    const keepText = input.value, keepImages = images;
    busy = true; send.disabled = true; err.textContent = '';
    input.value = ''; images = []; paintThumbs();
    live = emptyAnswer();
    live = { ...live, status: 'Sending…' };
    pendingText = body.text;
    paint();
    const r = await postChat(fetch, body, (item) => { live = applyChatItem(/** @type {any} */ (live), item); paint(); });
    busy = false; send.disabled = false;
    if (!r.ok) {
      live = null; pendingText = '';
      err.textContent = r.error || 'The question could not be sent.';
      input.value = keepText; images = keepImages; paintThumbs();
      shell.emit('notice', { text: `Chat: ${r.error}` });
    }
    paint();
  };
  /** The text of the question being sent, shown until its chat.asked event arrives. */
  let pendingText = '';
  compose.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });

  // --- rendering
  const answerBlock = (/** @type {any} */ a, /** @type {boolean} */ streaming) => {
    const o = shell.snapshot();
    const box = mk('div', 'chat-msg assistant');
    if (a.status) box.append(mk('p', 'chat-status', a.status));
    if (a.text) box.append(renderMarkdown(document, a.text, { ontology: o, onCite }));
    else if (streaming && !a.status) box.append(mk('p', 'chat-status', 'Thinking…'));
    const ids = answerCitations(o, a);
    if (ids.length > 1) {
      const all = /** @type {HTMLButtonElement} */ (mk('button', 'linkish chat-allcited', `Show all ${ids.length} cited on the map`));
      all.type = 'button';
      all.addEventListener('click', () => cite(ids));
      box.append(all);
    }
    if (a.sources && a.sources.length) {
      box.append(mk('h4', 'chat-h', 'From the web'));
      const ul = mk('ul', 'chat-sources');
      for (const s of a.sources) {
        const li = mk('li');
        const link = /** @type {HTMLAnchorElement} */ (mk('a', '', s.title || s.url));
        link.href = s.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        li.append(link); ul.append(li);
      }
      box.append(ul);
    }
    const sugg = (a.suggestions || []).filter((s) => o.nodes[s.nodeId]);
    if (sugg.length) {
      const wrap = mk('div', 'chat-suggest');
      for (const s of sugg) {
        const busyNow = researchBusy(o, s.nodeId);
        const b = /** @type {HTMLButtonElement} */ (mk('button', 'chat-research', busyNow ? `Researching ${o.nodes[s.nodeId].label}…` : `Research ${o.nodes[s.nodeId].label}`));
        b.type = 'button';
        b.disabled = busyNow;
        b.title = s.mode === 'general' ? 'Research this node in general (adds nodes to the map)' : 'Research this node in the context of this map (adds nodes)';
        b.addEventListener('click', () => { b.disabled = true; b.textContent = `Researching ${o.nodes[s.nodeId].label}…`; shell.act(suggestionAction(s)); });
        wrap.append(b);
      }
      box.append(wrap);
    }
    if (a.error) box.append(mk('p', 'chat-failed', a.error));
    return box;
  };
  const questionBlock = (/** @type {any} */ q) => {
    const box = mk('div', 'chat-msg user');
    if (q.text) box.append(mk('p', '', q.text));
    if (q.images && q.images.length) {
      const imgs = mk('div', 'chat-imgs');
      for (const im of q.images) {
        const i = /** @type {HTMLImageElement} */ (mk('img'));
        i.src = `/api/attachments/${encodeURIComponent(im.hash)}`;
        i.alt = 'Attached image';
        i.loading = 'lazy';
        imgs.append(i);
      }
      box.append(imgs);
    }
    return box;
  };
  const starters = () => {
    const box = mk('div', 'chat-empty');
    box.append(mk('p', 'chat-hint', 'Ask anything about this map. Answers point to the nodes they use.'));
    for (const s of starterQuestions(shell.snapshot())) {
      const b = /** @type {HTMLButtonElement} */ (mk('button', 'chat-starter', s));
      b.type = 'button';
      b.addEventListener('click', () => { input.value = s; submit(); });
      box.append(b);
    }
    return box;
  };

  function paint() {
    const o = shell.snapshot();
    const thread = chatThread(o);
    const pending = pendingQuestion(o);
    // Keep the live answer until the saved copy (same msgId, or the failure reply) is in the log.
    if (live && live.done && !busy) {
      const saved = live.id && (o.chat || []).some((/** @type {any} */ m) => m.msgId === live?.id);
      const failedSaved = live.error && thread.length && thread[thread.length - 1].reply && thread[thread.length - 1].reply.role === 'error';
      if (saved || failedSaved) { live = null; pendingText = ''; }
    }
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren();
    if (!thread.length && !live) log.append(starters());
    for (const t of thread) {
      log.append(questionBlock(t.question));
      if (t.reply) {
        if (t.reply.role === 'error') { const b = mk('div', 'chat-msg assistant'); b.append(mk('p', 'chat-failed', t.reply.text)); log.append(b); }
        else log.append(answerBlock(t.reply, false));
      } else if (live) log.append(answerBlock(live, !live.done));
      else log.append(answerBlock({ status: 'Writing an answer…' }, true));
    }
    if (live && !pending && pendingText) {
      // chat.asked has not arrived yet: show the question and the answer so far.
      log.append(questionBlock({ text: pendingText }));
      log.append(answerBlock(live, !live.done));
    }
    if (stick || busy) log.scrollTop = log.scrollHeight;
  }
  shell.on('event', (/** @type {any} */ d) => {
    const t = d && d.event && d.event.t;
    if (t === 'chat.asked' || t === 'chat.answered' || t === 'chat.failed') {
      if (t === 'chat.asked') pendingText = '';
      paint();
    } else if (t === 'node.added' || t === 'node.updated' || t === 'category.added') {
      if (!el.hidden) paint();
    }
  });
  paint();
}

const BUBBLE = '<svg class="chat-btn-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

/** The top-bar "Ask the map" button, right of Search: toggles the Chat pane. @param {HTMLElement} el @param {any} shell */
export function mountChatButton(el, shell) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chat-btn';
  // "Ask" at narrow widths (CSS picks the label); the accessible name is always the full one
  b.innerHTML = `${BUBBLE}<span class="chat-btn-long">Ask the map</span><span class="chat-btn-short" aria-hidden="true">Ask</span>`;
  b.setAttribute('aria-label', 'Ask the map');
  b.setAttribute('aria-controls', 'chat');
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => shell.side.toggle('chat'));
  shell.on('side', (/** @type {any} */ d) => b.setAttribute('aria-pressed', String(!!d && d.active === 'chat')));
  el.append(b);
}
