import json
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from search_text import index_text


class IngestStore:
    def __init__(self, catalog):
        self.catalog = catalog

    @contextmanager
    def transaction(self):
        with self.catalog.connect() as db, db:
            db.execute("BEGIN IMMEDIATE")
            yield db

    def initialize(self):
        with self.catalog.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS document_versions (
                    doc_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    PRIMARY KEY (doc_id, version_id)
                );
                CREATE TABLE IF NOT EXISTS ingest_jobs (
                    id TEXT PRIMARY KEY,
                    doc_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    state TEXT NOT NULL,
                    error TEXT
                );
                CREATE INDEX IF NOT EXISTS ingest_jobs_doc ON ingest_jobs(doc_id);
                CREATE UNIQUE INDEX IF NOT EXISTS ingest_jobs_pending
                    ON ingest_jobs(doc_id) WHERE state IN ('queued', 'processing');
                CREATE TABLE IF NOT EXISTS active_indexes (
                    doc_id TEXT PRIMARY KEY,
                    version_id TEXT NOT NULL,
                    generation TEXT NOT NULL UNIQUE
                );
                CREATE TABLE IF NOT EXISTS indexed_chunks (
                    id TEXT NOT NULL UNIQUE,
                    generation TEXT NOT NULL,
                    doc_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS indexed_chunks_doc ON indexed_chunks(doc_id);
                CREATE INDEX IF NOT EXISTS indexed_chunks_generation ON indexed_chunks(generation);
            """)

        self._initialize_fts()

    def _initialize_fts(self):
        with self.transaction() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(indexed_chunks)")}
            if "search_text" in columns:
                return
            for name in ("chunk_fts_insert", "chunk_fts_delete"):
                db.execute(f"DROP TRIGGER IF EXISTS {name}")
            db.execute("DROP TABLE IF EXISTS chunk_fts")
            db.execute("ALTER TABLE indexed_chunks ADD COLUMN search_text TEXT NOT NULL DEFAULT ''")
            for rowid, content in db.execute("SELECT rowid, content FROM indexed_chunks"):
                db.execute(
                    "UPDATE indexed_chunks SET search_text = ? WHERE rowid = ?",
                    (index_text(content), rowid),
                )
            db.execute("""
                CREATE VIRTUAL TABLE chunk_fts USING fts5(
                    search_text, content='indexed_chunks', content_rowid='rowid'
                )
            """)
            db.execute("INSERT INTO chunk_fts(chunk_fts) VALUES ('rebuild')")
            db.execute("""
                CREATE TRIGGER chunk_fts_insert AFTER INSERT ON indexed_chunks BEGIN
                    INSERT INTO chunk_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
                END
            """)
            db.execute("""
                CREATE TRIGGER chunk_fts_delete AFTER DELETE ON indexed_chunks BEGIN
                    INSERT INTO chunk_fts(chunk_fts, rowid, search_text)
                    VALUES ('delete', old.rowid, old.search_text);
                END
            """)

    def enqueue(self, doc, version_id, path, *, new=False):
        doc_id = doc["id"]
        with self.transaction() as db:
            if new:
                db.execute("""
                    INSERT INTO catalog_records (kind, position, id, metadata)
                    VALUES ('documents', coalesce((
                        SELECT max(position) + 1 FROM catalog_records WHERE kind = 'documents'
                    ), 0), ?, ?)
                """, (doc_id, json.dumps(doc, ensure_ascii=False)))
            pending = db.execute("""
                SELECT id, version_id FROM ingest_jobs
                WHERE doc_id = ? AND state IN ('queued', 'processing')
            """, (doc_id,)).fetchone()
            if pending:
                return pending[0] if pending[1] == version_id else None
            self.remember_version(db, doc_id, version_id, path)
            return self._enqueue(db, doc_id, version_id)

    @staticmethod
    def remember_version(db, doc_id, version_id, path):
        db.execute("""
            INSERT INTO document_versions(doc_id, version_id, path, size) VALUES (?, ?, ?, ?)
            ON CONFLICT(doc_id, version_id) DO UPDATE SET path = excluded.path, size = excluded.size
        """, (doc_id, version_id, str(path), path.stat().st_size))

    @staticmethod
    def _enqueue(db, doc_id, version_id):
        job_id = uuid4().hex
        db.execute(
            "INSERT INTO ingest_jobs (id, doc_id, version_id, state) VALUES (?, ?, ?, 'queued')",
            (job_id, doc_id, version_id),
        )
        return job_id

    def recover(self):
        with self.transaction() as db:
            db.execute("UPDATE ingest_jobs SET state = 'queued' WHERE state = 'processing'")

    def latest(self, doc_id):
        with self.catalog.connect() as db:
            row = db.execute("""
                SELECT id, version_id, state, error FROM ingest_jobs
                WHERE doc_id = ? ORDER BY rowid DESC LIMIT 1
            """, (doc_id,)).fetchone()
        if row:
            return dict(zip(("id", "version_id", "status", "error"), row, strict=True))
        return None

    def original(self, doc_id, version_id=None):
        with self.catalog.connect() as db:
            if version_id is not None:
                return db.execute("""
                    SELECT path, size FROM document_versions WHERE doc_id = ? AND version_id = ?
                """, (doc_id, version_id)).fetchone()
            return db.execute("""
                SELECT v.path, v.size FROM active_indexes a JOIN document_versions v
                ON v.doc_id = a.doc_id AND v.version_id = a.version_id WHERE a.doc_id = ?
            """, (doc_id,)).fetchone()

    def claim(self):
        with self.transaction() as db:
            job = db.execute("""
                SELECT j.id, j.doc_id, j.version_id, v.path, d.metadata
                FROM ingest_jobs j
                JOIN document_versions v USING(doc_id, version_id)
                JOIN catalog_records d ON d.kind = 'documents' AND d.id = j.doc_id
                WHERE j.state = 'queued' ORDER BY j.rowid LIMIT 1
            """).fetchone()
            if job:
                db.execute("UPDATE ingest_jobs SET state = 'processing' WHERE id = ?", (job[0],))
                return job[:4] + (json.loads(job[4]),)
        return None

    def finish(self, job_id, state, error=None):
        with self.transaction() as db:
            db.execute(
                "UPDATE ingest_jobs SET state = ?, error = ? WHERE id = ? AND state = 'processing'",
                (state, error, job_id),
            )

    @staticmethod
    def _activate(db, doc_id, version_id, generation, records, tokenized):
        db.executemany("""
            INSERT INTO indexed_chunks (id, generation, doc_id, content, metadata, search_text)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            (chunk_id, generation, doc_id, content, json.dumps(metadata, ensure_ascii=False), tokens)
            for (chunk_id, content, metadata), tokens in zip(records, tokenized, strict=True)
        ))
        db.execute("""
            INSERT INTO active_indexes VALUES (?, ?, ?)
            ON CONFLICT(doc_id) DO UPDATE SET
                version_id = excluded.version_id, generation = excluded.generation
        """, (doc_id, version_id, generation))
        db.execute(
            "DELETE FROM indexed_chunks WHERE doc_id = ? AND generation <> ?", (doc_id, generation),
        )

    def adopt_legacy(self, doc_id, version_id, path, generation, records, rebuild):
        with self.transaction() as db:
            self.remember_version(db, doc_id, version_id, path)
            if records:
                self._activate(db, doc_id, version_id, generation, records, [index_text(text) for _, text, _ in records])
            if rebuild:
                self._enqueue(db, doc_id, version_id)

    def publish(self, doc_id, version_id, job_id, records, tokenized):
        with self.transaction() as db:
            pending = db.execute(
                "SELECT 1 FROM ingest_jobs WHERE id = ? AND state = 'processing'", (job_id,),
            ).fetchone()
            if not pending:
                return False, None
            previous = db.execute("SELECT generation FROM active_indexes WHERE doc_id = ?", (doc_id,)).fetchone()
            self._activate(db, doc_id, version_id, job_id, records, tokenized)
            db.execute("UPDATE ingest_jobs SET state = 'parsed' WHERE id = ?", (job_id,))
            return True, previous[0] if previous else None

    def status_snapshot(self, doc_id=None):
        sql = """
            SELECT d.id, v.path, v.size, j.id, j.state, j.error
            FROM catalog_records d
            LEFT JOIN active_indexes a ON a.doc_id = d.id
            LEFT JOIN document_versions v ON v.doc_id = a.doc_id AND v.version_id = a.version_id
            LEFT JOIN ingest_jobs j ON j.rowid = (
                SELECT max(rowid) FROM ingest_jobs WHERE doc_id = d.id
            )
            WHERE d.kind = 'documents'
        """
        with self.catalog.connect() as db:
            rows = db.execute(sql + " AND d.id = ?", (doc_id,)) if doc_id else db.execute(sql)
            return {row[0]: row[1:] for row in rows}

    def repair_missing_vectors(self, found):
        with self.transaction() as db:
            active = db.execute("""
                SELECT a.doc_id, a.version_id, a.generation, COUNT(c.id)
                FROM active_indexes a LEFT JOIN indexed_chunks c USING(generation)
                GROUP BY a.generation
            """).fetchall()
            for doc_id, version_id, generation, count in active:
                if count == found.get(generation, 0) and count > 0:
                    continue
                pending = db.execute("""
                    SELECT 1 FROM ingest_jobs WHERE doc_id = ? AND state IN ('queued', 'processing')
                """, (doc_id,)).fetchone()
                if not pending:
                    self._enqueue(db, doc_id, version_id)

    def queue_parser_upgrades(self, parser_version):
        """Reindex PDFs atomically on parser upgrades; retain old indexes until publish."""
        count = 0
        with self.transaction() as db:
            for doc_id, version, generation, path in db.execute("""
                SELECT a.doc_id, a.version_id, a.generation, v.path
                FROM active_indexes a JOIN document_versions v USING(doc_id, version_id)
            """).fetchall():
                if Path(path).suffix.lower() != ".pdf":
                    continue
                current = db.execute("""
                    SELECT json_extract(metadata, '$.parser_version'),
                           json_extract(metadata, '$.source_map_json') FROM indexed_chunks
                    WHERE generation = ? LIMIT 1
                """, (generation,)).fetchone()
                if current and current[0] == parser_version and current[1]:
                    continue
                if db.execute("SELECT 1 FROM ingest_jobs WHERE doc_id = ? AND state IN ('queued','processing')",
                              (doc_id,)).fetchone():
                    continue
                self._enqueue(db, doc_id, version)
                count += 1
        return count

    def registered_documents(self):
        with self.catalog.connect() as db:
            return {row[0] for row in db.execute("SELECT DISTINCT doc_id FROM document_versions")}

    def matching_documents(self, version_id):
        with self.catalog.connect() as db:
            return {row[0] for row in db.execute("""
                SELECT a.doc_id FROM active_indexes a WHERE a.version_id = ?
                UNION
                SELECT j.doc_id FROM ingest_jobs j
                WHERE j.version_id = ? AND j.rowid = (
                    SELECT max(rowid) FROM ingest_jobs WHERE doc_id = j.doc_id
                )
                AND NOT EXISTS (SELECT 1 FROM active_indexes WHERE doc_id = j.doc_id)
            """, (version_id, version_id))}

    def active_generations(self):
        with self.catalog.connect() as db:
            return {row[0] for row in db.execute("SELECT generation FROM active_indexes")}

    def remove(self, doc_ids):
        paths = set()
        with self.transaction() as db:
            for doc_id in doc_ids:
                paths.update(row[0] for row in db.execute(
                    "SELECT path FROM document_versions WHERE doc_id = ?", (doc_id,),
                ))
                for table in ("active_indexes", "indexed_chunks", "document_versions", "ingest_jobs"):
                    db.execute(f"DELETE FROM {table} WHERE doc_id = ?", (doc_id,))
                db.execute("DELETE FROM catalog_records WHERE kind = 'documents' AND id = ?", (doc_id,))
            referenced = {row[0] for row in db.execute("SELECT DISTINCT path FROM document_versions")}
        return {Path(path) for path in paths - referenced}
