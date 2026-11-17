/* Time-range control shared by the tables view (/) and the graph view (/graph).

   Pick a range of emissions and both views mark what it touched, the way they mark live
   arrivals: the same entities, the same per-kind "+N", the same "new" vs "updated".
   It highlights the *current* folded state; it does not rewind it (`sl read --as-of` could
   do that later, with sl still doing the folding).

   - Facts are ordered by event time (ts), then arrival (seq). The range is two endpoint
     seqs on that order, so membership is exact even when timestamps tie, and a fact that
     `loops sync` inserts late still lands at its event time.
   - The range lives in the query string (?from=&to=&by=), so it survives entity links
     (which use the hash) and the Tables <-> Graph switch. No `to` means "up to now":
     it grows as live emissions land. A fixed `to` stays fixed.
   - `by` narrows to one observer (a session), since sessions interleave in time.
   - Play replays the range: a playhead walks its emissions in order and the summary covers
     only what has played so far, so both views fill in the way they would have live. Each step
     also hands the page the full fact (onStep), which runs it through its live-arrival path.
     Quiet gaps are compressed (square root of the gap, capped). Entities first emitted after
     the playhead are reported absent (existsAt), so they appear when first emitted; fields still
     show current values, which the control says. While playing the index is frozen: pages hold
     live facts back (inPlay) and apply them once play ends.

   Exposes window.Timeline. No dependencies; styles use the host page's tokens. */
"use strict";

