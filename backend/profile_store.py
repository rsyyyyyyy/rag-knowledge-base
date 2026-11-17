"""Durable generation jobs and versioned reading artifacts."""
import json
from datetime import datetime, timezone
from uuid import uuid4
from paper_index import initialize_paper_search, replace_profile_search


def initialize_profiles(db):
    for statement in [
        """CREATE TABLE IF NOT EXISTS document_profiles (
            doc_id TEXT NOT NULL, generation TEXT NOT NULL, config_key TEXT NOT NULL,
            version_id TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY(doc_id, generation, config_key)
        )""",
        """CREATE TABLE IF NOT EXISTS profile_jobs (
            id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, version_id TEXT NOT NULL,
            generation TEXT NOT NULL, config_key TEXT NOT NULL, state TEXT NOT NULL,
            progress TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL
        )""",
        """CREATE UNIQUE INDEX IF NOT EXISTS profile_jobs_pending
            ON profile_jobs(doc_id) WHERE state IN ('queued', 'processing')""",
    ]:
        db.execute(statement)
    initialize_paper_search(db)


class ProfileStore:
    def __init__(self, store):
        self.store = store
        self.catalog = store.catalog

    @staticmethod
    def timestamp():
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def active(db, doc_id):
        return db.execute("""
            SELECT a.version_id, a.generation FROM active_indexes a
            JOIN catalog_records d ON d.kind = 'documents' AND d.id = a.doc_id
            WHERE a.doc_id = ?
        """, (doc_id,)).fetchone()

    def recover(self):
        with self.store.transaction() as db:
            db.execute("UPDATE profile_jobs SET state='queued' WHERE state='processing'")

    def enqueue(self, doc_id, config_key, force=False, expected_version=None):
        with self.store.transaction() as db:
            active = self.active(db, doc_id)
            if not active:
                raise ValueError("请等待文献解析完成后再生成卡片。")
            version, generation = active
            if expected_version is not None and expected_version != version:
                raise ValueError("文献版本已更新，请重新打开文献。")
            db.execute("""
                UPDATE profile_jobs SET state='cancelled', updated_at=?
                WHERE doc_id=? AND state IN ('queued','processing')
                AND (generation<>? OR config_key<>?)
            """, (self.timestamp(), doc_id, generation, config_key))
            pending = db.execute("""
                SELECT id FROM profile_jobs WHERE doc_id=? AND state IN ('queued','processing')
            """, (doc_id,)).fetchone()
            cached = db.execute("""
                SELECT 1 FROM document_profiles WHERE doc_id=? AND generation=? AND config_key=?
            """, (doc_id, generation, config_key)).fetchone()
            if pending or (cached and not force):
                return pending[0] if pending else None
            job_id = uuid4().hex
            progress = {"batch_notes": [], "completed": 0, "total": 0, "stage": "reading",
                        "partial": False, "token_usage": 0, "model_calls": 0}
            if not force:
                previous = db.execute("""
                    SELECT progress FROM profile_jobs WHERE doc_id=? AND generation=?
                    AND config_key=? AND state='failed' ORDER BY rowid DESC LIMIT 1
                """, (doc_id, generation, config_key)).fetchone()
                if previous:
                    progress = json.loads(previous[0])
            db.execute("INSERT INTO profile_jobs VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, ?)",
                       (job_id, doc_id, version, generation, config_key,
                        json.dumps(progress), self.timestamp()))
            return job_id

    def claim(self):
        with self.store.transaction() as db:
            db.execute("""
                UPDATE profile_jobs SET state='cancelled' WHERE state='queued' AND NOT EXISTS (
                    SELECT 1 FROM active_indexes a JOIN catalog_records d
                    ON d.kind='documents' AND d.id=a.doc_id
                    WHERE a.doc_id=profile_jobs.doc_id AND a.generation=profile_jobs.generation
                )
            """)
            row = db.execute("""
                SELECT id, doc_id, version_id, generation, config_key, progress
                FROM profile_jobs WHERE state='queued' ORDER BY rowid LIMIT 1
            """).fetchone()
            if not row:
                return None
            db.execute("UPDATE profile_jobs SET state='processing', updated_at=? WHERE id=?",
                       (self.timestamp(), row[0]))
            return dict(zip(("id", "doc_id", "version_id", "generation", "config_key", "progress"),
                            (*row[:5], json.loads(row[5])), strict=True))

    def checkpoint(self, job, progress):
        with self.store.transaction() as db:
            if self.active(db, job["doc_id"]) != (job["version_id"], job["generation"]):
                db.execute("UPDATE profile_jobs SET state='cancelled' WHERE id=?", (job["id"],))
                return False
            changed = db.execute("""
                UPDATE profile_jobs SET progress=?, updated_at=?
                WHERE id=? AND state='processing'
            """, (json.dumps(progress, ensure_ascii=False), self.timestamp(), job["id"])).rowcount
            return bool(changed)

    def publish(self, job, content):
        with self.store.transaction() as db:
            pending = db.execute("SELECT state FROM profile_jobs WHERE id=?", (job["id"],)).fetchone()
            if pending != ("processing",):
                return False
            if self.active(db, job["doc_id"]) != (job["version_id"], job["generation"]):
                db.execute("UPDATE profile_jobs SET state='cancelled' WHERE id=?", (job["id"],))
                return False
            now = self.timestamp()
            db.execute("""
                INSERT INTO document_profiles VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(doc_id,generation,config_key) DO UPDATE SET
                    content=excluded.content, updated_at=excluded.updated_at
            """, (job["doc_id"], job["generation"], job["config_key"], job["version_id"],
                  json.dumps(content, ensure_ascii=False), now))
            db.execute("UPDATE profile_jobs SET state=?, updated_at=? WHERE id=?",
                       ("partial" if content["partial"] else "ready", now, job["id"]))
            replace_profile_search(db, job['doc_id'], job['generation'], job['config_key'], content)
            return True

    def fail(self, job_id, error):
        with self.store.transaction() as db:
            db.execute("""
                UPDATE profile_jobs SET state='failed', error=?, updated_at=?
                WHERE id=? AND state='processing'
            """, (error, self.timestamp(), job_id))

    def get(self, doc_id, config_key, expected_version=None):
        with self.catalog.connect() as db:
            active = self.active(db, doc_id)
            if not active:
                return {"state": "not_ready", "artifact": None, "progress": None, "error": None}
            version, generation = active
            if expected_version is not None and version != expected_version:
                raise ValueError("文献版本已更新，请重新打开文献。")
            cached = db.execute("""
                SELECT content FROM document_profiles WHERE doc_id=? AND generation=? AND config_key=?
            """, (doc_id, generation, config_key)).fetchone()
            row = db.execute("""
                SELECT id,state,progress,error FROM profile_jobs
                WHERE doc_id=? AND generation=? AND config_key=? ORDER BY rowid DESC LIMIT 1
            """, (doc_id, generation, config_key)).fetchone()
            artifact = json.loads(cached[0]) if cached else None
            progress = json.loads(row[2]) if row else None
            # Batch notes stay internal until the full artifact is published.
            visible_progress = {key: progress[key] for key in ("completed", "total", "stage")} if progress else None
            state = row[1] if row else ("ready" if artifact else "not_generated")
            return {"document_id": doc_id, "version_id": version, "generation": generation,
                    "job_id": row[0] if row else None, "state": state, "artifact": artifact,
                    "progress": visible_progress, "error": row[3] if row else None}
