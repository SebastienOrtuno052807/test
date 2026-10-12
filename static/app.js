"use strict";
/* OpenReader client */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({"Content-Type": "application/json"}, opts.headers || {});
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  $("#toast-root").appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function closeModal() { $("#modal-root").innerHTML = ""; }
function modal(html) {
  $("#modal-root").innerHTML =
    `<div class="modal-back" onclick="if(event.target===this)closeModal()">
       <div class="modal">${html}</div></div>`;
}

/* ---------------- state + router ---------------- */
const state = {
  view: "library", tag: null, query: "", sort: "recent", typeFilter: "",
  favorite: false, archived: false,
  item: null, reviewQueue: [], reviewIdx: 0,
};

/* ---------------- theme (dark / light) ---------------- */
function setTheme(t) {
  t = t === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("or-theme", t); } catch (e) {}
  const b = $("#btn-theme");
  if (b) { b.textContent = t === "dark" ? "☀️" : "🌙"; b.title = t === "dark" ? "Switch to light mode" : "Switch to dark mode"; }
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.content = t === "dark" ? "#171a21" : "#f7f8fa";
}
function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
}

function navTo(view, opts) {
  state.view = view;
  state.tag = (opts && opts.tag !== undefined) ? opts.tag : state.tag;
  if (view !== "library" && view !== "favorites" && view !== "archive") state.tag = state.tag;
  $$("#main-nav .nav").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  render();
}

$$("#main-nav .nav").forEach(b => b.addEventListener("click", () => {
  state.tag = null; state.favorite = false; state.archived = false;
  navTo(b.dataset.view);
}));

let searchTimer = null;
$("#search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value.trim();
    if (["library", "favorites", "archive"].includes(state.view)) renderLibrary();
  }, 300);
});

function render() {
  closeToolbar(); closePopover();
  $("#view").onscroll = null;
  $("#view").classList.remove("pdf-mode");
  $("#view").classList.remove("lib-view");
  $("#topbar").style.display = "";
  document.removeEventListener("keydown", pdfKeyHandler);
  if (pdfObserver) { pdfObserver.disconnect(); pdfObserver = null; }
  pdfDoc = null;
  ({library: renderLibrary, favorites: renderLibrary, archive: renderLibrary,
    review: renderReview, import: renderImport}[state.view] || renderLibrary)();
}

/* ---------------- sidebar ---------------- */
async function refreshSidebar() {
  try {
    const [tags, stats, q] = await Promise.all([
      api("/api/tags"), api("/api/stats"), api("/api/review/queue?limit=1"),
    ]);
    const tl = $("#tag-list");
    tl.innerHTML = tags.length ? "" : '<div class="side-hint">No tags yet</div>';
    tags.forEach(t => {
      const row = document.createElement("div");
      row.className = "tag-row" + (state.tag === t.name ? " active" : "");
      row.innerHTML = `<span>🏷</span><span>${esc(t.name)}</span>
        <span class="count">${t.count}</span>
        <button class="x" title="Delete tag">×</button>`;
      row.addEventListener("click", e => {
        if (e.target.classList.contains("x")) {
          if (confirm(`Delete tag "${t.name}"?`))
            api("/api/tags/" + encodeURIComponent(t.name), {method: "DELETE"})
              .then(() => { state.tag = null; refreshSidebar(); render(); });
          return;
        }
        state.tag = state.tag === t.name ? null : t.name;
        state.favorite = false; state.archived = false;
        $$("#main-nav .nav").forEach(b => b.classList.toggle("active", b.dataset.view === "library"));
        state.view = "library"; render();
      });
      tl.appendChild(row);
    });
    const badge = $("#due-badge");
    badge.textContent = q.due;
    badge.classList.toggle("hidden", !q.due);
    $("#side-stats").innerHTML =
      `📚 ${stats.items} items · 🖍 ${stats.highlights} highlights<br>🔥 ${stats.due} due for review`;
  } catch (e) { /* sidebar is best-effort */ }
}

/* ---------------- library ---------------- */
async function renderLibrary() {
  const v = $("#view");
  v.classList.add("lib-view");
  const fav = state.view === "favorites", arch = state.view === "archive";
  const title = fav ? "⭐ Favorites" : arch ? "🗄 Archive"
    : state.tag ? `🏷 ${esc(state.tag)}` : "📚 Library";
  const tabs = [["", "All"], ["article", "Articles"], ["pdf", "PDFs"], ["note", "Notes"]];
  v.innerHTML = `<div class="view-head"><h2>${title}</h2>
    <span class="sub" id="lib-count"></span>
    <div class="sort-row">Sort <select id="sort-sel">
      <option value="recent">Recent</option><option value="oldest">Oldest</option>
      <option value="title">Title</option><option value="longest">Longest</option>
    </select></div></div>
    <div class="lib-tabs">${tabs.map(([val, lbl]) =>
      `<button data-type="${val}" class="${state.typeFilter === val ? "active" : ""}">${lbl}</button>`).join("")}</div>
    <div class="doc-list" id="cards"></div>`;
  $$(".lib-tabs button").forEach(b => b.addEventListener("click", () => {
    state.typeFilter = b.dataset.type; renderLibrary();
  }));
  $("#sort-sel").value = state.sort;
  $("#sort-sel").addEventListener("change", e => { state.sort = e.target.value; renderLibrary(); });
  const params = new URLSearchParams({
    q: state.query, tag: state.tag || "", archived: arch ? "1" : "0",
    favorite: fav ? "1" : "0", sort: state.sort,
  });
  let items;
  try { items = await api("/api/items?" + params); }
  catch (e) { v.innerHTML = `<div class="empty">Couldn't load library: ${esc(e.message)}</div>`; return; }
  const cards = $("#cards");
  if (!items.length) {
    cards.innerHTML = `<div class="empty">Nothing here yet.<br>Save an article with <b>+ Save URL</b> above, or upload a PDF / EPUB.</div>`;
    return;
  }
  const typeIcon = t => ({article: "📰", note: "📝", pdf: "📕", epub: "📗", import: "📥"}[t] || "📰");
  const typeMatch = t => !state.typeFilter ||
    (state.typeFilter === "pdf" ? (t === "pdf" || t === "epub") : t === state.typeFilter);
  let shown = 0;
  items.forEach(it => {
    if (!typeMatch(it.source_type)) return;
    shown++;
    const mins = it.word_count ? Math.max(1, Math.round(it.word_count / 200)) : 0;
    const r = document.createElement("div");
    r.className = "doc-row";
    r.innerHTML = `
      <div class="doc-thumb">${typeIcon(it.source_type)}</div>
      <div class="doc-main">
        <div class="doc-title">${esc(it.title) || "(untitled)"}</div>
        <div class="doc-excerpt">${esc(it.excerpt || "")}</div>
        <div class="doc-meta"><span>${esc(it.author || "Unknown")}</span>
          ${mins ? `<span class="dot-sep">·</span><span>${mins} min</span>` : ""}
          ${it.highlight_count ? `<span class="dot-sep">·</span><span>🖍 ${it.highlight_count}</span>` : ""}
          ${(it.tags || []).map(t => `<span class="tag-chip">${esc(t)}</span>`).join("")}</div>
        ${it.read_progress > 0.02 ? `<div class="progress"><i style="width:${Math.round(it.read_progress * 100)}%"></i></div>` : ""}
      </div>
      <div class="doc-right">
        <div class="doc-date">${fmtDate(it.saved_at || it.created_at)}</div>
        <div class="row-actions">
          <button data-a="fav" class="${it.favorite ? "on" : ""}" title="${it.favorite ? "Unfavorite" : "Favorite"}">★</button>
          <button data-a="arch" title="${it.archived ? "Unarchive" : "Archive"}">🗄</button>
        </div>
      </div>`;
    r.addEventListener("click", e => {
      const b = e.target.closest(".row-actions button");
      if (b) { e.stopPropagation(); rowQuickAction(it.id, b.dataset.a); return; }
      openReader(it.id);
    });
    cards.appendChild(r);
  });
  $("#lib-count").textContent = `${shown} item${shown === 1 ? "" : "s"}`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const day = d.getDate();
  const suf = (day % 10 === 1 && day !== 11) ? "st" : (day % 10 === 2 && day !== 12) ? "nd"
    : (day % 10 === 3 && day !== 13) ? "rd" : "th";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const yr = d.getFullYear() === new Date().getFullYear() ? "" : " " + d.getFullYear();
  return `${months[d.getMonth()]} ${day}${suf}${yr}`;
}

