import json
from functools import lru_cache
from uuid import uuid4

from search_text import index_text, match_expression


class ChatHistory:
    def __init__(self, catalog):
        self.catalog = catalog

    @lru_cache(maxsize=1)
    def initialize(self):
        self.catalog.initialize()
        with self.catalog.connect() as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS chat_threads (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS chat_turns (
                    id INTEGER PRIMARY KEY,
                    thread_id TEXT NOT NULL REFERENCES chat_threads(id),
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    attachment_filename TEXT,
                    sources TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    route TEXT NOT NULL,
                    rag_enabled INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS chat_turns_thread_idx ON chat_turns(thread_id, id);
            """)

        with self.catalog.connect() as db, db:
            thread_columns = {row[1] for row in db.execute("PRAGMA table_info(chat_threads)")}
            if "working_state" not in thread_columns:
                db.execute("ALTER TABLE chat_threads ADD COLUMN working_state TEXT NOT NULL DEFAULT '{}'")
            turn_columns = {row[1] for row in db.execute("PRAGMA table_info(chat_turns)")}
            if "working_state" not in turn_columns:
                db.execute("ALTER TABLE chat_turns ADD COLUMN working_state TEXT NOT NULL DEFAULT '{}'")
            db.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS chat_memory_search USING fts5(
                    question_terms, answer_terms
                )
            """)
            rows = db.execute("""
                SELECT t.id, t.question, t.answer FROM chat_turns t
                LEFT JOIN chat_memory_search f ON f.rowid = t.id WHERE f.rowid IS NULL
            """).fetchall()
            db.executemany("INSERT INTO chat_memory_search(rowid, question_terms, answer_terms) VALUES (?, ?, ?)",
                           [(key, index_text(q), index_text(a)) for key, q, a in rows])

    def state(self, thread_id):
        if not thread_id:
            return {}
        with self.catalog.connect() as db:
            row = db.execute("SELECT working_state FROM chat_threads WHERE id = ?", (thread_id,)).fetchone()
        return json.loads(row[0]) if row else {}

    def create(self):
        self.initialize()
        thread_id = uuid4().hex
        with self.catalog.connect() as db, db:
            db.execute("INSERT INTO chat_threads(id) VALUES (?)", (thread_id,))
        return thread_id

    def list(self):
        self.initialize()
        with self.catalog.connect() as db:
            return [
                {"id": thread_id, "title": title, "updated_at": updated_at}
                for thread_id, title, updated_at in db.execute("""
                    SELECT id, title, updated_at FROM chat_threads
                    WHERE title <> '' ORDER BY updated_at DESC, rowid DESC
                """)
            ]

    def exists(self, thread_id):
        self.initialize()
        with self.catalog.connect() as db:
            return db.execute("SELECT 1 FROM chat_threads WHERE id = ?", (thread_id,)).fetchone() is not None

    def rename(self, thread_id, title):
        self.initialize()
        with self.catalog.connect() as db, db:
            return db.execute("""
                UPDATE chat_threads SET title = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
            """, (title, thread_id)).rowcount == 1

    def delete(self, thread_id):
        self.initialize()
        with self.catalog.connect() as db, db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM chat_threads WHERE id = ?", (thread_id,)).fetchone():
                return False
            db.execute("""
                DELETE FROM chat_memory_search WHERE rowid IN (
                    SELECT id FROM chat_turns WHERE thread_id = ?
                )
            """, (thread_id,))
            db.execute("DELETE FROM chat_turns WHERE thread_id = ?", (thread_id,))
            db.execute("DELETE FROM chat_threads WHERE id = ?", (thread_id,))
            return True

    def append(self, thread_id, question, answer, attachment_filename, sources, scope, route, rag_enabled, state=None):
        title = " ".join(question.split())[:60] or "新会话"
        with self.catalog.connect() as db, db:
            # Serialize with deletion: an in-flight answer must not recreate a deleted thread.
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM chat_threads WHERE id = ?", (thread_id,)).fetchone():
                raise LookupError("会话已删除，无法保存回答")
            result = db.execute("""
                INSERT INTO chat_turns(thread_id, question, answer, attachment_filename, sources, scope, route, rag_enabled, working_state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (thread_id, question, answer, attachment_filename,
                  json.dumps(sources, ensure_ascii=False), json.dumps(scope), route, rag_enabled,
                  json.dumps(state or {}, ensure_ascii=False)))
            db.execute("INSERT INTO chat_memory_search(rowid, question_terms, answer_terms) VALUES (?, ?, ?)",
                       (result.lastrowid, index_text(question), index_text(answer)))
            if state is not None:
                db.execute("UPDATE chat_threads SET working_state = ? WHERE id = ?",
                           (json.dumps(state, ensure_ascii=False), thread_id))
            db.execute("""
                UPDATE chat_threads SET title = COALESCE(NULLIF(title, ''), ?),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
            """, (title, thread_id))

    def turns(self, thread_id, limit=-1, include_library=True):
        with self.catalog.connect() as db:
            rows = db.execute("""
                SELECT question, answer, attachment_filename, sources, scope, route FROM chat_turns
                WHERE thread_id = ? AND (? OR NOT rag_enabled OR route = 'general')
                ORDER BY id DESC LIMIT ?
            """, (thread_id, include_library, limit)).fetchall()
        return [
            {"question": question, "answer": answer, "attachment_filename": attachment,
             "sources": json.loads(sources), "scope": json.loads(scope), "route": route}
            for question, answer, attachment, sources, scope, route in reversed(rows)
        ]

    def context(self, thread_id, include_library, question=''):
        if not thread_id:
            return []
        expression = match_expression(question)
        with self.catalog.connect() as db:
            recent = [row[0] for row in db.execute("""
                SELECT id FROM chat_turns WHERE thread_id = ? AND (? OR NOT rag_enabled OR route = 'general')
                ORDER BY id DESC LIMIT 6
            """, (thread_id, include_library))]
            ids = list(recent)
            if expression:
                ranked = db.execute("""
                    SELECT t.id FROM chat_memory_search f JOIN chat_turns t ON t.id = f.rowid
                    WHERE chat_memory_search MATCH ? AND thread_id = ?
                    AND (? OR NOT rag_enabled OR route = 'general')
                    ORDER BY bm25(chat_memory_search, 3, 1), t.id DESC LIMIT 10
                """, (expression, thread_id, include_library))
                ids.extend([key for (key,) in ranked if key not in recent][:4])
            if not ids:
                return []
            marks = ", ".join("?" for _ in ids)
            rows = db.execute(f"""
                SELECT id, question, answer, attachment_filename, sources, scope, route FROM chat_turns
                WHERE thread_id = ? AND id IN ({marks}) ORDER BY id
            """, (thread_id, *ids)).fetchall()
        return [
            {"turn_id": key, "question": q[:1100], "answer": a[:1600],
             "attachment_filename": attachment, "sources": json.loads(sources),
             "scope": json.loads(scope), "route": route}
            for key, q, a, attachment, sources, scope, route in rows
        ]
