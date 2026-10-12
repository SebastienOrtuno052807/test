#!/usr/bin/env python3
"""OpenReader - a free, local-first alternative to Readwise + Readwise Reader.

Save articles/notes/PDFs/EPUBs, read them in a clean view, highlight,
and review highlights with spaced repetition. Your data stays in a local
SQLite database - no account, no subscription, no cloud.
"""
import csv
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import sys
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path

import bleach
import trafilatura
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------- data dir

def data_dir() -> Path:
    env = os.environ.get("OPENREADER_DATA")
    if env:
        p = Path(env)
    elif getattr(sys, "frozen", False):
        p = Path.home() / "OpenReader"
    else:
        p = Path(__file__).resolve().parent.parent / "data"
    p.mkdir(parents=True, exist_ok=True)
    (p / "uploads").mkdir(exist_ok=True)
    return p

DATA = data_dir()
DB_PATH = DATA / "openreader.db"
UPLOADS = DATA / "uploads"

# ---------------------------------------------------------------- helpers

def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

SCHEMA = """
CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT DEFAULT '',
    url TEXT DEFAULT '',
    source_type TEXT DEFAULT 'article',
    content_html TEXT DEFAULT '',
    text_content TEXT DEFAULT '',
    excerpt TEXT DEFAULT '',
    word_count INTEGER DEFAULT 0,
    cover_image TEXT DEFAULT '',
    archived INTEGER DEFAULT 0,
    favorite INTEGER DEFAULT 0,
    read_progress REAL DEFAULT 0,
    file_path TEXT DEFAULT '',
    created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tags(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS item_tags(
    item_id INTEGER, tag_id INTEGER,
    UNIQUE(item_id, tag_id)
);
CREATE TABLE IF NOT EXISTS highlights(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    prefix TEXT DEFAULT '', suffix TEXT DEFAULT '',
    note TEXT DEFAULT '', color TEXT DEFAULT 'yellow',
    tags TEXT DEFAULT '', location TEXT DEFAULT '',
    created_at TEXT, updated_at TEXT,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reviews(
    highlight_id INTEGER PRIMARY KEY,
    interval_days REAL DEFAULT 1,
    ease REAL DEFAULT 2.2,
    due_at TEXT, reps INTEGER DEFAULT 0, last_reviewed TEXT,
    FOREIGN KEY(highlight_id) REFERENCES highlights(id) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts
    USING fts5(title, author, text_content, content='items', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, title, author, text_content)
    VALUES (new.id, new.title, new.author, new.text_content);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, author, text_content)
    VALUES ('delete', old.id, old.title, old.author, old.text_content);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, author, text_content)
    VALUES ('delete', old.id, old.title, old.author, old.text_content);
    INSERT INTO items_fts(rowid, title, author, text_content)
    VALUES (new.id, new.title, new.author, new.text_content);
END;
"""

_db_lock = threading.Lock()

def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con

def init_db():
    with _db_lock, db() as con:
        con.executescript(SCHEMA)
        # lightweight migrations for existing databases
        for stmt in ("ALTER TABLE items ADD COLUMN note TEXT DEFAULT ''",):
            try:
                con.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists

# ---------------------------------------------------------------- sanitize

ALLOWED_TAGS = [
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code",
    "ul", "ol", "li", "a", "img", "figure", "figcaption",
    "strong", "em", "b", "i", "u", "s", "br", "hr",
    "table", "thead", "tbody", "tr", "th", "td",
    "div", "span", "article", "section",
]
ALLOWED_ATTRS = {
    "a": ["href", "title"],
    "img": ["src", "alt", "title"],
}

def clean_html(html: str) -> str:
    return bleach.clean(html, tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRS,
                        strip=True, strip_comments=True)