async function rowQuickAction(id, a) {
  try {
    if (a === "fav") {
      const it = await api("/api/items/" + id);
      await api("/api/items/" + id, {method: "PATCH", body: JSON.stringify({favorite: !it.favorite})});
    } else {
      const it = await api("/api/items/" + id);
      await api("/api/items/" + id, {method: "PATCH", body: JSON.stringify({archived: !it.archived})});
    }
    renderLibrary(); refreshSidebar();
  } catch (e) { toast("Couldn't update: " + e.message); }
}

/* ---------------- reader + highlights ---------------- */
let saveProgressTimer = null;

async function openReader(id) {
  const v = $("#view");
  v.innerHTML = `<div class="empty">Loading…</div>`;
  let it;
  try { it = await api("/api/items/" + id); }
  catch (e) { v.innerHTML = `<div class="empty">Couldn't open item: ${esc(e.message)}</div>`; return; }
  state.item = it;
  if (it.source_type === "pdf" && window.pdfjsLib) { renderPdfReader(it); return; }
  const d = it.created_at ? new Date(it.created_at).toLocaleDateString() : "";
  v.innerHTML = `<div id="reader-wrap">
    <header>
      <h1>${esc(it.title)}</h1>
      <div class="byline">${esc(it.author || "")} ${it.author && d ? "·" : ""} ${d}
        ${it.url ? `· <a href="${esc(it.url)}" target="_blank" rel="noopener">original ↗</a>` : ""}</div>
      <div class="reader-actions">
        <button class="btn" id="r-fav">${it.favorite ? "★ Unfavorite" : "☆ Favorite"}</button>
        <button class="btn" id="r-arch">${it.archived ? "Unarchive" : "Archive"}</button>
        <button class="btn" id="r-tags">🏷 Tags</button>
        <button class="btn" id="r-back">← Library</button>
        <button class="btn danger" id="r-del" style="margin-left:auto">Delete</button>
      </div>
      <div class="byline">${(it.tags || []).map(t => `<span class="tag-chip">${esc(t)}</span>`).join(" ")}</div>
    </header>
    <div id="reader-body">${it.content_html}</div>
  </div>`;
  // fix relative links/images
  if (it.url) {
    try {
      const base = new URL(it.url);
      $$("#reader-body a[href]").forEach(a => {
        try { a.href = new URL(a.getAttribute("href"), base).href; a.target = "_blank"; a.rel = "noopener"; } catch (e) {}
      });
      $$("#reader-body img[src]").forEach(im => {
        try { im.src = new URL(im.getAttribute("src"), base).href; } catch (e) {}
        im.loading = "lazy";
      });
    } catch (e) {}
  }
  $("#r-back").addEventListener("click", () => navTo(state.archived ? "archive" : "library"));
  $("#r-fav").addEventListener("click", async () => {
    const u = await api("/api/items/" + id, {method: "PATCH", body: JSON.stringify({favorite: !it.favorite})});
    state.item = Object.assign(it, u); openReader(id); refreshSidebar();
  });
  $("#r-arch").addEventListener("click", async () => {
    await api("/api/items/" + id, {method: "PATCH", body: JSON.stringify({archived: !it.archived})});
    toast(it.archived ? "Unarchived" : "Archived"); refreshSidebar(); renderLibrary(); state.view = "library";
    $$("#main-nav .nav").forEach(b => b.classList.toggle("active", b.dataset.view === "library"));
  });
  $("#r-tags").addEventListener("click", () => {
    modal(`<h3>Tags</h3><input type="text" id="m-tags" value="${esc((it.tags || []).join(", "))}"
      placeholder="comma, separated, tags"><div class="row">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="m-tags-save">Save</button></div>`);
    $("#m-tags-save").addEventListener("click", async () => {
      const tags = $("#m-tags").value.split(",").map(s => s.trim()).filter(Boolean);
      await api("/api/items/" + id, {method: "PATCH", body: JSON.stringify({tags})});
      closeModal(); openReader(id); refreshSidebar();
    });
  });
  $("#r-del").addEventListener("click", async () => {
    if (!confirm("Delete this item and its highlights?")) return;
    await api("/api/items/" + id, {method: "DELETE"});
    toast("Deleted"); refreshSidebar();
    state.view = "library";
    $$("#main-nav .nav").forEach(b => b.classList.toggle("active", b.dataset.view === "library"));
    render();
  });
  renderHighlights(it.highlights || []);
  document.addEventListener("mouseup", onSelect);
  v.onscroll = trackProgress;
  setTimeout(() => { v.scrollTop = (v.scrollHeight - v.clientHeight) * (it.read_progress || 0); }, 60);
}

