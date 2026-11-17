#!/usr/bin/env python3
"""Live, read-only viewer for a Strange Loops vertex.

    python3 viewer/serve.py --vertex path/to/.loops/<name>.vertex          # http://127.0.0.1:8765
    python3 viewer/serve.py --vertex <name>.vertex --config my.viewer.json --port 9000

Display config: `<name>.viewer.json` next to the vertex (or --config). It names columns,
sidebar groups, colours, labels and an optional joined board per kind. Without one, every
kind gets generic columns (sl's preview_fields, else the most common fields). See README.md.

What it serves:
  /              the single-page viewer (index.html next to this file)
  /graph         the same store as a live node graph (graph.html next to this file)
  /api/state     folded state from `sl read <vertex> --json --all` (sl stays the
                 authority on folding and lifecycle; this file never re-implements them)
  /api/facts     raw emissions, newest first, each with `before` (the entity's fields
                 just before it) so the page can show what changed
  /api/history   every emission of one kind+key, oldest first, each with `before`
  /api/config    the display config (validated at startup)
  /api/index     every emission as a compact row [seq, ts, kind, name, observer, touches],
                 in time order: what the time-range control draws and selects from.
                 `touches` is the payload field the config's `touches` names for that kind
  /api/facts?seqs=1,2,3   those emissions (at most 200), newest first, each with `before`
  /timeline.js   the time-range control (and Play) shared by both pages
  /chrome.js     the header shared by both pages
  /api/stream    Server-Sent Events: new emissions as they land, keyed by SQLite rowid

Safety:
  - Binds to 127.0.0.1 only and rejects requests whose Host header is not loopback
    (DNS-rebinding guard). A store can hold sensitive facts: never expose it.
  - Opens the store with SQLite `mode=ro`. There is no write path.
  - New facts are tracked by rowid (arrival order), not ts or ULID, because
    `loops sync` can insert facts with older timestamps.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
POLL_SECONDS = 1.0
KEEPALIVE_SECONDS = 15.0
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
# The only files served: URL path -> (file next to this script, content type). Nothing else
# under HERE is reachable, so adding a page or script means adding it here.
HTML, JS = "text/html; charset=utf-8", "text/javascript; charset=utf-8"
STATIC = {
    "/": ("index.html", HTML), "/index.html": ("index.html", HTML),
    "/graph": ("graph.html", HTML), "/graph.html": ("graph.html", HTML),
    "/timeline.js": ("timeline.js", JS),
    "/chrome.js": ("chrome.js", JS),
}

FACT_COLUMNS = "rowid, id, kind, ts, observer, origin, payload"


FIELD = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
CONFIG_KEYS = {
    "columns", "defaultColumns", "groups", "kindOrder", "kindColors", "colorBy", "hidden",
    "headline", "tones", "toneFields", "cardTags", "ordinals", "labels", "nodeSize", "touches", "board",
}


TONES = ("critical", "high", "medium", "low", "ok")   # the badge and node tones the pages define


def load_config(path: Path) -> dict:
    """The display config: pure data, checked here so a typo fails at startup, not in the page.

    A missing file is an empty config (generic display). Only the shapes the pages rely on
    are checked; values are display text and are rendered as text, never as HTML.
    """
    if not path.is_file():
        return {}
    try:
        config = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path}: not valid JSON ({exc})") from exc

    def fail(key: str, why: str) -> None:
        raise SystemExit(f"{path}: `{key}` {why}")

    if not isinstance(config, dict):
        fail("(top level)", "must be an object")
    for key in config:
        if key not in CONFIG_KEYS:
            fail(key, f"is not a known key (known: {', '.join(sorted(CONFIG_KEYS))})")

    def columns(key: str, value: object) -> None:
        if not isinstance(value, list) or not all(
            isinstance(c, list) and len(c) == 2 and all(isinstance(x, str) for x in c) for c in value
        ):
            fail(key, 'must be a list of ["field|fallback", "Label"] pairs')

    def str_list(key: str, value: object) -> None:
        if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
            fail(key, "must be a list of strings")

    def str_map(key: str, value: object) -> None:
        if not isinstance(value, dict) or not all(isinstance(v, str) for v in value.values()):
            fail(key, "must map strings to strings")

    for kind, cols in config.get("columns", {}).items():
        columns(f"columns.{kind}", cols)
    if "defaultColumns" in config:
        columns("defaultColumns", config["defaultColumns"])
    for i, group in enumerate(config.get("groups", [])):
        if not (isinstance(group, list) and len(group) == 2 and isinstance(group[0], str)):
            fail(f"groups[{i}]", 'must be ["Group name", ["kind", ...]]')
        str_list(f"groups.{group[0]}", group[1])
    for key in ("kindOrder", "hidden", "headline", "toneFields", "cardTags"):
        if key in config:
            str_list(key, config[key])
    for key in ("tones", "colorBy", "touches"):
        if key in config:
            str_map(key, config[key])
    for kind, slot in config.get("kindColors", {}).items():
        is_slot = isinstance(slot, int) and not isinstance(slot, bool) and 1 <= slot <= 10
        if not (is_slot or slot in TONES):
            fail(f"kindColors.{kind}", f"must be a colour slot from 1 to 10 or a tone ({', '.join(TONES)})")
    for value, tone in config.get("tones", {}).items():
        if tone not in TONES:
            fail(f"tones.{value}", f"must be one of {', '.join(TONES)}")
    for field, values in config.get("ordinals", {}).items():
        str_list(f"ordinals.{field}", values)
    for kind, label in config.get("labels", {}).items():
        if not isinstance(label, dict):
            fail(f"labels.{kind}", 'must be an object like {"fields": [...], "key": "last", "suffix": "field"}')
        if label.get("key", "full") not in ("full", "last", "after@"):
            fail(f"labels.{kind}.key", 'must be "full", "last" or "after@"')
    # `touches` fields go into a JSON path in SQL (as a bound parameter, but keep them plain anyway).
    for kind, field in config.get("touches", {}).items():
        if not FIELD.match(field):
            fail(f"touches.{kind}", "must be a plain field name")
    board = config.get("board")
    if board is not None:
        for key in ("id", "title", "kind"):
            if not isinstance(board.get(key), str):
                fail(f"board.{key}", "is required and must be a string")
        if "join" in board:
            for key in ("kind", "predicate", "field"):
                if not isinstance(board["join"].get(key), str):
                    fail(f"board.join.{key}", "is required and must be a string")
        if "columns" in board:
            columns("board.columns", board["columns"])
    return config


def store_path(vertex: Path) -> Path:
    """Resolve the `store "..."` declaration, relative to the vertex file."""
    match = re.search(r'^\s*store\s+"([^"]+)"', vertex.read_text(), re.MULTILINE)
    if not match:
        raise SystemExit(f"No store declaration in {vertex}")
    return (vertex.parent / match.group(1)).resolve()


class Store:
    def __init__(self, vertex: Path, touches: dict[str, str] | None = None) -> None:
        self.vertex = vertex
        self.touches = touches or {}
        self.db = store_path(vertex)
        if not self.db.is_file():
            raise SystemExit(f"Store not found: {self.db}")
        self._state_lock = threading.Lock()
        self._state_head = -1
        self._state_body = b""

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def head(self) -> int:
        with self.connect() as conn:
            return conn.execute("SELECT coalesce(max(rowid), 0) FROM facts").fetchone()[0]

    @staticmethod
    def _fact(row: sqlite3.Row) -> dict:
        return {
            "seq": row["rowid"],
            "id": row["id"],
            "kind": row["kind"],
            "ts": row["ts"],
            "observer": row["observer"],
            "origin": row["origin"],
            "payload": json.loads(row["payload"]),
        }

    def _with_before(self, conn: sqlite3.Connection, facts: list[dict]) -> list[dict]:
        """Attach `before`: the entity's fields just before this emission, or None if new.

        A re-emit merges into the entity: fields it omits keep their earlier value (checked
        with `sl read` on a store copy, 2026-11-17). So `before` is the merge of every
        earlier emission of the same kind+name, and the page diffs only the fields the new
        emission carries. This is for display only; `sl read` stays the folded state.
        """
        for fact in facts:
            rows = conn.execute(
                "SELECT payload FROM facts WHERE kind = ? AND rowid < ?"
                " AND json_extract(payload, '$.name') IS ? ORDER BY rowid",
                (fact["kind"], fact["seq"], fact["payload"].get("name")),
            ).fetchall()
            before: dict | None = None
            for row in rows:
                before = {**(before or {}), **json.loads(row["payload"])}
            fact["before"] = before
        return facts

    def facts_after(self, seq: int, limit: int = 500) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT {FACT_COLUMNS} FROM facts WHERE rowid > ? ORDER BY rowid LIMIT ?",
                (seq, limit),
            ).fetchall()
            return self._with_before(conn, [self._fact(r) for r in rows])

    def facts_before(self, seq: int | None, limit: int) -> list[dict]:
        with self.connect() as conn:
            if seq is None:
                rows = conn.execute(
                    f"SELECT {FACT_COLUMNS} FROM facts ORDER BY rowid DESC LIMIT ?", (limit,)
                ).fetchall()
            else:
                rows = conn.execute(
                    f"SELECT {FACT_COLUMNS} FROM facts WHERE rowid < ? ORDER BY rowid DESC LIMIT ?",
                    (seq, limit),
                ).fetchall()
            return self._with_before(conn, [self._fact(r) for r in rows])

    def facts_by_seq(self, seqs: list[int]) -> list[dict]:
        with self.connect() as conn:
            marks = ",".join("?" * len(seqs))
            rows = conn.execute(
                f"SELECT {FACT_COLUMNS} FROM facts WHERE rowid IN ({marks}) ORDER BY ts DESC, rowid DESC",
                seqs,
            ).fetchall()
            return self._with_before(conn, [self._fact(r) for r in rows])

    def index(self) -> list[list]:
        """One compact row per emission, ordered by event time (ts), then arrival (rowid).

        The last column is the entity a fact also touches, from the config's `touches`
        (e.g. a reachability verdict also shows on its finding). Kinds and fields are bound
        parameters; the SQL only grows by one `WHEN ? THEN json_extract(payload, ?)` per kind.
        """
        whens, params = "", []
        for kind, field in self.touches.items():
            whens += " WHEN ? THEN json_extract(payload, ?)"
            params += [kind, "$." + field]
        touches = f"CASE kind{whens} END" if whens else "NULL"
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT rowid, ts, kind, json_extract(payload, '$.name'), observer, {touches}"
                " FROM facts ORDER BY ts, rowid",
                params,
            ).fetchall()
            return [list(r) for r in rows]

    def history(self, kind: str, key: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT {FACT_COLUMNS} FROM facts WHERE kind = ?"
                " AND json_extract(payload, '$.name') = ? ORDER BY rowid",
                (kind, key),
            ).fetchall()
            return self._with_before(conn, [self._fact(r) for r in rows])

    def state(self) -> bytes:
        """Folded state via sl, re-run only when the store has grown."""
        head = self.head()
        with self._state_lock:
            if head != self._state_head:
                result = subprocess.run(
                    ["sl", "read", str(self.vertex), "--json", "--all"],
                    capture_output=True, text=True, timeout=30, check=False,
                )
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.strip() or "sl read failed")
                folded = json.loads(result.stdout)
                keep = ("address", "kind", "key", "payload", "edges", "ts", "observer", "n", "id")
                body = {
                    "vertex": folded.get("vertex"),
                    "head": head,
                    "schema": folded.get("schema", {}),
                    "rows": [{k: row.get(k) for k in keep} for row in folded.get("rows", [])],
                }
                self._state_body = json.dumps(body).encode()
                self._state_head = head
            return self._state_body


def make_handler(store: Store, config: dict) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: object) -> None:  # quieter than default
            if not self.path.startswith("/api/stream"):
                super().log_message(fmt, *args)

        def _host_ok(self) -> bool:
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
            return host in ALLOWED_HOSTS

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';"
                " img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
            )
            self.end_headers()
            self.wfile.write(body)

        def _json(self, value: object, status: int = 200) -> None:
            body = value if isinstance(value, bytes) else json.dumps(value).encode()
            self._send(status, body, "application/json; charset=utf-8")

        def do_GET(self) -> None:  # noqa: N802
            if not self._host_ok():
                self._send(403, b"Forbidden host", "text/plain; charset=utf-8")
                return
            url = urlparse(self.path)
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                if url.path in STATIC:
                    name, ctype = STATIC[url.path]
                    self._send(200, (HERE / name).read_bytes(), ctype)
                elif url.path == "/api/config":
                    self._json(config)
                elif url.path == "/api/state":
                    self._json(store.state())
                elif url.path == "/api/index":
                    self._json({"head": store.head(), "facts": store.index()})
                elif url.path == "/api/facts" and "seqs" in query:
                    seqs = [int(x) for x in query["seqs"].split(",") if x][:200]
                    self._json({"facts": store.facts_by_seq(seqs) if seqs else []})
                elif url.path == "/api/facts":
                    before = int(query["before"]) if "before" in query else None
                    limit = max(1, min(int(query.get("limit", 60)), 500))
                    self._json({"head": store.head(), "facts": store.facts_before(before, limit)})
                elif url.path == "/api/history":
                    self._json({"facts": store.history(query["kind"], query["key"])})
                elif url.path == "/api/stream":
                    self._stream()
                else:
                    self._send(404, b"Not found", "text/plain; charset=utf-8")
            except (KeyError, ValueError) as exc:
                self._json({"error": f"bad request: {exc}"}, status=400)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:  # surface sl/sqlite failures to the page
                self._json({"error": str(exc)}, status=500)

        def _stream(self) -> None:
            # EventSource sends Last-Event-ID on reconnect, so a dropped connection resumes
            # exactly where it left off. A fresh page passes ?after=<head it rendered>.
            last = self.headers.get("Last-Event-ID") or parse_qs(urlparse(self.path).query).get("after", [None])[0]
            cursor = int(last) if last else store.head()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.write(b"retry: 2000\n\n")
            self.wfile.flush()
            idle = 0.0
            while True:
                facts = store.facts_after(cursor)
                if facts:
                    cursor = facts[-1]["seq"]
                    self.wfile.write(f"id: {cursor}\nevent: facts\ndata: {json.dumps(facts)}\n\n".encode())
                    self.wfile.flush()
                    idle = 0.0
                elif idle >= KEEPALIVE_SECONDS:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    idle = 0.0
                time.sleep(POLL_SECONDS)
                idle += POLL_SECONDS

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vertex", type=Path, required=True, help="the vertex file to view")
    parser.add_argument("--config", type=Path, help="display config (default: <vertex name>.viewer.json next to the vertex)")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    vertex = args.vertex.resolve()
    config_path = (args.config or vertex.with_suffix(".viewer.json")).resolve()
    if args.config and not config_path.is_file():
        raise SystemExit(f"Config not found: {config_path}")
    config = load_config(config_path)
    store = Store(vertex, config.get("touches"))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store, config))
    server.daemon_threads = True
    print(f"Viewing {store.db} (read-only) at http://127.0.0.1:{args.port}", flush=True)
    print(f"Display config: {config_path if config_path.is_file() else 'none (generic display)'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