def html_to_text(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text

def summarize(title, text):
    words = text.split()
    excerpt = text[:220] + ("…" if len(text) > 220 else "")
    return excerpt, len(words), max(1, round(len(words) / 200))

# ---------------------------------------------------------------- extraction

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

def extract_from_url(url: str):
    import requests
    try:
        resp = requests.get(url, headers={"User-Agent": _UA}, timeout=25)
        resp.raise_for_status()
        downloaded = resp.text
    except Exception:
        raise HTTPException(400, "Could not download that URL.")
    html = trafilatura.extract(downloaded, output_format="html",
                              include_images=True, include_links=True,
                              include_tables=True) or ""
    text = trafilatura.extract(downloaded, output_format="txt") or ""
    meta = trafilatura.extract_metadata(downloaded)
    title = (meta.title if meta and meta.title else "") or url
    author = (meta.author if meta and meta.author else "") or ""
    image = (meta.image if meta and meta.image else "") or ""
    if not html.strip() and not text.strip():
        raise HTTPException(400, "No readable article content found at that URL.")
    return {"title": title.strip(), "author": author.strip(),
            "content_html": clean_html(html) or f"<p>{bleach.clean(text)}</p>",
            "text_content": text.strip() or html_to_text(html),
            "cover_image": image}

def extract_pdf(path: Path, filename: str):
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    pages = []
    for i, page in enumerate(reader.pages):
        t = (page.extract_text() or "").strip()
        if t:
            paras = [f"<p>{bleach.clean(p)}</p>" for p in t.split("\n\n") if p.strip()]
            pages.append(f'<h2>Page {i + 1}</h2>' + "\n".join(paras))
    meta = reader.metadata or {}
    title = str(meta.get("/Title") or "") or Path(filename).stem
    author = str(meta.get("/Author") or "")
    html = "\n".join(pages) or "<p>(No extractable text in this PDF.)</p>"
    return {"title": title, "author": author, "content_html": html,
            "text_content": html_to_text(html), "cover_image": ""}

def extract_epub(path: Path, filename: str):
    import ebooklib
    from ebooklib import epub
    book = epub.read_epub(str(path))
    title = (book.get_metadata("DC", "title") or [[""]])[0][0] or Path(filename).stem
    author = (book.get_metadata("DC", "creator") or [[""]])[0][0] or ""
    parts = []
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        try:
            parts.append(item.get_content().decode("utf-8", "ignore"))
        except Exception:
            pass
    html = clean_html("\n".join(parts)) or "<p>(No readable content in this EPUB.)</p>"
    return {"title": title, "author": author, "content_html": html,
            "text_content": html_to_text(html), "cover_image": ""}

def extract_upload(filename: str, path: Path):
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf(path, filename), "pdf"
    if ext == ".epub":
        return extract_epub(path, filename), "epub"
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    stem = Path(filename).stem
    if ext in (".html", ".htm"):
        data = {"title": stem, "author": "",
                "content_html": clean_html(text),
                "text_content": html_to_text(text), "cover_image": ""}
    else:
        paras = "".join(f"<p>{bleach.clean(p)}</p>" for p in text.split("\n\n") if p.strip())
        data = {"title": stem, "author": "", "content_html": paras or "<p>(empty)</p>",
                "text_content": text, "cover_image": ""}
    return data, "note"

# ---------------------------------------------------------------- app

app = FastAPI(title="OpenReader")
init_db()

class FromUrl(BaseModel):
    url: str

class ItemCreate(BaseModel):
    title: str
    content: str = ""          # plain text or html
    author: str = ""
    url: str = ""
    tags: list[str] = []

class ItemUpdate(BaseModel):
    title: str | None = None
    author: str | None = None
    archived: bool | None = None
    favorite: bool | None = None
    read_progress: float | None = None
    note: str | None = None
    tags: list[str] | None = None

class HighlightCreate(BaseModel):
    text: str
    prefix: str = ""
    suffix: str = ""
    note: str = ""
    color: str = "yellow"
    tags: str = ""
    location: str = ""

class HighlightUpdate(BaseModel):
    text: str | None = None
    note: str | None = None
    color: str | None = None
    tags: str | None = None

class ReviewGrade(BaseModel):
    highlight_id: int
    grade: str  # again | good | easy

# ----- tags

def ensure_tags(con, names: list[str]) -> list[int]:
    ids = []
    for raw in names:
        name = raw.strip().lower()
        if not name:
            continue
        con.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (name,))
        row = con.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()
        ids.append(row["id"])
    return ids

def tags_for(con, item_id: int) -> list[str]:
    rows = con.execute(
        "SELECT t.name FROM tags t JOIN item_tags it ON it.tag_id=t.id "
        "WHERE it.item_id=? ORDER BY t.name", (item_id,)).fetchall()
    return [r["name"] for r in rows]

def set_item_tags(con, item_id: int, names: list[str]):
    con.execute("DELETE FROM item_tags WHERE item_id=?", (item_id,))
    for tid in ensure_tags(con, names):
        con.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES (?,?)",
                    (item_id, tid))