function trackProgress() {
  const v = $("#view"), it = state.item;
  if (!it || state.view === "review") return;
  const max = v.scrollHeight - v.clientHeight;
  if (max <= 0) return;
  const p = Math.min(1, v.scrollTop / max);
  clearTimeout(saveProgressTimer);
  saveProgressTimer = setTimeout(() => {
    if (Math.abs(p - (it.read_progress || 0)) > 0.03)
      api("/api/items/" + it.id, {method: "PATCH", body: JSON.stringify({read_progress: p})}).catch(() => {});
  }, 1500);
}

/* --- text-node offset helpers (single source of truth for matching) --- */
function textNodes(root) {
  const nodes = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      let p = n.parentNode;
      while (p && p !== root) { if (p.tagName === "MARK") return NodeFilter.FILTER_REJECT; p = p.parentNode; }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (w.nextNode()) nodes.push(w.currentNode);
  return nodes;
}
function charOffset(nodes, node, off) {
  let acc = 0;
  for (const n of nodes) {
    if (n === node) return acc + off;
    acc += n.nodeValue.length;
  }
  return -1;
}
function nodeAt(nodes, offset) {
  let acc = 0;
  for (const n of nodes) {
    if (offset <= acc + n.nodeValue.length) return {node: n, off: offset - acc};
    acc += n.nodeValue.length;
  }
  return null;
}
function boundaryScore(hay, needle, fromEnd) {
  // chars matching from the boundary between highlight and context
  const a = fromEnd ? hay.slice(-needle.length) : hay.slice(0, needle.length);
  const b = fromEnd ? needle.slice(-a.length) : needle.slice(0, a.length);
  let s = 0;
  if (fromEnd) { for (let i = 1; i <= a.length; i++) { if (a[a.length - i] === b[b.length - i]) s++; else break; } }
  else { for (let i = 0; i < a.length; i++) { if (a[i] === b[i]) s++; else break; } }
  return s;
}
function findBest(full, text, prefix, suffix) {
  const idxs = [];
  let i = full.indexOf(text);
  while (i !== -1) { idxs.push(i); i = full.indexOf(text, i + 1); if (idxs.length > 60) break; }
  if (!idxs.length) return -1;
  let best = idxs[0], bestScore = -1;
  for (const ix of idxs) {
    const pre = full.slice(Math.max(0, ix - 48), ix);
    const suf = full.slice(ix + text.length, ix + text.length + 48);
    const s = boundaryScore(pre, (prefix || "").slice(-48), true)
            + boundaryScore(suf, (suffix || "").slice(0, 48), false);
    if (s > bestScore) { bestScore = s; best = ix; }
  }
  return best;
}
function wrapAt(root, start, end, hl) {
  const nodes = textNodes(root);
  const s = nodeAt(nodes, start), e = nodeAt(nodes, end);
  if (!s || !e) return false;
  const range = document.createRange();
  try {
    range.setStart(s.node, s.off); range.setEnd(e.node, e.off);
    const mark = document.createElement("mark");
    mark.className = "hl-" + (hl.color || "yellow");
    mark.dataset.id = hl.id;
    mark.addEventListener("click", ev => { ev.stopPropagation(); openPopover(hl, ev.clientX, ev.clientY); });
    range.surroundContents(mark);
    return true;
  } catch (err) { return false; }
}
function renderHighlights(highlights) {
  const root = $("#reader-body");
  if (!root) return;
  const sorted = highlights.slice().sort((a, b) => b.text.length - a.text.length);
  sorted.forEach(hl => {
    const nodes = textNodes(root);
    const full = nodes.map(n => n.nodeValue).join("");
    const ix = findBest(full, hl.text, hl.prefix, hl.suffix);
    if (ix >= 0) wrapAt(root, ix, ix + hl.text.length, hl);
  });
}

/* --- creating highlights --- */
const COLORS = ["yellow", "green", "blue", "pink", "orange"];
function closeToolbar() { const t = $("#hl-toolbar"); if (t) t.remove(); }
function closePopover() { const p = $("#hl-pop"); if (p) p.remove(); }

function onSelect(e) {
  if (state.view === "review") return;
  const root = $("#reader-body");
  if (!root) return;
  const sel = window.getSelection();
  closeToolbar();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  const text = sel.toString().trim();
  if (text.length < 3) return;
  // don't start a highlight inside an existing one
  let p = range.commonAncestorContainer;
  while (p && p !== root) { if (p.nodeType === 1 && p.tagName === "MARK") return; p = p.parentNode; }
  const rect = range.getBoundingClientRect();
  const tb = document.createElement("div");
  tb.id = "hl-toolbar";
  tb.innerHTML = COLORS.map(c => `<div class="dot ${c}" data-c="${c}" title="${c}"></div>`).join("");
  tb.style.left = Math.min(window.innerWidth - 220, Math.max(8, rect.left + rect.width / 2 - 100)) + "px";
  tb.style.top = (rect.top - 52 > 8 ? rect.top - 52 : rect.bottom + 10) + "px";
  tb.addEventListener("mousedown", ev => ev.preventDefault()); // keep selection
  tb.addEventListener("click", async ev => {
    const dot = ev.target.closest(".dot");
    if (!dot) return;
    ev.stopPropagation();
    await saveHighlight(dot.dataset.c);
  });
  document.body.appendChild(tb);
}

async function saveHighlight(color) {
  const root = $("#reader-body"), it = state.item;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const nodes = textNodes(root);
  const full = nodes.map(n => n.nodeValue).join("");
  const start = charOffset(nodes, range.startContainer, range.startOffset);
  const end = charOffset(nodes, range.endContainer, range.endOffset);
  closeToolbar();
  if (start < 0 || end <= start) { toast("Couldn't capture that selection."); return; }
  const text = full.slice(start, end);
  const prefix = full.slice(Math.max(0, start - 48), start);
  const suffix = full.slice(end, end + 48);
  try {
    const hl = await api(`/api/items/${it.id}/highlights`, {
      method: "POST",
      body: JSON.stringify({text, prefix, suffix, color}),
    });
    sel.removeAllRanges();
    wrapAt(root, start, end, hl);
    state.item.highlights = (state.item.highlights || []).concat([hl]);
    toast("Highlighted 🖍");
    refreshSidebar();
  } catch (e) { toast("Highlight failed: " + e.message); }
}