window.Timeline = (() => {
  /* ---------- Which entities an emission touches (one rule for live and ranges) ---------- */

  // An emission touches its own entity, and the entity its `touch` field names: the config's
  // `touches` maps a kind to that field (e.g. a reachability verdict also shows on its finding).
  // The field holds a reference ("kind:key"), the same form sl edges use.
  let touches = {};
  function setTouches(map) { touches = map ?? {}; }
  function touchedBy(e) {
    const out = [e.kind + "/" + e.name];
    if (e.touch) out.push(e.touch.replace(":", "/"));
    return out;
  }
  const entryOf = (f) => ({
    seq: f.seq, ts: f.ts, kind: f.kind, name: f.payload?.name ?? f.id, observer: f.observer ?? "",
    touch: touches[f.kind] ? f.payload?.[touches[f.kind]] ?? null : null,
  });
  const fromRow = ([seq, ts, kind, name, observer, touch]) => ({ seq, ts, kind, name, observer: observer ?? "", touch });

  /* ---------- Range in the URL ---------- */

  function readRange() {
    const q = new URLSearchParams(location.search);
    const num = (k) => (q.has(k) && /^\d+$/.test(q.get(k)) ? Number(q.get(k)) : null);
    return { from: num("from"), to: num("to"), by: q.get("by") || null };
  }
  function writeRange(r) {
    const q = new URLSearchParams(location.search);
    for (const k of ["from", "to", "by"]) q.delete(k);
    if (r.from != null) q.set("from", r.from);
    if (r.from != null && r.to != null) q.set("to", r.to);
    if (r.by) q.set("by", r.by);
    const s = q.toString();
    history.replaceState(history.state, "", location.pathname + (s ? "?" + s : "") + location.hash);
  }

  /* ---------- Formatting ---------- */

  const dtf = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const dayf = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
  const when = (ts) => dtf.format(new Date(ts * 1000));
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
  // "Nov 16", "Nov 16–17", or "Aug 13–Nov 16".
  function daySpan(t0, t1) {
    const a = new Date(t0 * 1000), b = new Date(t1 * 1000);
    if (dayf.format(a) === dayf.format(b)) return dayf.format(a);
    return dayf.format(a) + "–" + (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() ? b.getDate() : dayf.format(b));
  }
  const shortObserver = (o) => o.replace(/^[^/]+\//, "") || "(no observer)";

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "class") n.className = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  }

  const CSS = `
.tl { display: grid; gap: 6px; font-size: 12.5px; color: var(--ink); }
.tl-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.tl-row .tl-title { font-weight: 600; margin-inline-end: 4px; }
.tl button, .tl select {
  font: inherit; color: var(--ink-2); background: transparent; cursor: pointer;
  border: 1px solid var(--line); border-radius: 7px; padding: 3px 9px;
}
.tl button:hover, .tl select:hover { color: var(--ink); }
.tl button[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
.tl select { max-width: 34ch; }
.tl-sum { color: var(--ink-2); font-variant-numeric: tabular-nums; }
.tl-sum b { color: var(--ink); }
.tl-hist { display: block; width: 100%; height: 44px; cursor: crosshair; touch-action: none; }
.tl-read { min-height: 1.4em; color: var(--ink-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.tl-sliders { display: grid; grid-template-columns: auto 1fr minmax(13ch, auto); gap: 2px 10px; align-items: center; }
.tl-sliders label { color: var(--ink-2); }
.tl-sliders input { width: 100%; margin: 0; accent-color: var(--accent); }
.tl-sliders output { color: var(--ink-2); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tl-clear { margin-inline-start: auto; }
.tl-play { display: grid; grid-template-columns: auto auto minmax(0, 1fr) minmax(13ch, auto) auto; gap: 4px 8px; align-items: center; }
.tl-play[hidden] { display: none; }
.tl-play input { width: 100%; margin: 0; accent-color: var(--ink-2); }
.tl-play output { color: var(--ink-2); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tl-play .tl-note { grid-column: 1 / -1; color: var(--ink-3); font-size: 11.5px; }
.tl-play .tl-note[hidden] { display: none; }
@media (width < 560px) { .tl-play { grid-template-columns: auto auto minmax(0, 1fr) auto; } .tl-play output { display: none; } }
`;

  /* ---------- The control ---------- */

  function create({ mount, onChange, onStep = () => {} }) {
    if (!document.getElementById("timeline-css")) document.head.append(el("style", { id: "timeline-css" }, CSS));
    let order = [];                 // entries in time order
    let pos = new Map();            // seq -> index in order
    let firstPos = new Map();       // address -> index of the entity's first-ever emission
    let range = readRange();
    let summary = null;
    let layout = null;              // histogram geometry, rebuilt on resize / data change
    let pending = 0;
    let play = null;                // { list, k, head, playing, timer, chunks } while replaying the range
    let speed = 1;

    const fromIn = el("input", { type: "range", id: "tl-from", min: 0, max: 0, step: 1, value: 0 });
    const toIn = el("input", { type: "range", id: "tl-to", min: 0, max: 0, step: 1, value: 0 });
    const fromOut = el("output", { for: "tl-from" });
    const toOut = el("output", { for: "tl-to" });
    const sum = el("span", { class: "tl-sum" });
    const read = el("div", { class: "tl-read" });
    const canvas = el("canvas", { class: "tl-hist", "aria-hidden": "true" });
    const session = el("select", { "aria-label": "Session (observer)" });
    const PRESETS = [["Last hour", 3600], ["Today", "today"], ["24 hours", 86400], ["7 days", 7 * 86400]];
    const presetBtns = PRESETS.map(([label, span]) => el("button", { type: "button", "aria-pressed": "false", onclick: () => preset(span) }, label));
    const clearBtn = el("button", { type: "button", class: "tl-clear", onclick: clear }, "Clear range");
    const playBtn = el("button", { type: "button", onclick: () => toggle() }, "Play");
    const speedSel = el("select", { "aria-label": "Playback speed" },
      ...[0.5, 1, 2, 4].map((v) => el("option", { value: v, selected: v === 1 }, `${v}×`)));
    const headIn = el("input", { type: "range", id: "tl-head", min: 0, max: 0, step: 1, value: 0, "aria-label": "Playhead" });
    const headOut = el("output", { for: "tl-head" });
    const doneBtn = el("button", { type: "button", onclick: () => stopPlay() }, "Done");
    const note = el("span", { class: "tl-note" }, "Replaying: entities appear when first emitted; their fields show current values.");
    const playRow = el("div", { class: "tl-play", hidden: true }, playBtn, speedSel, headIn, headOut, doneBtn, note);

    mount.replaceChildren(el("section", { class: "tl", "aria-label": "Time range" },
      el("div", { class: "tl-row" }, el("span", { class: "tl-title" }, "Changes in"), ...presetBtns, session, clearBtn),
      el("div", { class: "tl-row" }, sum),
      canvas, read,
      el("div", { class: "tl-sliders" },
        el("label", { for: "tl-from" }, "From"), fromIn, fromOut,
        el("label", { for: "tl-to" }, "To"), toIn, toOut),
      playRow,
    ));

    /* --- data --- */
    function setIndex(rows) { order = rows.map(fromRow); reindex(); }
    function addFacts(facts) {
      const before = order.length;
      for (const f of facts) if (!pos.has(f.seq)) order.push(entryOf(f));
      if (order.length === before) return;
      order.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
      reindex();
    }
    function reindex() {
      pos = new Map(order.map((e, i) => [e.seq, i]));
      firstPos = new Map();
      order.forEach((e, i) => { const a = e.kind + "/" + e.name; if (!firstPos.has(a)) firstPos.set(a, i); });
      fromIn.max = toIn.max = Math.max(0, order.length - 1);
      renderSessions();
      layout = null;
      if (play) setK(play.k);       // positions moved; the playhead stays on the same emission
      apply({ write: false });
    }

    /* --- range math --- */
    const active = () => range.from != null || !!range.by;
    function bounds() {
      const last = order.length - 1;
      let i0 = range.from != null && pos.has(range.from) ? pos.get(range.from) : 0;
      let i1 = range.to != null && pos.has(range.to) ? pos.get(range.to) : last;
      if (range.by && range.from == null) {        // session only: from its first emission, following live
        const first = order.findIndex((e) => e.observer === range.by);
        if (first >= 0) i0 = first;
      }
      return [Math.max(0, i0), Math.max(0, Math.min(last, i1))];
    }
    function compute() {
      if (!active() || !order.length) return { active: false };
      const [i0, i1] = bounds();
      const hi = play ? play.head : i1;
      const facts = [], touched = new Map(), perKind = new Map();
      for (let i = i0; i <= hi; i++) {
        const e = order[i];
        if (range.by && e.observer !== range.by) continue;
        facts.push(e);
        perKind.set(e.kind, (perKind.get(e.kind) || 0) + 1);
        touchedBy(e).forEach((a, j) => {
          const t = touched.get(a) ?? { n: 0, isNew: false, kind: a.slice(0, a.indexOf("/")), last: 0 };
          t.n++; t.last = Math.max(t.last, e.seq);
          if (j === 0 && firstPos.get(a) === i) t.isNew = true;       // its first-ever emission is in range
          touched.set(a, t);
        });
      }
      return {
        active: true, i0, i1, hi, facts, touched, perKind,
        newCount: [...touched.values()].filter((t) => t.isNew).length,
        fromTs: order[i0]?.ts, toTs: order[i1]?.ts, live: range.to == null, by: range.by,
        play: play ? { k: play.k, n: play.list.length } : null,
      };
    }

    /* --- applying a change --- */
    // cause: "range" (the range changed), "seek" (playhead moved by hand), "step" (play advanced).
    function apply({ write = true, cause = "range" } = {}) {
      if (write) writeRange(range);
      summary = compute();
      summary.cause = cause;
      render();
      if (!pending) pending = requestAnimationFrame(() => { pending = 0; onChange(summary); });
    }
    function setRange(r) { endPlay(); range = { from: null, to: null, by: null, ...r }; apply(); }
    function clear() { setRange({}); }
    function preset(span) {
      const now = Date.now() / 1000;
      const cutoff = span === "today" ? new Date().setHours(0, 0, 0, 0) / 1000 : now - span;
      const i = order.findIndex((e) => e.ts >= cutoff);
      if (i < 0) { read.textContent = "No emissions in that period."; return; }
      setRange({ from: order[i].seq, by: range.by });
    }

    /* --- play: replay the range's emissions in order --- */
    const CHUNK = 60;
    // Square root of the quiet gap, so a burst ticks along and an overnight pause is a beat, not a wait.
    const delayFor = (gapS) => Math.min(1500, Math.max(120, Math.sqrt(Math.max(0, gapS)) * 25)) / speed;
    function setK(k) {
      play.k = k;
      play.head = k >= 0 ? pos.get(play.list[k].seq) : bounds()[0] - 1;
    }
    function startPlay() {
      endPlay();
      if (!active()) return;
      const list = compute().facts;
      if (!list.length) return;
      play = { list, k: -1, head: -1, playing: false, timer: 0, chunks: new Map() };
      setK(-1);
      apply({ write: false, cause: "seek" });
    }
    function chunk(p, c) {           // full facts for list[c*CHUNK ..], fetched once per play
      if (!p.chunks.has(c)) {
        const seqs = p.list.slice(c * CHUNK, (c + 1) * CHUNK).map((e) => e.seq);
        p.chunks.set(c, !seqs.length ? Promise.resolve(new Map()) : fetch("/api/facts?seqs=" + seqs.join(","))
          .then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || r.statusText); return new Map(b.facts.map((f) => [f.seq, f])); })));
      }
      return p.chunks.get(c);
    }
    async function step() {
      const p = play;
      if (!p?.playing) return;
      const k = p.k + 1;
      if (k >= p.list.length) { p.playing = false; renderPlay(); return; }
      let facts;
      try { facts = await chunk(p, Math.floor(k / CHUNK)); }
      catch (err) { p.chunks.delete(Math.floor(k / CHUNK)); p.playing = false; renderPlay(); read.textContent = "Replay paused: " + err.message; return; }
      if (play !== p || !p.playing || p.k !== k - 1) return;      // stopped, paused or moved while fetching
      chunk(p, Math.floor(k / CHUNK) + 1).catch(() => {});        // the next page, ahead of need
      setK(k);
      apply({ write: false, cause: "step" });
      const f = facts.get(p.list[k].seq);
      if (f) onStep(f, summary);
      const next = p.list[k + 1];
      if (next) p.timer = setTimeout(step, delayFor(next.ts - p.list[k].ts));
      else { p.playing = false; renderPlay(); }
    }
    function toggle() {
      if (!play) startPlay();
      if (!play) return;
      if (play.playing) { play.playing = false; clearTimeout(play.timer); renderPlay(); return; }
      if (play.k >= play.list.length - 1) { setK(-1); apply({ write: false, cause: "seek" }); }   // at the end: replay
      play.playing = true; renderPlay();
      step();
    }
    function seek(k) {
      if (!play) startPlay();
      if (!play) return;
      clearTimeout(play.timer); play.playing = false;
      setK(Math.max(-1, Math.min(play.list.length - 1, k)));
      apply({ write: false, cause: "seek" });
    }
    function endPlay() { if (play) { clearTimeout(play.timer); play = null; } }
    function stopPlay() { if (!play) return; endPlay(); apply({ write: false }); }
    // Index in the play list of the last emission at or before order index i.
    function kAt(i) {
      const l = play.list;
      let lo = -1, hi = l.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pos.get(l[m].seq) <= i) lo = m; else hi = m - 1; }
      return lo;
    }
    function renderPlay() {
      const s = summary;
      playRow.hidden = !s?.active;
      if (!s?.active) return;
      const n = play ? play.list.length : s.facts.length, k = play ? play.k : n - 1;
      playBtn.textContent = play?.playing ? "Pause" : play && k >= n - 1 ? "Replay" : "Play";
      playBtn.disabled = !n;
      headIn.max = n; headIn.value = k + 1;
      const at = k >= 0 && (play ? play.list[k] : s.facts[k]);
      const text = !play ? "not playing" : at ? `${when(at.ts)}` : "start";
      headOut.textContent = text;
      headIn.setAttribute("aria-valuetext", `${(k + 1).toLocaleString()} of ${plural(n, "emission")} played${at ? ", " + when(at.ts) : ""}`);
      doneBtn.hidden = note.hidden = !play;
    }
    speedSel.addEventListener("change", () => { speed = Number(speedSel.value); });
    headIn.addEventListener("input", () => seek(Number(headIn.value) - 1));
    // Space plays and pauses while the time range is open, with focus on the page itself or on the
    // time range's own text, never on a control or a scroll region that uses Space itself.
    document.addEventListener("keydown", (e) => {
      if (e.key !== " " || e.repeat || e.defaultPrevented || mount.hidden || !summary?.active) return;
      const t = e.target;
      if (!(t === document.body || t === document.documentElement || mount.contains(t))) return;
      if (t.closest?.("input, select, textarea, button, a, [contenteditable]")) return;
      e.preventDefault();
      toggle();
    });

    /* --- controls --- */
    function renderSessions() {
      const by = new Map();
      for (const e of order) {
        const s = by.get(e.observer) ?? { n: 0, t0: e.ts, t1: e.ts };
        s.n++; s.t1 = e.ts; by.set(e.observer, s);
      }
      const list = [...by.entries()].sort((a, b) => b[1].t1 - a[1].t1);
      session.replaceChildren(el("option", { value: "" }, "Any session"),
        ...list.map(([o, s]) => el("option", { value: o }, `${shortObserver(o)} · ${s.n} · ${daySpan(s.t0, s.t1)}`)));
      session.value = range.by ?? "";
    }
    session.addEventListener("change", () => setRange({ by: session.value || null }));
    function onSlide(which) {
      let a = +fromIn.value, b = +toIn.value;
      if (a > b) { if (which === "from") b = a; else a = b; }
      const last = order.length - 1;
      setRange({ from: order[a].seq, to: b >= last ? null : order[b].seq, by: range.by });
    }
    fromIn.addEventListener("input", () => onSlide("from"));
    toIn.addEventListener("input", () => onSlide("to"));

    function render() {
      const s = summary;
      const [i0, i1] = s?.active ? [s.i0, s.i1] : [0, Math.max(0, order.length - 1)];
      fromIn.value = i0; toIn.value = i1;
      const fromText = order[i0] ? when(order[i0].ts) : "—";
      const toText = !s?.active || s.live ? "now (follows live)" : order[i1] ? when(order[i1].ts) : "—";
      fromOut.textContent = fromText; toOut.textContent = toText;
      fromIn.setAttribute("aria-valuetext", `${fromText}, emission ${i0 + 1} of ${order.length}`);
      toIn.setAttribute("aria-valuetext", `${toText}, emission ${i1 + 1} of ${order.length}`);
      clearBtn.disabled = !s?.active;
      session.value = range.by ?? "";
      const now = Date.now() / 1000;
      for (const [b, [, span]] of presetBtns.map((b, i) => [b, PRESETS[i]])) {
        const cutoff = span === "today" ? new Date().setHours(0, 0, 0, 0) / 1000 : now - span;
        const i = order.findIndex((e) => e.ts >= cutoff);
        b.setAttribute("aria-pressed", String(!!s?.active && s.live && i >= 0 && order[i].seq === range.from));
      }
      if (!s?.active) sum.replaceChildren("Pick a period or session to mark what it changed.");
      else sum.replaceChildren(
        el("b", {}, plural(s.facts.length, "emission")), " touched ",
        el("b", {}, `${s.touched.size.toLocaleString()} ${s.touched.size === 1 ? "entity" : "entities"}`),
        ` (${s.newCount} new) · ${fromText} → ${toText}`,
        s.by ? ` · ${shortObserver(s.by)}` : "");
      renderPlay();
      draw();
    }

    /* --- histogram: activity bursts as segments, with breaks for the quiet gaps --- */
    const GAP_S = 2 * 3600, BREAK_PX = 12, BIN_PX = 3;
    function buildLayout(W) {
      const segs = [];
      for (let i = 0; i < order.length; i++) {
        const e = order[i], s = segs.at(-1);
        if (s && e.ts - s.t1 <= GAP_S) { s.t1 = e.ts; s.j1 = i; } else segs.push({ t0: e.ts, t1: e.ts, j0: i, j1: i });
      }
      const usable = Math.max(40, W - BREAK_PX * Math.max(0, segs.length - 1));
      const MIN = 8;
      const weight = segs.map((s) => s.j1 - s.j0 + 1);
      const total = weight.reduce((a, b) => a + b, 0) || 1;
      const extra = usable - MIN * segs.length;
      let x = 0;
      for (const [k, s] of segs.entries()) {
        s.x0 = x; s.w = MIN + Math.max(0, extra) * (weight[k] / total); x += s.w + BREAK_PX;
      }
      const xs = order.map((e, i) => {
        const s = segs.find((q) => i >= q.j0 && i <= q.j1);
        return s.x0 + (s.t1 > s.t0 ? ((e.ts - s.t0) / (s.t1 - s.t0)) * (s.w - 1) : s.w / 2);
      });
      const bins = new Map();
      xs.forEach((x, i) => { const b = Math.floor(x / BIN_PX); const v = bins.get(b) ?? []; v.push(i); bins.set(b, v); });
      const max = Math.max(1, ...[...bins.values()].map((v) => v.length));
      return { W, segs, xs, bins, max };
    }
    function draw() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W) return;
      if (!layout || layout.W !== W) layout = buildLayout(W);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      const c = canvas.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      const cs = getComputedStyle(canvas);
      const ink3 = cs.getPropertyValue("--ink-3").trim() || "#888", accent = cs.getPropertyValue("--accent").trim() || "#c80";
      const base = H - 14;
      const inSel = summary?.active ? (i) => i >= summary.i0 && i <= summary.hi && (!range.by || order[i].observer === range.by) : () => false;
      // Baseline per segment, break marks between them.
      c.strokeStyle = ink3; c.globalAlpha = 0.5; c.lineWidth = 1;
      for (const [k, s] of layout.segs.entries()) {
        c.beginPath(); c.moveTo(s.x0, base + 0.5); c.lineTo(s.x0 + s.w, base + 0.5); c.stroke();
        if (k) { const bx = s.x0 - BREAK_PX / 2; c.beginPath(); c.moveTo(bx - 3, base + 4); c.lineTo(bx + 1, base - 4); c.moveTo(bx, base + 4); c.lineTo(bx + 4, base - 4); c.stroke(); }
      }
      c.globalAlpha = 1;
      // Bars: sqrt height so a 100-fact burst doesn't flatten a 3-fact session.
      for (const [b, idx] of layout.bins) {
        const h = Math.max(2, Math.sqrt(idx.length / layout.max) * (base - 4));
        const sel = idx.filter(inSel).length;
        c.fillStyle = ink3; c.globalAlpha = summary?.active ? 0.35 : 0.7;
        c.fillRect(b * BIN_PX, base - h, BIN_PX - 1, h);
        if (sel) { c.globalAlpha = 1; c.fillStyle = accent; const hs = h * (sel / idx.length); c.fillRect(b * BIN_PX, base - hs, BIN_PX - 1, hs); }
      }
      c.globalAlpha = 1;
      // Playhead: just after the last played emission (at the range start before the first).
      if (play) {
        const x = Math.round(headX()) + 0.5;
        c.strokeStyle = cs.getPropertyValue("--ink").trim() || "#000"; c.lineWidth = 2;
        c.beginPath(); c.moveTo(x, 1); c.lineTo(x, base + 3); c.stroke();
      }
      // Date under each segment that has room.
      c.font = `10px ${cs.getPropertyValue("--mono") || "monospace"}`; c.fillStyle = ink3; c.textBaseline = "bottom";
      let lastEnd = -Infinity;
      for (const s of layout.segs) {
        const t = dayf.format(new Date(s.t0 * 1000)), w = c.measureText(t).width;
        if (s.x0 < lastEnd + 6 || s.x0 + w > W) continue;
        c.fillText(t, s.x0, H); lastEnd = s.x0 + w;
      }
    }
    function headX() {
      const i = play.head, i0 = bounds()[0];
      return i >= i0 ? layout.xs[i] + BIN_PX / 2 : Math.max(0, layout.xs[i0] - 2);
    }
    new ResizeObserver(() => { layout = null; draw(); }).observe(canvas);

    /* --- brush on the histogram (the sliders are the keyboard path) --- */
    const nearest = (x) => {
      const xs = layout?.xs ?? [];
      let lo = 0, hi = xs.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; }
      return lo > 0 && Math.abs(xs[lo - 1] - x) < Math.abs(xs[lo] - x) ? lo - 1 : lo;
    };
    let brush = null, dragHead = false;
    canvas.addEventListener("pointerdown", (e) => {
      if (!order.length) return;
      canvas.setPointerCapture(e.pointerId);
      if (play && layout && Math.abs(e.offsetX - headX()) <= 8) { dragHead = true; return; }
      brush = { a: nearest(e.offsetX) };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!layout) return;
      const i = nearest(e.offsetX), f = order[i];
      if (dragHead) seek(kAt(i));
      else if (brush) {
        const a = Math.min(brush.a, i), b = Math.max(brush.a, i), last = order.length - 1;
        setRange({ from: order[a].seq, to: b >= last ? null : order[b].seq, by: range.by });
      }
      const bin = layout.bins.get(Math.floor(layout.xs[i] / BIN_PX)) ?? [i];
      const obs = new Set(bin.map((j) => shortObserver(order[j].observer)));
      read.textContent = `${when(f.ts)} · ${plural(bin.length, "emission")} · ${[...obs].slice(0, 2).join(", ")}${obs.size > 2 ? "…" : ""}`;
    });
    const endBrush = () => { brush = null; dragHead = false; };
    canvas.addEventListener("pointerup", endBrush);
    canvas.addEventListener("pointercancel", endBrush);
    canvas.addEventListener("pointerleave", () => { if (!brush && !dragHead) read.textContent = ""; });

    return {
      setIndex, addFacts,
      get summary() { return summary; },
      get active() { return active(); },
      redraw: () => { layout = null; draw(); },
      clear,
      toggle, seek, stopPlay,
      get inPlay() { return !!play; },
      get playing() { return !!play?.playing; },
      // While replaying, an entity is present once its first-ever emission has played.
      existsAt(addr) {
        if (!play) return true;
        const f = firstPos.get(addr);
        return f == null || f <= play.head;
      },
    };
  }

  /* ---------- Feed helper: the emissions in a range, newest first, in pages ---------- */
  async function loadFacts(summary, offset, limit = 60) {
    const seqs = summary.facts.slice().reverse().slice(offset, offset + limit).map((e) => e.seq);
    if (!seqs.length) return [];
    const res = await fetch("/api/facts?seqs=" + seqs.join(","));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body.facts;
  }

  return { create, touchedBy, entryOf, readRange, loadFacts, setTouches };
})();