def item_row(con, row) -> dict:
    d = dict(row)
    d["tags"] = tags_for(con, d["id"])
    d["highlight_count"] = con.execute(
        "SELECT COUNT(*) c FROM highlights WHERE item_id=?", (d["id"],)).fetchone()["c"]
    for k in ("archived", "favorite"):
        d[k] = bool(d[k])
    return d

# ----- items

@app.get("/api/items")
def list_items(q: str = "", tag: str = "", archived: int = 0,
               favorite: int = 0, sort: str = "recent",
               limit: int = 200, offset: int = 0):
    order = {"recent": "i.updated_at DESC", "oldest": "i.created_at ASC",
             "title": "i.title COLLATE NOCASE ASC",
             "longest": "i.word_count DESC"}.get(sort, "i.updated_at DESC")
    where, params = ["i.archived=?"], [archived]
    if favorite:
        where.append("i.favorite=1")
    if tag:
        where.append("i.id IN (SELECT it.item_id FROM item_tags it "
                     "JOIN tags t ON t.id=it.tag_id WHERE t.name=?)")
        params.append(tag.lower())
    join = ""
    if q:
        join = "JOIN items_fts f ON f.rowid=i.id"
        where.append("items_fts MATCH ?")
        params.append(q)
    sql = (f"SELECT i.* FROM items i {join} WHERE {' AND '.join(where)} "
           f"ORDER BY {order} LIMIT ? OFFSET ?")
    with _db_lock, db() as con:
        rows = con.execute(sql, (*params, limit, offset)).fetchall()
        return [item_row(con, r) for r in rows]

@app.post("/api/items/from-url", status_code=201)
def create_from_url(body: FromUrl):
    url = body.url.strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    data = extract_from_url(url)
    excerpt, words, mins = summarize(data["title"], data["text_content"])
    now = utcnow()
    with _db_lock, db() as con:
        cur = con.execute(
            "INSERT INTO items(title, author, url, source_type, content_html, text_content,"
            " excerpt, word_count, cover_image, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (data["title"], data["author"], url, "article", data["content_html"],
             data["text_content"], excerpt, words, data["cover_image"], now, now))
        item_id = cur.lastrowid
        return item_row(con, con.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone())

@app.post("/api/items", status_code=201)
def create_note(body: ItemCreate):
    html = body.content if re.search(r"<[a-z][^>]*>", body.content, re.I) else \
        "".join(f"<p>{bleach.clean(p)}</p>" for p in body.content.split("\n\n") if p.strip())
    text = html_to_text(html)
    excerpt, words, mins = summarize(body.title, text)
    now = utcnow()
    with _db_lock, db() as con:
        cur = con.execute(
            "INSERT INTO items(title, author, url, source_type, content_html, text_content,"
            " excerpt, word_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (body.title.strip() or "Untitled note", body.author, body.url, "note",
             clean_html(html), text, excerpt, words, now, now))
        item_id = cur.lastrowid
        set_item_tags(con, item_id, body.tags)
        return item_row(con, con.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone())

@app.post("/api/items/upload", status_code=201)
async def upload_item(file: UploadFile = File(...)):
    ext = Path(file.filename or "upload").suffix.lower()
    if ext not in (".pdf", ".epub", ".html", ".htm", ".txt", ".md"):
        raise HTTPException(400, "Supported files: PDF, EPUB, HTML, TXT, MD.")
    digest = hashlib.sha256(((file.filename or "") + utcnow()).encode()).hexdigest()[:12]
    dest = UPLOADS / f"{digest}{ext}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        data, stype = extract_upload(file.filename or "upload", dest)
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"Could not read that file: {e}")
    excerpt, words, mins = summarize(data["title"], data["text_content"])
    now = utcnow()
    with _db_lock, db() as con:
        cur = con.execute(
            "INSERT INTO items(title, author, source_type, content_html, text_content,"
            " excerpt, word_count, file_path, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (data["title"], data["author"], stype, data["content_html"],
             data["text_content"], excerpt, words, str(dest), now, now))
        item_id = cur.lastrowid
        return item_row(con, con.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone())

@app.get("/api/items/{item_id}")
def get_item(item_id: int):
    with _db_lock, db() as con:
        row = con.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Item not found.")
        d = item_row(con, row)
        d["highlights"] = [dict(h) for h in con.execute(
            "SELECT * FROM highlights WHERE item_id=? ORDER BY id", (item_id,)).fetchall()]
        return d