async function openPopover(hl, x, y) {
  closePopover();
  const pop = document.createElement("div");
  pop.id = "hl-pop";
  pop.innerHTML = `
    <div class="hl-text">“${esc(hl.text.slice(0, 220))}${hl.text.length > 220 ? "…" : ""}”</div>
    <div class="dots">${COLORS.map(c =>
      `<div class="dot ${c}${hl.color === c ? " sel" : ""}" data-c="${c}"></div>`).join("")}</div>
    <textarea id="pop-note" placeholder="Add a note…">${esc(hl.note || "")}</textarea>
    <input type="text" id="pop-tags" placeholder="tags, comma separated" value="${esc(hl.tags || "")}">
    <div class="row">
      <button class="btn danger" id="pop-del">Delete</button>
      <button class="btn primary" id="pop-save">Save</button>
    </div>`;
  pop.style.left = Math.min(window.innerWidth - 320, Math.max(8, x - 150)) + "px";
  pop.style.top = Math.min(window.innerHeight - 340, y + 12) + "px";
  pop.addEventListener("click", ev => ev.stopPropagation());
  document.body.appendChild(pop);
  let color = hl.color;
  pop.addEventListener("click", ev => {
    const dot = ev.target.closest(".dot");
    if (dot) { color = dot.dataset.c; $$(".dot", pop).forEach(d => d.classList.toggle("sel", d === dot)); }
  });
  $("#pop-save").addEventListener("click", async () => {
    const body = {note: $("#pop-note").value, tags: $("#pop-tags").value, color};
    const updated = await api("/api/highlights/" + hl.id, {method: "PATCH", body: JSON.stringify(body)});
    Object.assign(hl, updated);
    document.querySelectorAll(`mark[data-id="${hl.id}"]`).forEach(mk => { mk.className = "hl-" + updated.color; });
    closePopover(); toast("Saved"); refreshSidebar();
    if ($("#tab-notebook")) buildNotebookTab(state.item);
  });
  $("#pop-del").addEventListener("click", async () => {
    await api("/api/highlights/" + hl.id, {method: "DELETE"});
    document.querySelectorAll(`mark[data-id="${hl.id}"]`).forEach(mark => {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
    state.item.highlights = (state.item.highlights || []).filter(h => h.id !== hl.id);
    closePopover(); toast("Highlight deleted"); refreshSidebar();
    if ($("#tab-notebook")) buildNotebookTab(state.item);
  });
}
document.addEventListener("click", () => {
  closeToolbar(); closePopover();
  const m = $("#pdf-menu");
  if (m) m.classList.add("hidden");
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeModal(); closeToolbar(); closePopover(); } });

/* ---------------- review ---------------- */
async function renderReview() {
  const v = $("#view");
  v.innerHTML = `<div class="empty">Loading review queue…</div>`;
  let q;
  try { q = await api("/api/review/queue?limit=200"); }
  catch (e) { v.innerHTML = `<div class="empty">Couldn't load review: ${esc(e.message)}</div>`; return; }
  state.reviewQueue = q.items; state.reviewIdx = 0;
  renderReviewCard(q.due);
  refreshSidebar();
}
function renderReviewCard(totalDue) {
  const v = $("#view");
  const q = state.reviewQueue, i = state.reviewIdx;
  if (i >= q.length) {
    v.innerHTML = `<div class="review-done">🎉 All caught up!<br>
      <span style="color:var(--muted);font-size:15px">Reviewed ${totalDue} highlight${totalDue === 1 ? "" : "s"}. New highlights become due tomorrow.</span></div>`;
    return;
  }
  const h = q[i];
  v.innerHTML = `<div id="review-wrap">
    <div class="review-count">Card ${i + 1} of ${q.length}${totalDue > q.length ? ` (${totalDue} due total)` : ""}</div>
    <div class="review-card">
      <blockquote>“${esc(h.text)}”</blockquote>
      ${h.note ? `<div class="note">📝 ${esc(h.note)}</div>` : ""}
      <div class="src">— ${esc(h.item_title)}${h.item_author ? ` · ${esc(h.item_author)}` : ""}</div>
    </div>
    <div class="grade-row">
      <button class="btn" data-g="again">Again <kbd>1</kbd></button>
      <button class="btn primary" data-g="good">Good <kbd>2</kbd></button>
      <button class="btn" data-g="easy">Easy <kbd>3</kbd></button>
    </div></div>`;
  $$(".grade-row .btn").forEach(b => b.addEventListener("click", () => grade(h, b.dataset.g, totalDue)));
}
async function grade(h, g, totalDue) {
  try { await api("/api/review/grade", {method: "POST", body: JSON.stringify({highlight_id: h.highlight_id, grade: g})}); }
  catch (e) { toast("Couldn't save grade: " + e.message); return; }
  state.reviewIdx++;
  renderReviewCard(totalDue);
}
document.addEventListener("keydown", e => {
  if (state.view !== "review") return;
  const q = state.reviewQueue, i = state.reviewIdx;
  if (i >= q.length) return;
  const map = {"1": "again", "2": "good", "3": "easy"};
  if (map[e.key] && !/INPUT|TEXTAREA/.test(document.activeElement.tagName))
    grade(q[i], map[e.key], q.length);
});

/* ---------------- import / export ---------------- */
function renderImport() {
  const v = $("#view");
  v.innerHTML = `<div class="view-head"><h2>⇅ Import / Export</h2></div>
  <div class="panel">
    <h3>📥 Import from Readwise</h3>
    <p>Bring your highlights over from Readwise (free to export, even on a trial):</p>
    <ol>
      <li>Go to <b>readwise.io</b> → your account → export your highlights as <b>CSV</b></li>
      <li>Choose the file below — OpenReader groups highlights back into their books/articles</li>
    </ol>
    <input type="file" id="rw-file" accept=".csv">
    <div class="row" style="margin-top:12px"><button class="btn primary" id="rw-go">Import CSV</button>
    <span id="rw-status" style="color:var(--muted);font-size:13px"></span></div>
  </div>
  <div class="panel">
    <h3>📤 Export your data</h3>
    <p>Your library is yours. Take it anywhere, anytime:</p>
    <div class="export-row">
      <a class="btn" href="/api/export?format=json" download>JSON (full backup)</a>
      <a class="btn" href="/api/export?format=csv" download>CSV (highlights)</a>
      <a class="btn" href="/api/export?format=markdown" download>Markdown</a>
    </div>
  </div>`;
  $("#rw-go").addEventListener("click", async () => {
    const f = $("#rw-file").files[0];
    if (!f) { toast("Choose a CSV file first."); return; }
    $("#rw-status").textContent = "Importing…";
    const fd = new FormData(); fd.append("file", f);
    try {
      const r = await fetch("/api/import/readwise", {method: "POST", body: fd});
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      const res = await r.json();
      $("#rw-status").textContent = `Imported ${res.items} items with ${res.highlights} highlights 🎉`;
      refreshSidebar();
    } catch (e) { $("#rw-status").textContent = "Import failed: " + e.message; }
  });
}

/* ---------------- top bar actions ---------------- */
$("#btn-save-url").addEventListener("click", () => {
  modal(`<h3>Save article from URL</h3>
    <input type="url" id="m-url" placeholder="https://example.com/article">
    <div class="row"><button class="btn" onclick="closeModal()">Cancel</button>
    <button class="btn primary" id="m-url-go">Save</button></div>`);
  $("#m-url").focus();
  const go = async () => {
    const url = $("#m-url").value.trim();
    if (!url) return;
    $("#m-url-go").disabled = true; $("#m-url-go").textContent = "Fetching…";
    try {
      const it = await api("/api/items/from-url", {method: "POST", body: JSON.stringify({url})});
      closeModal(); toast("Saved ✓"); refreshSidebar(); openReader(it.id);
    } catch (e) { $("#m-url-go").disabled = false; $("#m-url-go").textContent = "Save"; toast("Couldn't save: " + e.message); }
  };
  $("#m-url-go").addEventListener("click", go);
  $("#m-url").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
});
$("#btn-new-note").addEventListener("click", () => {
  modal(`<h3>New note</h3>
    <input type="text" id="m-note-title" placeholder="Title">
    <textarea id="m-note-body" placeholder="Write or paste…"></textarea>
    <input type="text" id="m-note-tags" placeholder="tags, comma separated">
    <div class="row"><button class="btn" onclick="closeModal()">Cancel</button>
    <button class="btn primary" id="m-note-go">Save note</button></div>`);
  $("#m-note-go").addEventListener("click", async () => {
    const title = $("#m-note-title").value.trim();
    if (!title) { toast("Give the note a title."); return; }
    const it = await api("/api/items", {method: "POST", body: JSON.stringify({
      title, content: $("#m-note-body").value,
      tags: $("#m-note-tags").value.split(",").map(s => s.trim()).filter(Boolean),
    })});
    closeModal(); toast("Note saved ✓"); refreshSidebar(); openReader(it.id);
  });
});
$("#btn-upload").addEventListener("click", () => $("#file-upload").click());
$("#btn-theme").addEventListener("click", toggleTheme);
$("#file-upload").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  toast("Uploading " + f.name + "…");
  const fd = new FormData(); fd.append("file", f);
  try {
    const r = await fetch("/api/items/upload", {method: "POST", body: fd});
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    const it = await r.json();
    toast("Uploaded ✓"); refreshSidebar(); openReader(it.id);
  } catch (err) { toast("Upload failed: " + err.message); }
  e.target.value = "";
});

