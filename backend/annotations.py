"""Persist PDF highlights, underlines and notes by document version and page."""
import json
from datetime import datetime, timezone
from uuid import uuid4


class AnnotationStore:
    def __init__(self, catalog):
        self.catalog = catalog

    def initialize(self):
        with self.catalog.connect() as db, db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS pdf_annotations (
                    id TEXT PRIMARY KEY,
                    doc_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    page_index INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    color TEXT NOT NULL,
                    rects TEXT NOT NULL,
                    quote TEXT NOT NULL DEFAULT '',
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            db.execute("""
                CREATE INDEX IF NOT EXISTS pdf_annotations_doc
                ON pdf_annotations(doc_id, version_id, page_index)
            """)

    @staticmethod
    def _record(row):
        (annotation_id, doc_id, version_id, page_index, kind, color,
         rects, quote, note, created_at, updated_at) = row
        return {
            "id": annotation_id,
            "document_id": doc_id,
            "version_id": version_id,
            "page_index": page_index,
            "kind": kind,
            "color": color,
            "rects": json.loads(rects),
            "quote": quote,
            "note": note,
            "created_at": created_at,
            "updated_at": updated_at,
        }

    def list(self, doc_id, version_id):
        with self.catalog.connect() as db:
            rows = db.execute("""
                SELECT id, doc_id, version_id, page_index, kind, color, rects,
                       quote, note, created_at, updated_at
                FROM pdf_annotations
                WHERE doc_id = ? AND version_id = ?
                ORDER BY page_index, created_at, rowid
            """, (doc_id, version_id)).fetchall()
        return [self._record(row) for row in rows]

    def get(self, annotation_id):
        with self.catalog.connect() as db:
            row = db.execute("""
                SELECT id, doc_id, version_id, page_index, kind, color, rects,
                       quote, note, created_at, updated_at
                FROM pdf_annotations WHERE id = ?
            """, (annotation_id,)).fetchone()
        return self._record(row) if row else None

    def create(self, doc_id, version_id, page_index, kind, color, rects, quote, note):
        annotation_id = uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        with self.catalog.connect() as db, db:
            db.execute("""
                INSERT INTO pdf_annotations(
                    id, doc_id, version_id, page_index, kind, color, rects,
                    quote, note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                annotation_id, doc_id, version_id, page_index, kind, color,
                json.dumps(rects), quote, note, now, now,
            ))
        return self.get(annotation_id)

    def update(self, doc_id, annotation_id, *, note=None, color=None, kind=None):
        updates, values = [], []
        if note is not None:
            updates.append("note = ?")
            values.append(note)
        if color is not None:
            updates.append("color = ?")
            values.append(color)
        if kind is not None:
            updates.append("kind = ?")
            values.append(kind)
        if not updates:
            with self.catalog.connect() as db:
                row = db.execute(
                    "SELECT 1 FROM pdf_annotations WHERE id = ? AND doc_id = ?",
                    (annotation_id, doc_id),
                ).fetchone()
            return self.get(annotation_id) if row else None
        updates.append("updated_at = ?")
        values.append(datetime.now(timezone.utc).isoformat())
        values.extend((annotation_id, doc_id))
        with self.catalog.connect() as db, db:
            cursor = db.execute(
                f"UPDATE pdf_annotations SET {', '.join(updates)} WHERE id = ? AND doc_id = ?",
                values,
            )
            if cursor.rowcount == 0:
                return None
        return self.get(annotation_id)

    def delete(self, doc_id, annotation_id):
        with self.catalog.connect() as db, db:
            cursor = db.execute(
                "DELETE FROM pdf_annotations WHERE id = ? AND doc_id = ?",
                (annotation_id, doc_id),
            )
            return cursor.rowcount > 0