@app.patch("/api/items/{item_id}")
def update_item(item_id: int, body: ItemUpdate):
    with _db_lock, db() as con:
        row = con.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Item not found.")
        updates, params = [], []
        if body.title is not None:
            updates.append("title=?"); params.append(body.title.strip())
        if body.author is not None:
            updates.append("author=?"); params.append(body.author.strip())
        if body.note is not None:
            updates.append("note=?"); params.append(body.note)
        if body.archived is not None:
            updates.append("archived=?"); params.append(1 if body.archived else 0)
        if body.favorite is not None:
            updates.append("favorite=?"); params.append(1 if body.favorite else 0)
        if body.read_progress is not None:
            updates.append("read_progress=?")
            params.append(max(0.0, min(1.0, body.read_progress)))
        if updates:
            updates.append("updated_at=?"); params.append(utcnow())
            con.execute(f"UPDATE items SET {', '.join(updates)} WHERE id=?",
                        (*params, item_id))
        if body.tags is not None:
            set_item_tags(con, item_id, body.tags)
        return item_row(con, con.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone())

@app.delete("/api/items/{item_id}")
def delete_item(item_id: int):
    with _db_lock, db() as con:
        row = con.execute("SELECT file_path FROM items WHERE id=?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Item not found.")
        con.execute("DELETE FROM items WHERE id=?", (item_id,))
        if row["file_path"]:
            Path(row["file_path"]).unlink(missing_ok=True)
        return {"ok": True}

@app.get("/api/items/{item_id}/file")
def get_item_file(item_id: int):
    with _db_lock, db() as con:
        row = con.execute("SELECT file_path, title FROM items WHERE id=?", (item_id,)).fetchone()
    if not row or not row["file_path"] or not Path(row["file_path"]).exists():
        raise HTTPException(404, "No file stored for this item.")
    return FileResponse(row["file_path"], filename=Path(row["file_path"]).name)

# ----- highlights

@app.get("/api/items/{item_id}/highlights")
def list_highlights(item_id: int):
    with _db_lock, db() as con:
        return [dict(h) for h in con.execute(
            "SELECT * FROM highlights WHERE item_id=? ORDER BY id", (item_id,)).fetchall()]