/* ---------------- boot ---------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
let _theme = "dark";
try { _theme = localStorage.getItem("or-theme") || "dark"; } catch (e) {}
setTheme(_theme);
renderLibrary();
refreshSidebar();

/* ================= PDF reader (Readwise-style) ================= */
let pdfDoc = null, pdfScale = 1.6, pdfPageCount = 0;
let pdfPageData = {};   // n -> { items:[{el,str}], offsets:[], rendered:bool }
let pdfObserver = null, pdfScrollTimer = null, pdfCurrentPage = 1;

function pdfFileUrl(it) { return "/api/items/" + it.id + "/file"; }
function domainOf(it) {
  if (it.url) { try { return new URL(it.url).hostname.replace(/^www\./, ""); } catch (e) {} }
  return "Local upload";
}

async function renderPdfReader(it) {
  const v = $("#view");
  v.classList.add("pdf-mode");
  $("#topbar").style.display = "none";
  document.addEventListener("keydown", pdfKeyHandler);
  pdfDoc = null; pdfPageData = {}; pdfCurrentPage = 1;
  if (pdfObserver) { pdfObserver.disconnect(); pdfObserver = null; }

  v.innerHTML = `
  <div id="pdf-reader">
    <div id="pdf-topbar">
      <button class="ptb-btn" id="pdf-back" title="Back to library">←</button>
      <div class="pdf-title" title="${esc(it.title)}">${esc(it.title)}</div>
      <div class="pdf-zoom">
        <button class="ptb-btn" id="z-out" title="Zoom out">−</button>
        <span id="z-label">${Math.round(pdfScale * 100)}%</span>
        <button class="ptb-btn" id="z-in" title="Zoom in">+</button>
      </div>
      <div class="pdf-pagenav">
        <input id="page-jump" type="text" inputmode="numeric" value="1" title="Go to page">
        <span>of <span id="page-total">…</span></span>
      </div>
      <div class="pdf-menu-wrap">
        <button class="ptb-btn" id="pdf-menu-btn" title="Document menu">⋯</button>
        <div id="pdf-menu" class="hidden">
          <button data-act="tags">Add document tag <kbd>Shift T</kbd></button>
          <button data-act="note">Add document note <kbd>Shift N</kbd></button>
          <button data-act="meta">Edit metadata <kbd>Shift M</kbd></button>
          <button data-act="reset">Reset reading progress <kbd>Shift R</kbd></button>
          <button data-act="open">Open original <kbd>O</kbd></button>
          <button data-act="copy">Copy document URL <kbd>Shift C</kbd></button>
          <button data-act="download">Download original <kbd>Shift D</kbd></button>
          <button data-act="delete" class="danger">Delete document <kbd>D</kbd></button>
        </div>
      </div>
    </div>
    <div id="pdf-body">
      <aside id="pdf-toc"><div class="pdf-side-label">Contents</div><div id="toc-items"></div></aside>
      <div id="pdf-scroll">
        <div id="pdf-progress-card"><span id="ppc-label">Page <b>1</b></span><div class="ppc-bar"><i id="ppc-fill"></i></div><span class="ppc-pct" id="ppc-pct">0%</span></div>
        <div id="pdf-pages"></div>
      </div>
      <aside id="pdf-side">
        <div class="pdf-tabs">
          <button data-tab="info" class="active">Info</button>
          <button data-tab="notebook">Notebook <span id="nb-count" class="nb-badge"></span></button>
        </div>
        <div id="tab-info"></div>
        <div id="tab-notebook" class="hidden"></div>
      </aside>
    </div>
  </div>`;

  $("#pdf-back").addEventListener("click", () => { state.view = "library"; render(); });
  $("#z-in").addEventListener("click", () => setPdfZoom(pdfScale + 0.25));
  $("#z-out").addEventListener("click", () => setPdfZoom(pdfScale - 0.25));
  $("#page-jump").addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const n = parseInt($("#page-jump").value, 10);
      if (n >= 1 && n <= pdfPageCount) scrollToPdfPage(n);
    }
  });
  $("#pdf-menu-btn").addEventListener("click", e => {
    e.stopPropagation();
    $("#pdf-menu").classList.toggle("hidden");
  });
  $$("#pdf-menu button").forEach(b => b.addEventListener("click", ev => {
    ev.stopPropagation();
    pdfMenuAction(b.dataset.act);
  }));
  $$(".pdf-tabs button").forEach(b => b.addEventListener("click", () => {
    $$(".pdf-tabs button").forEach(x => x.classList.toggle("active", x === b));
    $("#tab-info").classList.toggle("hidden", b.dataset.tab !== "info");
    $("#tab-notebook").classList.toggle("hidden", b.dataset.tab !== "notebook");
  }));
  $("#pdf-scroll").addEventListener("scroll", trackPdfProgress);
  $("#pdf-scroll").addEventListener("mouseup", onPdfSelect);

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument(pdfFileUrl(it)).promise;
  } catch (e) {
    $("#pdf-pages").innerHTML = `<div class="empty">Couldn't render this PDF.<br>Try downloading the original from the ⋯ menu.</div>`;
    return;
  }
  pdfDoc = pdf; pdfPageCount = pdf.numPages;
  $("#page-total").textContent = pdfPageCount;
  buildPdfPageShells();
  buildPdfOutline();
  buildInfoTab(it);
  buildNotebookTab(it);
  const startPage = Math.min(pdfPageCount, Math.max(1, Math.round((it.read_progress || 0) * pdfPageCount)));
  const pc0 = $("#ppc-label");
  if (pc0) pc0.innerHTML = `Page <b>${startPage}</b> of ${pdfPageCount}`;
  const pp0 = $("#ppc-pct");
  if (pp0) pp0.textContent = Math.round((it.read_progress || 0) * 100) + "%";
  const pf0 = $("#ppc-fill");
  if (pf0) pf0.style.width = ((it.read_progress || 0) * 100) + "%";
  setTimeout(() => scrollToPdfPage(startPage, true), 120);
}

