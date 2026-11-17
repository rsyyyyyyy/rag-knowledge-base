"""Run from backend with: python -m unittest discover -s tests -p test_outline.py."""
import json
import sqlite3
import tempfile
from pathlib import Path
from unittest import TestCase

from catalog import Catalog
from outline import build_outline, outline_for_document, parse_heading


class OutlineHeadingTest(TestCase):
    def test_numbered_and_known_headings(self):
        self.assertEqual(parse_heading("Abstract"), ("Abstract", 1))
        self.assertEqual(parse_heading("1 Introduction"), ("1 Introduction", 1))
        self.assertEqual(parse_heading("1.Introduction"), ("1 Introduction", 1))
        self.assertEqual(parse_heading("2.1.MASOverview"), ("2.1 MASOverview", 2))
        self.assertEqual(parse_heading("3.1 Stage1: FeatureMemoryConstruction"), ("3.1 Stage1: FeatureMemoryConstruction", 2))
        self.assertEqual(parse_heading("摘要"), ("摘要", 1))
        self.assertEqual(parse_heading("第一章 绪论"), ("第一章 绪论", 1))

    def test_noise_is_rejected(self):
        self.assertIsNone(parse_heading("6202 yaM 13"))
        self.assertIsNone(parse_heading("1v58310.6062:viXra"))
        self.assertIsNone(parse_heading("ShengdaFan* XuyanYe* YupengHuo"))
        self.assertIsNone(parse_heading("3 view /testbed/django/db/backends SWE-Agent Dev"))
        self.assertIsNone(parse_heading("1 Stakeholders 2 Multi-Agent-as-Judge Debate"))
        self.assertIsNone(parse_heading("CCSConcepts"))

    def test_merged_and_overlong_headings_are_trimmed(self):
        self.assertEqual(
            parse_heading("2 RelatedWork 2.1 SoftwareArchitectureDesign"),
            ("2 RelatedWork", 1),
        )
        self.assertEqual(
            parse_heading("4.2.1 Dataset. TherequirementsdatasetusedinthisstudyisderivedfromJinetal."),
            ("4.2.1 Dataset", 3),
        )

    def test_document_title_is_not_an_outline_entry(self):
        title = "Bridging Requirements and Architecture: Multi-Agent Orchestration"
        self.assertIsNone(parse_heading(title, title))
        self.assertEqual(parse_heading("1 Introduction", title), ("1 Introduction", 1))

    def test_build_outline_keeps_first_page_and_deduplicates(self):
        rows = [
            ("Abstract", 0, 0),
            ("1 Introduction", 0, 1),
            ("1 Introduction", 1, 2),
            ("2 Method", 2, 3),
        ]
        self.assertEqual(build_outline(rows), [
            {"title": "Abstract", "level": 1, "page_index": 0},
            {"title": "1 Introduction", "level": 1, "page_index": 0},
            {"title": "2 Method", "level": 1, "page_index": 2},
        ])


class OutlineDocumentTest(TestCase):
    def test_adds_abstract_when_introduction_is_first(self):
        with tempfile.TemporaryDirectory(prefix="outline-") as directory:
            catalog = Catalog(Path(directory))
            catalog.initialize()
            with catalog.connect() as db, db:
                db.execute("""
                    CREATE TABLE active_indexes (
                        doc_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, generation TEXT NOT NULL
                    )
                """)
                db.execute("""
                    CREATE TABLE indexed_chunks (
                        id TEXT NOT NULL UNIQUE, generation TEXT NOT NULL,
                        doc_id TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL
                    )
                """)
                db.execute("INSERT INTO active_indexes VALUES ('doc_1', 'v1', 'g1')")
                for index, heading in enumerate(("1 Introduction", "2 Method")):
                    metadata = json.dumps({
                        "section_heading": heading, "page_index": index, "chunk_index": index,
                    })
                    db.execute(
                        "INSERT INTO indexed_chunks VALUES (?, 'g1', 'doc_1', ?, ?)",
                        (f"c{index}", heading, metadata),
                    )
            outline = outline_for_document(catalog, "doc_1", "A Paper")
            self.assertEqual(outline[0], {"title": "Abstract", "level": 1, "page_index": 0})
            self.assertEqual(outline[1]["title"], "1 Introduction")
            self.assertEqual(outline[2]["title"], "2 Method")
