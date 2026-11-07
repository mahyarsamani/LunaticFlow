// Runs inside the review webview. Blocks rendered by VS Code's Markdown engine carry
// data-line="<0-based source line>", which is what comments attach to.
(function () {
  const vscode = acquireVsCodeApi();
  vscode.setState({ uri: window.MDR_URI });

  const content = document.getElementById('mdr-content');
  const toolbar = document.getElementById('mdr-toolbar');

  let comments = [];
  let file = '';
  let hovered = null;
  /** Open composer: { line, quote, editId, text } */
  let draft = null;

  // ---------- floating controls ----------
  const addBtn = el('button', 'mdr-ui mdr-add', '+');
  addBtn.title = 'Comment on this block';
  document.body.appendChild(addBtn);

  const selBtn = el('button', 'mdr-ui mdr-sel', '💬 Comment');
  document.body.appendChild(selBtn);

  addBtn.addEventListener('mousedown', e => e.preventDefault());
  addBtn.addEventListener('click', () => {
    if (hovered) openComposer({ line: lineOf(hovered) });
  });

  selBtn.addEventListener('mousedown', e => e.preventDefault());
  selBtn.addEventListener('click', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const anchor = blockOf(sel.getRangeAt(0).startContainer);
    if (!anchor) return;
    const quote = sel.toString().trim().replace(/\s+/g, ' ').slice(0, 300);
    sel.removeAllRanges();
    selBtn.style.display = 'none';
    openComposer({ line: lineOf(anchor), quote });
  });

  content.addEventListener('mouseover', e => {
    const block = blockOf(e.target);
    if (!block || block === hovered) return;
    hovered = block;
    const r = block.getBoundingClientRect();
    addBtn.style.top = `${r.top + window.scrollY}px`;
    addBtn.style.display = 'block';
  });
  document.addEventListener('mouseleave', () => {
    addBtn.style.display = 'none';
    hovered = null;
  });

  document.addEventListener('mouseup', e => {
    if (e.target.closest && e.target.closest('.mdr-ui')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed || !content.contains(sel.anchorNode) || !blockOf(sel.anchorNode)) {
        selBtn.style.display = 'none';
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      selBtn.style.top = `${r.bottom + window.scrollY + 6}px`;
      selBtn.style.left = `${Math.max(8, r.left + window.scrollX)}px`;
      selBtn.style.display = 'block';
    });
  });

  content.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a || a.closest('.mdr-ui')) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) return; // let in-page anchors scroll
    e.preventDefault();
    vscode.postMessage({ type: 'link', href });
  });

  // ---------- messages from the extension ----------
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'render') {
      const keepDraft = captureDraft();
      file = data.file;
      comments = data.comments;
      const scroll = window.scrollY;
      content.innerHTML = data.html;
      draft = keepDraft;
      paint();
      window.scrollTo(0, scroll);
    } else if (data.type === 'comments') {
      draft = captureDraft();
      comments = data.comments;
      paint();
    }
  });

  // ---------- rendering ----------
  function paint() {
    document.querySelectorAll('.mdr-slot').forEach(n => n.remove());
    document.querySelectorAll('.mdr-has-comment').forEach(n => n.classList.remove('mdr-has-comment'));
    hovered = null;
    addBtn.style.display = 'none';

    const byLine = new Map();
    for (const c of comments) {
      if (!byLine.has(c.line)) byLine.set(c.line, []);
      byLine.get(c.line).push(c);
    }
    const draftLine = draft && !draft.editId ? draft.line : null;
    const lines = new Set([...byLine.keys(), ...(draftLine != null ? [draftLine] : [])]);
    for (const line of [...lines].sort((a, b) => a - b)) {
      const block = blockForLine(line);
      const slot = slotFor(block);
      if (block) block.classList.add('mdr-has-comment');
      const thread = el('div', 'mdr-thread');
      thread.dataset.line = String(line);
      const head = el('div', 'mdr-thread-head');
      const loc = el('a', 'mdr-loc', `@${file}#${line}`);
      loc.title = 'Show in source';
      loc.href = '#';
      loc.addEventListener('click', e => {
        e.preventDefault();
        vscode.postMessage({ type: 'reveal', line });
      });
      head.appendChild(loc);
      thread.appendChild(head);
      for (const c of byLine.get(line) || []) {
        thread.appendChild(draft && draft.editId === c.id ? composer() : commentCard(c));
      }
      if (draftLine === line) thread.appendChild(composer());
      insertSorted(slot, thread, line);
    }
    renderToolbar();
    const ta = document.querySelector('.mdr-composer textarea');
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  function commentCard(c) {
    const card = el('div', 'mdr-comment');
    if (c.quote) card.appendChild(el('div', 'mdr-quote', c.quote));
    card.appendChild(el('div', 'mdr-text', c.text));
    const actions = el('div', 'mdr-actions');
    actions.appendChild(button('Edit', () => openComposer({ line: c.line, editId: c.id, text: c.text, quote: c.quote })));
    actions.appendChild(button('Delete', () => vscode.postMessage({ type: 'delete', id: c.id })));
    card.appendChild(actions);
    return card;
  }

  function composer() {
    const box = el('div', 'mdr-composer');
    if (draft.quote && !draft.editId) box.appendChild(el('div', 'mdr-quote', draft.quote));
    const ta = document.createElement('textarea');
    ta.placeholder = 'Leave a comment…  (⌘/Ctrl+Enter to save, Esc to cancel)';
    ta.value = draft.text || '';
    ta.rows = 3;
    ta.addEventListener('input', () => (draft.text = ta.value));
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    box.appendChild(ta);
    const actions = el('div', 'mdr-actions');
    const saveBtn = button(draft.editId ? 'Update' : 'Comment', save);
    saveBtn.classList.add('mdr-primary');
    actions.appendChild(saveBtn);
    actions.appendChild(button('Cancel', cancel));
    box.appendChild(actions);
    return box;
  }

  function save() {
    const text = (draft.text || '').trim();
    if (!text) return cancel();
    if (draft.editId) vscode.postMessage({ type: 'edit', id: draft.editId, text });
    else vscode.postMessage({ type: 'add', line: draft.line, text, quote: draft.quote });
    draft = null; // the store echoes back a 'comments' message that repaints
  }

  function cancel() {
    draft = null;
    paint();
  }

  function openComposer(d) {
    if (draft && draft.text && draft.text.trim() && !confirmDiscard()) return;
    draft = { ...d, text: d.text || '' };
    paint();
    const ta = document.querySelector('.mdr-composer textarea');
    if (ta) ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function confirmDiscard() {
    // window.confirm is unavailable in webviews; keep the existing draft and focus it instead.
    const ta = document.querySelector('.mdr-composer textarea');
    if (ta) ta.focus();
    return false;
  }

  function captureDraft() {
    return draft ? { ...draft } : null;
  }

  function renderToolbar() {
    toolbar.innerHTML = '';
    const n = comments.length;
    toolbar.appendChild(el('span', 'mdr-count', n === 1 ? '1 comment' : `${n} comments`));
    toolbar.appendChild(el('span', 'mdr-hint', 'Hover a block and click +, or select text to comment'));
    const spacer = el('span', 'mdr-spacer');
    toolbar.appendChild(spacer);
    toolbar.appendChild(button('Copy file', () => vscode.postMessage({ type: 'copy' }), 'Copy this file’s comments'));
    toolbar.appendChild(button('Copy all', () => vscode.postMessage({ type: 'copyAll' }), 'Copy comments from every file'));
    toolbar.appendChild(button('Export', () => vscode.postMessage({ type: 'export' }), 'Open all comments in a new document'));
    const clear = button('Clear', () => vscode.postMessage({ type: 'clear' }), 'Delete this file’s comments');
    clear.disabled = n === 0;
    toolbar.appendChild(clear);
  }

  // ---------- DOM helpers ----------
  function blockOf(node) {
    const elNode = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!elNode || elNode.closest('.mdr-ui, .mdr-slot')) return null;
    const b = elNode.closest('[data-line]');
    return b && content.contains(b) ? b : null;
  }

  function lineOf(block) {
    return Number(block.getAttribute('data-line')) + 1;
  }

  /** The deepest block starting at this line, else the nearest one before it. */
  function blockForLine(line) {
    const blocks = [...content.querySelectorAll('[data-line]')].filter(b => !b.closest('.mdr-slot'));
    let exact = null;
    let before = null;
    for (const b of blocks) {
      const l = lineOf(b);
      if (l === line) exact = b; // later in document order = deeper nesting
      if (l <= line && (!before || l >= lineOf(before))) before = b;
    }
    return exact || before || null;
  }

  /** Where a block's threads are shown: after it, inside list items, below tables. */
  function slotFor(block) {
    if (!block) {
      let top = content.querySelector(':scope > .mdr-slot.mdr-top');
      if (!top) {
        top = el('div', 'mdr-ui mdr-slot mdr-top');
        content.prepend(top);
      }
      return top;
    }
    const table = block.closest('table');
    const anchor = table && content.contains(table) ? table : block;
    if (anchor.tagName === 'LI') {
      let slot = [...anchor.children].find(c => c.classList.contains('mdr-slot'));
      if (!slot) {
        slot = el('div', 'mdr-ui mdr-slot');
        const nested = [...anchor.children].find(c => c.tagName === 'UL' || c.tagName === 'OL');
        anchor.insertBefore(slot, nested || null);
      }
      return slot;
    }
    let next = anchor.nextElementSibling;
    if (next && next.classList.contains('mdr-slot')) return next;
    const slot = el('div', 'mdr-ui mdr-slot');
    anchor.after(slot);
    return slot;
  }

  function insertSorted(slot, thread, line) {
    const after = [...slot.children].find(t => Number(t.dataset.line) > line);
    slot.insertBefore(thread, after || null);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(label, onClick, title) {
    const b = el('button', 'mdr-btn', label);
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  renderToolbar();
  vscode.postMessage({ type: 'ready' });
})();