@app.post("/api/items/{item_id}/highlights", status_code=201)
def create_highlight(item_id: int, body: HighlightCreate):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Highlight text is empty.")
    now = utcnow()
    with _db_lock, db() as con:
        if not con.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
            raise HTTPException(404, "Item not found.")
        cur = con.execute(
            "INSERT INTO highlights(item_id, text, prefix, suffix, note, color, tags,"
            " location, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (item_id, text, body.prefix, body.suffix, body.note,
             body.color or "yellow", body.tags, body.location, now, now))
        hid = cur.lastrowid
        con.execute(
            "INSERT INTO reviews(highlight_id, due_at) VALUES (?, ?)",
            (hid, (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(timespec="seconds")))
        return dict(con.execute("SELECT * FROM highlights WHERE id=?", (hid,)).fetchone())

@app.patch("/api/highlights/{hid}")
def update_highlight(hid: int, body: HighlightUpdate):
    with _db_lock, db() as con:
        if not con.execute("SELECT 1 FROM highlights WHERE id=?", (hid,)).fetchone():
            raise HTTPException(404, "Highlight not found.")
        updates, params = [], []
        for field in ("text", "note", "color", "tags"):
            val = getattr(body, field)
            if val is not None:
                updates.append(f"{field}=?"); params.append(val)
        if updates:
            updates.append("updated_at=?"); params.append(utcnow())
            con.execute(f"UPDATE highlights SET {', '.join(updates)} WHERE id=?",
                        (*params, hid))
        return dict(con.execute("SELECT * FROM highlights WHERE id=?", (hid,)).fetchone())

@app.delete("/api/highlights/{hid}")
def delete_highlight(hid: int):
    with _db_lock, db() as con:
        con.execute("DELETE FROM highlights WHERE id=?", (hid,))
        return {"ok": True}

# ----- review (spaced repetition, SM-2 lite)

@app.get("/api/review/queue")
def review_queue(limit: int = 50):
    now = utcnow()
    with _db_lock, db() as con:
        rows = con.execute(
            "SELECT h.*, r.interval_days, r.ease, r.reps, r.due_at,"
            " i.title AS item_title, i.author AS item_author, i.url AS item_url"
            " FROM highlights h JOIN reviews r ON r.highlight_id=h.id"
            " JOIN items i ON i.id=h.item_id"
            " WHERE r.due_at <= ? AND i.archived=0"
            " ORDER BY r.due_at ASC LIMIT ?", (now, limit)).fetchall()
        total_due = con.execute(
            "SELECT COUNT(*) c FROM reviews r JOIN highlights h ON h.id=r.highlight_id"
            " JOIN items i ON i.id=h.item_id WHERE r.due_at <= ? AND i.archived=0",
            (now,)).fetchone()["c"]
        return {"due": total_due, "items": [dict(r) for r in rows]}

@app.post("/api/review/grade")
def grade_review(body: ReviewGrade):
    if body.grade not in ("again", "good", "easy"):
        raise HTTPException(400, "grade must be again, good, or easy")
    with _db_lock, db() as con:
        rev = con.execute("SELECT * FROM reviews WHERE highlight_id=?",
                          (body.highlight_id,)).fetchone()
        if not rev:
            raise HTTPException(404, "Highlight not in review schedule.")
        interval, ease, reps = rev["interval_days"], rev["ease"], rev["reps"]
        if body.grade == "again":
            interval, ease = 1, max(1.3, ease - 0.2)
        elif body.grade == "good":
            interval = max(2, round(interval * ease)) if reps else 2
        else:  # easy
            interval = max(3, round(interval * ease * 1.3)) if reps else 3
            ease = min(2.8, ease + 0.1)
        due = (datetime.now(timezone.utc) + timedelta(days=interval)).isoformat(timespec="seconds")
        con.execute(
            "UPDATE reviews SET interval_days=?, ease=?, due_at=?, reps=reps+1,"
            " last_reviewed=? WHERE highlight_id=?",
            (interval, ease, due, utcnow(), body.highlight_id))
        return {"ok": True, "next_due": due, "interval_days": interval}

# ----- tags

@app.get("/api/tags")
def list_tags():
    with _db_lock, db() as con:
        rows = con.execute(
            "SELECT t.name, COUNT(it.item_id) AS count FROM tags t"
            " LEFT JOIN item_tags it ON it.tag_id=t.id"
            " GROUP BY t.id ORDER BY t.name").fetchall()
        return [dict(r) for r in rows]

@app.delete("/api/tags/{name}")
def delete_tag(name: str):
    with _db_lock, db() as con:
        con.execute("DELETE FROM tags WHERE name=?", (name.lower(),))
        return {"ok": True}

# ----- import: Readwise CSV export

def _norm_header(h: str) -> str:
    return re.sub(r"[^a-z]", "", h.lower())

@app.post("/api/import/readwise")
async def import_readwise(file: UploadFile = File(...)):
    raw = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw))
    if not reader.fieldnames:
        raise HTTPException(400, "Could not parse that CSV.")
    cols = {_norm_header(h): h for h in reader.fieldnames}

    def pick(*names):
        for n in names:
            if _norm_header(n) in cols:
                return cols[_norm_header(n)]
        return None

    c_text = pick("highlight", "text")
    c_title = pick("title", "booktitle", "book")
    c_author = pick("author")
    c_note = pick("note", "annotation")
    c_url = pick("url", "sourceurl", "locationurl")
    c_loc = pick("location")
    c_date = pick("date", "highlightedat", "createdat")
    c_cat = pick("category")
    c_tags = pick("tags")
    if not c_text or not c_title:
        raise HTTPException(400, "CSV needs at least Highlight and Title columns.")

    groups: dict[tuple[str, str], dict] = {}
    for row in reader:
        text = (row.get(c_text) or "").strip()
        title = (row.get(c_title) or "").strip()
        if not text or not title:
            continue
        url = (row.get(c_url) or "").strip() if c_url else ""
        key = (title.lower(), url.lower())
        g = groups.setdefault(key, {"title": title, "url": url,
                                    "author": (row.get(c_author) or "").strip() if c_author else "",
                                    "tags": set(), "highlights": []})
        if c_cat and row.get(c_cat):
            g["tags"].add(row[c_cat].strip().lower())
        if c_tags and row.get(c_tags):
            g["tags"].update(t.strip().lower() for t in re.split(r"[,;]", row[c_tags]) if t.strip())
        g["highlights"].append({
            "text": text,
            "note": (row.get(c_note) or "").strip() if c_note else "",
            "location": (row.get(c_loc) or "").strip() if c_loc else "",
            "created": (row.get(c_date) or "").strip() if c_date else "",
        })

    now = utcnow()
    n_items = n_hl = 0
    with _db_lock, db() as con:
        for g in groups.values():
            full_text = "\n\n".join(h["text"] for h in g["highlights"])
            excerpt, words, _ = summarize(g["title"], full_text)
            cur = con.execute(
                "INSERT INTO items(title, author, url, source_type, content_html,"
                " text_content, excerpt, word_count, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (g["title"], g["author"], g["url"], "import",
                 "".join(f"<blockquote>{bleach.clean(h['text'])}</blockquote>"
                         for h in g["highlights"]),
                 full_text, excerpt, words, now, now))
            item_id = cur.lastrowid
            n_items += 1
            set_item_tags(con, item_id, sorted(g["tags"]))
            for h in g["highlights"]:
                cur = con.execute(
                    "INSERT INTO highlights(item_id, text, note, location, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?)",
                    (item_id, h["text"], h["note"], h["location"],
                     h["created"] or now, now))
                n_hl += 1
                con.execute("INSERT INTO reviews(highlight_id, due_at) VALUES (?, ?)",
                            (cur.lastrowid,
                             (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(timespec="seconds")))
    return {"items": n_items, "highlights": n_hl}

# ----- export

@app.get("/api/export")
def export_data(format: str = Query("json", pattern="^(json|csv|markdown)$")):
    with _db_lock, db() as con:
        items = [item_row(con, r) for r in
                 con.execute("SELECT * FROM items ORDER BY created_at").fetchall()]
        for it in items:
            it["highlights"] = [dict(h) for h in con.execute(
                "SELECT * FROM highlights WHERE item_id=? ORDER BY id", (it["id"],)).fetchall()]
    if format == "json":
        return JSONResponse(items)
    if format == "csv":
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["highlight", "title", "author", "url", "note", "color", "tags", "created_at"])
        for it in items:
            for h in it["highlights"]:
                w.writerow([h["text"], it["title"], it["author"], it["url"],
                            h["note"], h["color"], h["tags"], h["created_at"]])
        return PlainTextResponse(out.getvalue(), media_type="text/csv",
                                 headers={"Content-Disposition": "attachment; filename=openreader-export.csv"})
    md = ["# OpenReader export\n"]
    for it in items:
        md.append(f"\n## {it['title']}\n")
        if it["author"]:
            md.append(f"*by {it['author']}*\n")
        if it["url"]:
            md.append(f"{it['url']}\n")
        for h in it["highlights"]:
            md.append(f"\n> {h['text']}\n")
            if h["note"]:
                md.append(f"\nNote: {h['note']}\n")
    return PlainTextResponse("\n".join(md), media_type="text/markdown",
                             headers={"Content-Disposition": "attachment; filename=openreader-export.md"})