function buildPdfPageShells() {
  if (pdfObserver) { pdfObserver.disconnect(); pdfObserver = null; }
  const holder = $("#pdf-pages");
  holder.innerHTML = "";
  pdfPageData = {};
  for (let n = 1; n <= pdfPageCount; n++) {
    pdfPageData[n] = { rendered: false };
    const w = document.createElement("div");
    w.className = "pdf-page"; w.dataset.page = n;
    w.innerHTML = `<div class="pdf-page-label">Page ${n}</div>
      <div class="pdf-canvas-wrap"><canvas></canvas><div class="pdf-text-layer"></div></div>`;
    holder.appendChild(w);
  }
  pdfObserver = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        const n = parseInt(en.target.dataset.page, 10);
        pdfObserver.unobserve(en.target);
        renderPdfPage(n);
      }
    });
  }, { root: $("#pdf-scroll"), rootMargin: "900px" });
  $$(".pdf-page", holder).forEach(p => pdfObserver.observe(p));
}

async function renderPdfPage(n) {
  const d = pdfPageData[n];
  if (!d || d.rendered || !pdfDoc) return;
  d.rendered = true;
  try {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale: pdfScale });
    const wrap = document.querySelector(`.pdf-page[data-page="${n}"]`);
    if (!wrap) return;
    const canvas = wrap.querySelector("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const tc = await page.getTextContent();
    buildTextLayer(n, tc.items, viewport);
    renderPdfHighlightsForPage(n);
    if (page.cleanup) page.cleanup();
  } catch (e) { d.rendered = false; console.warn("OpenReader: page render failed", n, e); }
}

function buildTextLayer(n, items, viewport) {
  const layer = document.querySelector(`.pdf-page[data-page="${n}"] .pdf-text-layer`);
  if (!layer) return;
  layer.style.width = viewport.width + "px";
  layer.style.height = viewport.height + "px";
  const spans = [], offsets = [];
  let acc = 0;
  items.forEach(item => {
    if (!item.str) return;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontH = Math.hypot(tx[2], tx[3]) || 10;
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = tx[4] + "px";
    span.style.top = (tx[5] - fontH) + "px";
    span.style.fontSize = fontH + "px";
    layer.appendChild(span);
    offsets.push(acc); acc += item.str.length;
    spans.push({ el: span, str: item.str });
  });
  Object.assign(pdfPageData[n], { items: spans, offsets });
}

function setPdfZoom(s) {
  pdfScale = Math.min(3, Math.max(0.6, Math.round(s * 4) / 4));
  const z = $("#z-label");
  if (z) z.textContent = Math.round(pdfScale * 100) + "%";
  const cur = pdfCurrentPage;
  buildPdfPageShells();
  setTimeout(() => scrollToPdfPage(cur, true), 60);
}

