"""Versioned sections point to existing passages without rewriting their evidence."""
import hashlib
import json

from outline import parse_heading


STRUCTURE_VERSION = "document-sections-v1"


def build_sections(doc_id, version_id, generation, records):
    sections, assignments, stack = [], [], []
    parser_versions = sorted({str(meta.get("parser_version") or "legacy") for _, _, meta in records})
    parser_key = ",".join(parser_versions)
    for position, (chunk_id, _, metadata) in enumerate(records):
        parsed = parse_heading(metadata.get("section_heading"))
        title, level = parsed if parsed else ("正文", 1)
        if not stack or (parsed and (title, level) != (stack[-1]["title"], stack[-1]["level"])):
            while stack and stack[-1]["level"] >= level:
                stack.pop()
            identity = json.dumps(
                [STRUCTURE_VERSION, doc_id, version_id, parser_key, position, title],
                ensure_ascii=False,
            )
            section = {
                "id": "section_" + hashlib.sha256(identity.encode()).hexdigest()[:24],
                "document_id": doc_id, "version_id": version_id, "generation": generation,
                "parent_id": stack[-1]["id"] if stack else None,
                "title": title, "level": level, "position": len(sections),
                "start_position": position, "end_position": position,
                "page_start": None, "page_end": None,
                "heading_detected": bool(parsed),
            }
            sections.append(section)
            stack.append(section)
        page = metadata.get("page_index")
        for section in stack:
            section["end_position"] = position
            if type(page) is int and page >= 0:
                section["page_start"] = page if section["page_start"] is None else min(section["page_start"], page)
                section["page_end"] = page if section["page_end"] is None else max(section["page_end"], page)
        assignments.append((stack[-1]["id"], chunk_id, generation, position))
    return sections, assignments, parser_versions


def replace_sections(db, doc_id, version_id, generation, records):
    sections, assignments, parser_versions = build_sections(doc_id, version_id, generation, records)
    db.execute(
        "DELETE FROM section_passages WHERE section_id IN (SELECT id FROM document_sections WHERE doc_id = ?)",
        (doc_id,),
    )
    db.execute("DELETE FROM document_sections WHERE doc_id = ?", (doc_id,))
    db.execute("DELETE FROM section_index_versions WHERE doc_id = ?", (doc_id,))
    db.executemany("""
        INSERT INTO document_sections (
            id, doc_id, version_id, generation, parent_id, title, level, position,
            start_position, end_position, page_start, page_end, heading_detected
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, [
        (s["id"], doc_id, version_id, generation, s["parent_id"], s["title"], s["level"],
         s["position"], s["start_position"], s["end_position"], s["page_start"],
         s["page_end"], int(s["heading_detected"]))
        for s in sections
    ])
    db.executemany("INSERT INTO section_passages VALUES (?, ?, ?, ?)", assignments)
    db.execute(
        "INSERT INTO section_index_versions VALUES (?, ?, ?, ?, ?, ?)",
        (generation, doc_id, version_id, STRUCTURE_VERSION, len(records), json.dumps(parser_versions)),
    )


def initialize_structure(db):
    # Execute DDL individually so the caller's migration transaction stays intact.
    statements = [
        """CREATE TABLE IF NOT EXISTS document_sections (
            id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, version_id TEXT NOT NULL,
            generation TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL,
            level INTEGER NOT NULL, position INTEGER NOT NULL,
            start_position INTEGER NOT NULL, end_position INTEGER NOT NULL,
            page_start INTEGER, page_end INTEGER, heading_detected INTEGER NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS document_sections_generation ON document_sections(generation, position)",
        """CREATE TABLE IF NOT EXISTS section_passages (
            section_id TEXT NOT NULL, chunk_id TEXT PRIMARY KEY,
            generation TEXT NOT NULL, position INTEGER NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS section_passages_section ON section_passages(section_id, position)",
        "CREATE INDEX IF NOT EXISTS section_passages_generation ON section_passages(generation, position)",
        """CREATE TABLE IF NOT EXISTS section_index_versions (
            generation TEXT PRIMARY KEY, doc_id TEXT NOT NULL, version_id TEXT NOT NULL,
            structure_version TEXT NOT NULL, chunk_count INTEGER NOT NULL, parser_versions TEXT NOT NULL
        )""",
    ]
    for statement in statements:
        db.execute(statement)
    for doc_id, version_id, generation in db.execute(
        "SELECT doc_id, version_id, generation FROM active_indexes"
    ).fetchall():
        saved = db.execute(
            "SELECT structure_version, chunk_count FROM section_index_versions WHERE generation = ?",
            (generation,),
        ).fetchone()
        count = db.execute(
            "SELECT count(*) FROM indexed_chunks WHERE generation = ?", (generation,),
        ).fetchone()[0]
        if saved == (STRUCTURE_VERSION, count):
            continue
        rows = db.execute("""
            SELECT id, content, metadata FROM indexed_chunks WHERE generation = ?
            ORDER BY CAST(json_extract(metadata, '$.chunk_index') AS INTEGER), rowid
        """, (generation,)).fetchall()
        records = [(chunk_id, content, json.loads(metadata)) for chunk_id, content, metadata in rows]
        replace_sections(db, doc_id, version_id, generation, records)
