/* The header shared by the tables view (/) and the graph view (/graph).

   Both pages declare <header class="top" data-chrome="tables|graph"> holding only their own
   pieces, marked data-slot="search" and (graph) data-slot="tools". This script runs right
   after that element is parsed and builds the same header around them, in the same order:

     [store name] [Tables | Graph] [stats]  [search]  [page tools] [Time range]  [live]

   It keeps the IDs both pages' scripts and the test suites use (#store-name, #to-tables,
   #to-graph, #stats, #time-btn, #live, #live-text). Placement stays with each page: tables
   uses a sticky bar, graph floats the groups as pills over the canvas so the gaps stay pannable.

   Also:
   - Publishes --header-h (the header's bottom edge, in px) on :root, so offsets below the
     header follow it when it wraps instead of hard-coding a height.
   - The Tables/Graph links carry the time range (query string) and an open entity (#kind/key).
   - Opts both pages into cross-document view transitions; the header keeps its place while
     the page under it cross-fades.
   Styles use tokens both pages define (--ink*, --line, --accent, --mono) plus four the page
   maps to its own palette: --chrome-bg, --chrome-field, --chrome-ok, --chrome-bad. */
"use strict";

window.Chrome = (() => {
  const header = document.querySelector("header[data-chrome]");
  const page = header.dataset.chrome;

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v === true ? "" : v);
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  };

  const CSS = `
@media (prefers-reduced-motion: no-preference) {
  @view-transition { navigation: auto; }
}
header[data-chrome] { view-transition-name: chrome-header; }
.chrome-id { display: flex; align-items: center; gap: 12px; min-width: 0; }
.chrome-id h1 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
/* Tables | Graph: a two-way switch. The current page is filled and bold, not colour alone. */
.chrome-views { display: flex; padding: 2px; gap: 2px; border: 1px solid var(--line); border-radius: 8px; }
.chrome-views a {
  padding: 2px 10px; border-radius: 6px; font-size: 12.5px; color: var(--ink-2); text-decoration: none; white-space: nowrap;
}
.chrome-views a:hover { color: var(--ink); background: var(--chrome-field); }
.chrome-views a[aria-current="page"] {
  color: var(--ink); font-weight: 650; background: var(--chrome-field);
  box-shadow: inset 0 0 0 1px var(--line);
}
.chrome-stats { display: flex; gap: 12px; color: var(--ink-2); font-size: 12.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.chrome-stats b { color: var(--ink); font-weight: 600; }
.chrome-actions { display: flex; align-items: center; gap: 4px; }
.chrome-spacer { flex: 1; }
.tl-toggle {
  height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 7px;
  background: transparent; color: var(--ink-2); cursor: pointer; white-space: nowrap;
}
.tl-toggle:hover { background: var(--chrome-field); color: var(--ink); }
.tl-toggle[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); }
.live { display: inline-flex; align-items: center; gap: 7px; color: var(--ink-2); font-size: 12.5px; white-space: nowrap; }
.live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); flex: none; }
.live[data-state="live"] .dot { background: var(--chrome-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--chrome-ok) 22%, transparent); }
.live[data-state="down"] .dot { background: var(--chrome-bad); }
/* The search slot shrinks before the row wraps; the spacer takes what is left. */
header[data-chrome] > [data-slot="search"] { flex: 1 1 200px; max-width: 320px; }
/* Phones: switch, actions and the live dot on one row (the actions scroll sideways if they
   must), search full width below. The store name and stats are hidden; the switch says where you are. */
@media (width < 760px) {
  .chrome-stats, .chrome-spacer { display: none; }
  .chrome-id h1, .live #live-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  header[data-chrome] > .chrome-id { order: 1; }
  header[data-chrome] > .chrome-actions { order: 2; min-width: 0; max-width: 100%; overflow-x: auto; flex: 0 1 auto; }
  header[data-chrome] > .live { order: 3; margin-inline-start: auto; }
  header[data-chrome] > [data-slot="search"] { order: 4; flex: 1 1 100%; max-width: none; }
}
@media (forced-colors: active) {
  .chrome-views a[aria-current="page"] { border: 1px solid CanvasText; }
}
`;
  document.head.append(el("style", { id: "chrome-css" }, CSS));

  /* --- build --- */
  const slot = (name) => header.querySelector(`[data-slot="${name}"]`);
  const search = slot("search"), tools = slot("tools");
  const link = (to, id, text) => el("a", { href: to, id, "aria-current": page === text.toLowerCase() ? "page" : null }, text);
  const tablesLink = link("/", "to-tables", "Tables");
  const graphLink = link("/graph", "to-graph", "Graph");
  header.replaceChildren(
    el("div", { class: "chrome-id" },
      el("h1", { id: "store-name" }, "Loops store"),
      el("nav", { class: "chrome-views", "aria-label": "Views" }, tablesLink, graphLink),
      el("span", { class: "chrome-stats", id: "stats" })),
    search,
    el("span", { class: "chrome-spacer" }),
    el("div", { class: "chrome-actions" }, tools,
      el("button", { type: "button", class: "tl-toggle", id: "time-btn", "aria-expanded": "false", "aria-controls": "timeline" }, "Time range")),
    el("div", { class: "live", id: "live", "data-state": "connecting" },
      el("span", { class: "dot", "aria-hidden": "true" }), el("span", { id: "live-text" }, "Connecting…")),
  );

  // Switching views keeps the time range and an open entity (#kind/key; a bare #view is tables-only).
  for (const [a, path] of [[tablesLink, "/"], [graphLink, "/graph"]]) {
    a.addEventListener("click", () => { a.href = path + location.search + (location.hash.includes("/") ? location.hash : ""); });
  }

  /* --- --header-h: the header's bottom edge, for anything placed below it --- */
  const publish = () => document.documentElement.style.setProperty("--header-h", Math.ceil(header.getBoundingClientRect().bottom) + "px");
  publish();
  new ResizeObserver(publish).observe(header);
  const headerHeight = () => Math.ceil(header.getBoundingClientRect().bottom);

  return { header, headerHeight };
})();