# ----- stats

@app.get("/api/stats")
def stats():
    now = utcnow()
    with _db_lock, db() as con:
        return {
            "items": con.execute("SELECT COUNT(*) c FROM items WHERE archived=0").fetchone()["c"],
            "archived": con.execute("SELECT COUNT(*) c FROM items WHERE archived=1").fetchone()["c"],
            "highlights": con.execute("SELECT COUNT(*) c FROM highlights").fetchone()["c"],
            "due": con.execute(
                "SELECT COUNT(*) c FROM reviews r JOIN highlights h ON h.id=r.highlight_id"
                " JOIN items i ON i.id=h.item_id WHERE r.due_at <= ? AND i.archived=0",
                (now,)).fetchone()["c"],
            "words": con.execute("SELECT COALESCE(SUM(word_count),0) s FROM items WHERE archived=0").fetchone()["s"],
        }

# ---------------------------------------------------------------- static + PWA

def _base_dir() -> Path:
    # PyInstaller onefile/one-dir bundles unpack into sys._MEIPASS
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent

STATIC = _base_dir() / "static"

@app.get("/manifest.json")
def manifest():
    return FileResponse(STATIC / "manifest.json", media_type="application/manifest+json")

@app.get("/sw.js")
def sw():
    return FileResponse(STATIC / "sw.js", media_type="application/javascript")

app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("OPENREADER_PORT", "8765")))
