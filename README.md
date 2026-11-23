# loops-viewer

A live, read-only viewer for a Strange Loops (`sl`) store: a tables page
with each kind's entities, their history and a feed of emissions as they arrive, and a graph
page that draws the store as a force-directed map. Both pages share a time range control that
selects a span of emissions, marks what it touched and can play it back.

The server is one Python file with no dependencies beyond the standard library. The pages are
plain HTML, CSS and JavaScript with no build step.

## Run it

```sh
python3 viewer/serve.py --vertex path/to/.loops/<name>.vertex
# Viewing path/to/.loops/data/<name>.db (read-only) at http://127.0.0.1:8765
```

| Option | Meaning |
|---|---|
| `--vertex` | The vertex file to view. Required. |
| `--config` | The display config. Default: `<name>.viewer.json` next to the vertex. Missing means the generic display. |
| `--port` | Port on 127.0.0.1. Default 8765. |
| `--emit-as` | Observer to emit as. Lets the page edit and create entities (see [Emit](#emit)). Without it the viewer is read-only. |

Needs Python 3.10 or later and `sl` on `PATH`; the server runs `sl read --json --all` to fold
the store's state.

## Safety

- **Loopback only.** The server binds to `127.0.0.1` and has no authentication. Do not put it
  behind a proxy, tunnel or `0.0.0.0` bind: anyone who reaches it reads the whole store.
- **Read-only by default.** The database is opened with SQLite `mode=ro`. Without
  `--emit-as` the viewer never emits; facts arrive through `sl emit` as usual and show up live.
- **Emits only through sl, only when asked for.** With `--emit-as`, `POST /api/emit` runs
  `sl emit --strict` (an argument list, no shell) as that observer. The server checks the kind
  is declared, field names are plain and not `*_ref`, and the key is set; sl does the rest.
  A request must carry this page's `Origin`, a JSON content type and a per-process token from
  `GET /api/emit`, so another site open in the same browser cannot post to it (cross-site
  request forgery). Emits are permanent history: test against a copy of the store.
- **Fixed files.** Only the four page files in `viewer/` (the two HTML pages and two scripts) are served, from an allowlist; `serve.py` itself is not.
- The config is data only. It is validated at startup, and a typo stops the server with the
  key that is wrong, not a broken page.

## Display config

Without a config the viewer is generic. Each kind gets a table whose columns are the
`preview_fields` sl declares for it, or else the kind's most common fields. Each kind also
gets a colour hashed from its name and a label from `display_name` or its key.

A store can give its own vocabulary in `<name>.viewer.json` next to its vertex. Every key is
optional. `examples/platform.viewer.json` is a complete example.

| Key | Shape | What it does |
|---|---|---|
| `columns` | `{kind: [[field, label], ...]}` | Table columns per kind. A field may list fallbacks with `\|`: `"title\|message"`. The key column always comes first. |
| `defaultColumns` | `[[field, label], ...]` | Columns for a kind without `columns` or `preview_fields`. |
| `groups` | `[[heading, [kind, ...]], ...]` | Sidebar groups. Unlisted kinds go under "Other". |
| `kindOrder` | `[kind, ...]` | Legend order and layout sectors in the graph. Unlisted kinds follow alphabetically. |
| `kindColors` | `{kind: 1-10 \| tone}` | Graph colour per kind: one of ten palette slots, or a tone. Once any kind is listed, unlisted kinds are grey. |
| `colorBy` | `{kind: field}` | Colour each entity of the kind by the tone of that field's value (e.g. severity). |
| `hidden` | `[kind, ...]` | Kinds hidden in the graph until switched on, e.g. provenance kinds that pull the layout into a knot. |
| `headline` | `[field, ...]` | Fields tried in order for an entity's one-line summary. |
| `tones` | `{value: tone}` | Badge and node tone for a value. Tones: `critical`, `high`, `medium`, `low`, `ok`. |
| `toneFields` | `[field, ...]` | Fields whose values render as toned badges in tables. |
| `cardTags` | `[field, ...]` | Fields shown as badges on an entity's first emission in the feed. |
| `ordinals` | `{field: [value, ...]}` | Rank order of a field's values, worst first. Used for sorting and tallies. |
| `labels` | `{kind: {fields, key, suffix}}` | Short names: the first non-empty of `fields`, else the key. `key` is `full` (the default), `last` (after the last `/`) or `after@` (after `@`). `suffix` adds ` · <field value>`. |
| `nodeSize` | `{kind: {base, field, add}}` | Graph node radius: `base`, plus `add[value of field]`. Degree adds to it as well. |
| `touches` | `{kind: field}` | An emission of the kind also marks the entity that the field references (`kind:key`), e.g. a verdict marks its finding. |
| `board` | see below | An optional first view that joins one kind with another. |

### Board

A board lists one kind's entities next to the entities of another kind that reference them,
worst first.

```json
"board": {
  "id": "findings", "title": "Findings board", "kind": "finding", "order": "worst first",
  "rowHeader": { "label": "Finding", "field": "title", "badge": "severity", "detail": "cwe" },
  "join": { "kind": "reachability", "predicate": "finding", "field": "verdict",
            "label": "Reachability", "key": "after@", "title": "deciding_fact" },
  "columns": [["subject", "Subject"]],
  "tiles": [{ "title": "Severity", "kind": "finding", "field": "severity" },
            { "title": "Mitigation", "kind": "finding", "field": "mitigation_status", "empty": "none recorded" }]
}
```

- Rows sort by the `ordinals` rank of `rowHeader.badge`, then by the worst joined value, then
  newest first.
- `join` collects entities of `join.kind` whose edge `join.predicate` points at the row. Each
  one shows as a chip reading `<key display> · <field>`, with `title` as its tooltip.
- Each tile tallies `field` over the present entities of `kind`. With `empty`, only entities
  that have the field count, and the text shows when none do.

## Moving through a kind

The detail view has **Prev** and **Next** (also ←/→ or j/k when focus is not in a field). They
step through the rows of the open entity's kind in the order the table shows them, so the
filter, the inactive toggle, the board's order and any header sort all apply. An entity reached
through a link to a kind that is not on screen steps through that kind newest first. The list is
taken when you open an entity and held while you step, so an edit that drops the entity from the
table (say, a question marked answered) does not lose your place.

## Emit

Start the server with `--emit-as <observer>` to change the store from the page:

- **Edit** in the detail view turns the fields into inputs. Only fields you change are emitted:
  a re-emit merges, so the others keep their value and the history shows exactly what changed.
  Empty a field to clear it. **Add field** adds one the entity does not have yet. Fields that
  are not text (sl emit writes strings) and `*_ref` fields (sl derives them) are not editable.
- **Quick edit:** outside the editor, double-click a field in the detail view (or focus it and
  press Enter or F2) to change just that field in place. Enter saves (⌘/Ctrl+Enter for multi-line
  text), Esc cancels. **+ Add field** under the fields adds one new field the same way. A quick
  edit emits straight away, with no preview step: it is one field you can see as you type, and
  `sl --strict` still validates it.
- **New <kind>** on a kind's table opens the same form, with the kind's usual fields.
- Fields whose values form a small set across the kind (status, verdict) suggest those values.
- **Preview emit** runs `sl emit --dry-run` and shows the change and the fact. **Emit** then
  sends that same fact. The stream brings it back like any other emission.

## Layout

```
viewer/serve.py      HTTP + SSE server (stdlib), config validation
viewer/index.html    tables page
viewer/graph.html    graph page
viewer/timeline.js   time range control shared by both pages
viewer/chrome.js     shared header
examples/            example display config
```
