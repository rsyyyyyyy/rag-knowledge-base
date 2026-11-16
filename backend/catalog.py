import json
import sqlite3
from contextlib import closing
from functools import lru_cache
from pathlib import Path


class Catalog:
    """SQLite storage for the existing document and folder API records."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.path = directory / "library.sqlite3"

    def connect(self):
        return closing(sqlite3.connect(self.path))

    @lru_cache(maxsize=1)
    def initialize(self):
        with self.connect() as connection, connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS catalog_records (
                    kind TEXT NOT NULL CHECK(kind IN ('documents', 'folders')),
                    position INTEGER NOT NULL,
                    id TEXT NOT NULL,
                    metadata TEXT NOT NULL,
                    PRIMARY KEY (kind, id)
                )
            """)
            connection.execute("""
                CREATE TABLE IF NOT EXISTS catalog_migrations (
                    name TEXT PRIMARY KEY
                )
            """)
            migrated = connection.execute(
                "SELECT 1 FROM catalog_migrations WHERE name = 'legacy_json'"
            ).fetchone()
            if migrated:
                return

            for kind in ("documents", "folders"):
                source = self.directory / f"{kind}.json"
                if source.exists():
                    records = json.loads(source.read_text(encoding="utf-8-sig"))
                    if not isinstance(records, list):
                        raise ValueError(f"Invalid catalog format in {source}")
                    self._insert_records(connection, kind, records)
            connection.execute("INSERT INTO catalog_migrations VALUES ('legacy_json')")

    @staticmethod
    def _insert_records(connection, kind, records):
        connection.executemany(
            "INSERT INTO catalog_records (kind, position, id, metadata) VALUES (?, ?, ?, ?)",
            (
                (kind, position, record["id"], json.dumps(record, ensure_ascii=False))
                for position, record in enumerate(records)
            ),
        )

    def load(self, kind):
        self.initialize()
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT metadata FROM catalog_records WHERE kind = ? ORDER BY position", (kind,),
            )
            return [json.loads(row[0]) for row in rows]

    def save(self, kind, records):
        self.initialize()
        with self.connect() as connection, connection:
            connection.execute("DELETE FROM catalog_records WHERE kind = ?", (kind,))
            self._insert_records(connection, kind, records)