function scrollToPdfPage(n, instant) {
  const el = document.querySelector(`.pdf-page[data-page="${n}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "start" });
  const jump = $("#page-jump");
  if (jump) jump.value = n;
  pdfCurrentPage = n;
}

async function buildPdfOutline() {
  const toc = $("#toc-items");
  let outline = null;
  try { outline = await pdfDoc.getOutline(); } catch (e) {}
  if (!outline || !outline.length) {
    toc.innerHTML = '<div class="toc-empty">No table of contents in this PDF.</div>';
    return;
  }
  const build = (items, depth) => {
    const ul = document.createElement("ul");
    items.forEach(item => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = item.title;
      a.title = item.title;
      a.style.paddingLeft = (8 + depth * 14) + "px";
      a.addEventListener("click", async () => {
        try {
          const dest = await pdfDoc.getDestination(item.dest);
          if (!dest) return;
          const idx = await pdfDoc.getPageIndex(dest[0]);
          scrollToPdfPage(idx + 1);
        } catch (e) {}
      });
      li.appendChild(a);
      if (item.items && item.items.length) li.appendChild(build(item.items, depth + 1));
      ul.appendChild(li);
    });
    return ul;
  };
  toc.innerHTML = "";
  toc.appendChild(build(outline, 0));
}

function buildInfoTab(it) {
  const mins = Math.max(1, Math.round((it.word_count || 0) / 200));
  const saved = it.created_at ? new Date(it.created_at).toLocaleDateString() : "—";
  const pct = Math.round((it.read_progress || 0) * 100);
  $("#tab-info").innerHTML = `
    <h3>${esc(it.title)}</h3>
    <div class="info-domain">${esc(domainOf(it))}</div>
    ${it.author ? `<div class="info-authors">👤 ${esc(it.author)}</div>` : ""}
    <div class="info-label">SUMMARY</div>
    <p class="info-summary">${esc(it.excerpt || "No summary available.")}</p>
    <div class="info-label">METADATA</div>
    <div class="info-rows">
      <div><span>Type</span><b>PDF</b></div>
      <div><span>Domain</span><b>${esc(domainOf(it))}</b></div>
      <div><span>Length</span><b>${mins} min (${(it.word_count || 0).toLocaleString()} words)</b></div>
      <div><span>Saved</span><b>${esc(saved)}</b></div>
      <div><span>Progress</span><b id="info-progress">${pct}%</b></div>
    </div>
    ${it.note ? `<div class="info-label">DOCUMENT NOTE</div><p class="info-summary">${esc(it.note)}</p>` : ""}`;
}

function buildNotebookTab(it) {
  const nb = $("#tab-notebook");
  if (!nb) return;
  const hls = it.highlights || [];
  const badge = $("#nb-count");
  if (badge) badge.textContent = hls.length || "";
  nb.innerHTML = hls.length ? "" :
    '<div class="nb-empty">No highlights yet.<br>Select text in the document to highlight it.</div>';
  hls.forEach(hl => {
    const div = document.createElement("div");
    div.className = "nb-item";
    div.innerHTML = `<span class="nb-text hl-${hl.color || "yellow"}">${esc(hl.text)}</span>
      ${hl.note ? `<div class="nb-note">📝 ${esc(hl.note)}</div>` : ""}
      <div class="nb-meta">p. ${esc(hl.location || "?")}</div>`;
    div.addEventListener("click", () => {
      scrollToPdfPage(parseInt(hl.location, 10) || 1);
      setTimeout(() => flashHighlight(hl.id), 450);
    });
    nb.appendChild(div);
  });
}

function flashHighlight(id) {
  document.querySelectorAll(`mark[data-id="${id}"]`).forEach(m => {
    m.classList.add("flash");
    setTimeout(() => m.classList.remove("flash"), 1600);
  });
}

/* --- PDF text selection & highlights --- */
function closestPageEl(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return el ? el.closest(".pdf-page") : null;
}
function insideMark(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return el ? !!el.closest("mark") : false;
}
function spanCharOffset(span, node, off) {
  let acc = 0;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const tn = walker.currentNode;
    if (tn === node) return acc + Math.min(off, tn.nodeValue.length);
    acc += tn.nodeValue.length;
  }
  return -1;
}
function pdfCharOffset(d, node, off) {
  const el = node.nodeType === 3 ? node.parentElement : node;
  if (!el) return -1;
  const span = el.closest(".pdf-text-layer > span");
  if (!span) return -1;
  const idx = d.items.findIndex(s => s.el === span);
  if (idx < 0) return -1;
  const inner = spanCharOffset(span, node, off);
  return inner < 0 ? -1 : d.offsets[idx] + inner;
}
function textNodeAt(span, target) {
  let acc = 0;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const tn = walker.currentNode;
    if (target <= acc + tn.nodeValue.length)
      return { node: tn, off: Math.min(target - acc, tn.nodeValue.length) };
    acc += tn.nodeValue.length;
  }
  return null;
}

function onPdfSelect() {
  const sel = window.getSelection();
  closeToolbar();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const pageEl = closestPageEl(range.commonAncestorContainer);
  if (!pageEl || !$("#pdf-pages").contains(pageEl)) return;
  if (insideMark(range.startContainer) || insideMark(range.endContainer)) return;
  const n = parseInt(pageEl.dataset.page, 10);
  const d = pdfPageData[n];
  if (!d || !d.items) return;
  const start = pdfCharOffset(d, range.startContainer, range.startOffset);
  const end = pdfCharOffset(d, range.endContainer, range.endOffset);
  if (start < 0 || end <= start) return;
  const full = d.items.map(s => s.str).join("");
  const text = full.slice(start, end);
  if (text.trim().length < 3) return;
  const rect = range.getBoundingClientRect();
  const tb = document.createElement("div");
  tb.id = "hl-toolbar";
  tb.innerHTML = COLORS.map(c => `<div class="dot ${c}" data-c="${c}" title="${c}"></div>`).join("");
  tb.style.left = Math.min(window.innerWidth - 220, Math.max(8, rect.left + rect.width / 2 - 100)) + "px";
  tb.style.top = (rect.top - 52 > 8 ? rect.top - 52 : rect.bottom + 10) + "px";
  tb.addEventListener("mousedown", ev => ev.preventDefault());
  tb.addEventListener("click", ev => {
    const dot = ev.target.closest(".dot");
    if (!dot) return;
    ev.stopPropagation();
    savePdfHighlight(n, { text, start, end,
      prefix: full.slice(Math.max(0, start - 48), start),
      suffix: full.slice(end, end + 48) }, dot.dataset.c, rect);
  });
  document.body.appendChild(tb);
}

async function savePdfHighlight(n, sel, color, rect) {
  const it = state.item;
  closeToolbar();
  try {
    const hl = await api(`/api/items/${it.id}/highlights`, {
      method: "POST",
      body: JSON.stringify({ text: sel.text, prefix: sel.prefix, suffix: sel.suffix,
                             color, location: String(n) }),
    });
    window.getSelection().removeAllRanges();
    wrapPdfRange(n, sel.start, sel.end, hl);
    it.highlights = (it.highlights || []).concat([hl]);
    buildNotebookTab(it);
    refreshSidebar();
    openPopover(hl, rect.left + rect.width / 2, rect.top);
    toast("Highlighted 🖍 — add a note if you like");
  } catch (e) { toast("Highlight failed: " + e.message); }
}

function wrapPdfRange(n, start, end, hl) {
  const d = pdfPageData[n];
  if (!d || !d.items) return;
  for (let i = 0; i < d.items.length; i++) {
    const iStart = d.offsets[i], iEnd = iStart + d.items[i].str.length;
    if (iEnd <= start || iStart >= end || !d.items[i].str.length) continue;
    const s = Math.max(0, start - iStart);
    const e = Math.min(d.items[i].str.length, end - iStart);
    if (e <= s) continue;
    const span = d.items[i].el;
    const sn = textNodeAt(span, s), en = textNodeAt(span, e);
    if (!sn || !en) continue;
    if (sn.node.parentElement.closest("mark") || en.node.parentElement.closest("mark")) continue;
    try {
      const range = document.createRange();
      range.setStart(sn.node, sn.off);
      range.setEnd(en.node, en.off);
      const mark = document.createElement("mark");
      mark.className = "hl-" + (hl.color || "yellow");
      mark.dataset.id = hl.id;
      mark.dataset.page = n;
      mark.addEventListener("click", ev => { ev.stopPropagation(); openPopover(hl, ev.clientX, ev.clientY); });
      range.surroundContents(mark);
    } catch (err) { /* skip un-wrappable piece */ }
  }
}

function renderPdfHighlightsForPage(n) {
  const d = pdfPageData[n];
  if (!d || !d.items || !d.items.length) return;
  const full = d.items.map(s => s.str).join("");
  (state.item.highlights || [])
    .filter(h => String(h.location) === String(n))
    .sort((a, b) => b.text.length - a.text.length)
    .forEach(hl => {
      const ix = findBest(full, hl.text, hl.prefix, hl.suffix);
      if (ix >= 0) wrapPdfRange(n, ix, ix + hl.text.length, hl);
    });
}

/* --- PDF progress --- */
function trackPdfProgress() {
  const scroller = $("#pdf-scroll");
  if (!scroller || !pdfPageCount) return;
  clearTimeout(pdfScrollTimer);
  pdfScrollTimer = setTimeout(() => {
    const sr = scroller.getBoundingClientRect();
    let cur = 1;
    $$(".pdf-page").forEach(p => {
      if (p.getBoundingClientRect().top - sr.top <= 140) cur = parseInt(p.dataset.page, 10);
    });
    pdfCurrentPage = cur;
    const jump = $("#page-jump");
    if (jump && document.activeElement !== jump) jump.value = cur;
    const it = state.item;
    if (!it) return;
    const prog = cur / pdfPageCount;
    const pc = $("#ppc-label"), pf = $("#ppc-fill"), pp = $("#ppc-pct");
    if (pc) pc.innerHTML = `Page <b>${cur}</b> of ${pdfPageCount}`;
    if (pf) pf.style.width = (prog * 100) + "%";
    if (pp) pp.textContent = Math.round(prog * 100) + "%";
    if (Math.abs(prog - (it.read_progress || 0)) > 0.02) {
      it.read_progress = prog;
      api("/api/items/" + it.id, { method: "PATCH", body: JSON.stringify({ read_progress: prog }) }).catch(() => {});
      const ip = $("#info-progress");
      if (ip) ip.textContent = Math.round(prog * 100) + "%";
    }
  }, 800);
}

/* --- PDF menu actions & shortcuts --- */
async function pdfMenuAction(act) {
  const it = state.item;
  const menu = $("#pdf-menu");
  if (menu) menu.classList.add("hidden");
  if (act === "tags") {
    modal(`<h3>Tags</h3><input type="text" id="m-tags" value="${esc((it.tags || []).join(", "))}" placeholder="comma, separated, tags"><div class="row"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="m-tags-save">Save</button></div>`);
    $("#m-tags-save").addEventListener("click", async () => {
      const tags = $("#m-tags").value.split(",").map(s => s.trim()).filter(Boolean);
      const u = await api("/api/items/" + it.id, { method: "PATCH", body: JSON.stringify({ tags }) });
      it.tags = u.tags; closeModal(); toast("Tags saved"); refreshSidebar();
    });
  } else if (act === "note") {
    modal(`<h3>Document note</h3><textarea id="m-note" placeholder="Notes about this document…">${esc(it.note || "")}</textarea><div class="row"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="m-note-save">Save</button></div>`);
    $("#m-note-save").addEventListener("click", async () => {
      const u = await api("/api/items/" + it.id, { method: "PATCH", body: JSON.stringify({ note: $("#m-note").value }) });
      it.note = u.note; closeModal(); buildInfoTab(it); toast("Note saved");
    });
  } else if (act === "meta") {
    modal(`<h3>Edit metadata</h3><input type="text" id="m-title" value="${esc(it.title)}" placeholder="Title"><input type="text" id="m-author" value="${esc(it.author || "")}" placeholder="Author"><div class="row"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="m-meta-save">Save</button></div>`);
    $("#m-meta-save").addEventListener("click", async () => {
      const u = await api("/api/items/" + it.id, { method: "PATCH", body: JSON.stringify({ title: $("#m-title").value, author: $("#m-author").value }) });
      Object.assign(it, u); closeModal();
      const t = document.querySelector(".pdf-title");
      if (t) t.textContent = it.title;
      buildInfoTab(it); toast("Saved");
    });
  } else if (act === "reset") {
    await api("/api/items/" + it.id, { method: "PATCH", body: JSON.stringify({ read_progress: 0 }) });
    it.read_progress = 0; scrollToPdfPage(1); buildInfoTab(it); toast("Progress reset");
  } else if (act === "open") {
    window.open(pdfFileUrl(it), "_blank");
  } else if (act === "copy") {
    try { await navigator.clipboard.writeText(location.origin + pdfFileUrl(it)); toast("Link copied"); }
    catch (e) { toast("Copy failed"); }
  } else if (act === "download") {
    const a = document.createElement("a");
    a.href = pdfFileUrl(it);
    a.download = (it.title || "document").replace(/[^\w\- ]+/g, "") + ".pdf";
    document.body.appendChild(a); a.click(); a.remove();
  } else if (act === "delete") {
    if (!confirm("Delete this document and its highlights?")) return;
    await api("/api/items/" + it.id, { method: "DELETE" });
    toast("Deleted"); refreshSidebar(); state.view = "library"; render();
  }
}

function pdfKeyHandler(e) {
  if (!$("#pdf-reader")) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.shiftKey) {
    const map = { t: "tags", n: "note", m: "meta", r: "reset", c: "copy", d: "download" };
    if (map[k]) { e.preventDefault(); pdfMenuAction(map[k]); }
  } else if (k === "o") {
    pdfMenuAction("open");
  } else if (k === "d") {
    pdfMenuAction("delete");
  }
}
