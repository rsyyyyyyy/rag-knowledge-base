import json
from functools import lru_cache
from uuid import uuid4


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

    def append(self, thread_id, question, answer, attachment_filename, sources, scope, route, rag_enabled):
        title = " ".join(question.split())[:60] or "新会话"
        with self.catalog.connect() as db, db:
            db.execute("""
                INSERT INTO chat_turns(thread_id, question, answer, attachment_filename, sources, scope, route, rag_enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (thread_id, question, answer, attachment_filename,
                  json.dumps(sources, ensure_ascii=False), json.dumps(scope), route, rag_enabled))
            db.execute("""
                UPDATE chat_threads SET title = COALESCE(NULLIF(title, ''), ?),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
            """, (title, thread_id))

    def turns(self, thread_id, limit=-1, include_library=True):
        with self.catalog.connect() as db:
            rows = db.execute("""
                SELECT question, answer, attachment_filename, sources, scope FROM chat_turns
                WHERE thread_id = ? AND (? OR NOT rag_enabled OR route = 'general')
                ORDER BY id DESC LIMIT ?
            """, (thread_id, include_library, limit)).fetchall()
        return [
            {"question": question, "answer": answer, "attachment_filename": attachment,
             "sources": json.loads(sources), "scope": json.loads(scope)}
            for question, answer, attachment, sources, scope in reversed(rows)
        ]

    def context(self, thread_id, include_library):
        if not thread_id:
            return []
        budget = 12000
        context = []
        for turn in reversed(self.turns(thread_id, limit=8, include_library=include_library)):
            question = turn["question"][:min(2000, budget // 2)]
            answer = turn["answer"][:min(3500, budget - len(question))]
            context.append({**turn, "question": question, "answer": answer})
            budget -= len(question) + len(answer)
            if budget < 1000:
                break
        return list(reversed(context))
