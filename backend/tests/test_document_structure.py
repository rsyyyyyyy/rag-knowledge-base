import json
import tempfile
from pathlib import Path
from threading import RLock
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from catalog import Catalog
from document_structure import build_sections
from ingest_store import IngestStore
from knowledge_search import KnowledgeScope, KnowledgeSearchService, SectionReadRequest


def passages():
    headings = ["Abstract", "1 Introduction", "2 Method", "2.1 Training",
                "2.1 Training", "2.2 Evaluation", "3 Results"]
    pages = [0, 0, 1, 1, 2, 2, 3]
    return [
        (f"c{i}", f"Original passage {i}.", {
            "chunk_index": i, "section_heading": heading, "page_index": pages[i],
            "version_id": "v1", "parser_version": "paragraph-spans-v3",
            "elements_json": json.dumps([{"id": f"p{i}:e0", "kind": "paragraph",
                                         "start": 0, "end": len(f"Original passage {i}.")}]),
            "rects_json": "[[0.1,0.2,0.5,0.3]]",
            "source_map_json": '[{"start":0,"end":19,"rect":[0.1,0.2,0.5,0.3]}]',
        })
        for i, heading in enumerate(headings)
    ]


class DocumentStructureTest(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.original = root / "paper.pdf"
        self.original.write_bytes(b"original PDF fixture")
        self.catalog = Catalog(root)
        self.catalog.initialize()
        self.catalog.save("documents", [{"id": "paper", "metadata": {"filename": "paper.pdf"}}])
        self.store = IngestStore(self.catalog)
        self.store.initialize()
        self.store.adopt_legacy("paper", "v1", self.original, "g1", passages(), False)
        self.service = KnowledgeSearchService(SimpleNamespace(store=self.store, index_lock=RLock()))
        self.session = self.service.session(KnowledgeScope(document_ids=["paper"]))

    def test_nested_ranges_and_stable_versioned_ids(self):
        sections, assignments, _ = build_sections("paper", "v1", "g1", passages())
        by_title = {s["title"]: s for s in sections}
        method = by_title["2 Method"]
        training = by_title["2.1 Training"]
        self.assertEqual(training["parent_id"], method["id"])
        self.assertEqual((method["start_position"], method["end_position"]), (2, 5))
        self.assertEqual((training["page_start"], training["page_end"]), (1, 2))
        self.assertEqual(len(assignments), len(passages()))
        repeated, _, _ = build_sections("paper", "v1", "another-generation", passages())
        changed, _, _ = build_sections("paper", "v2", "g2", passages())
        self.assertEqual([s["id"] for s in sections], [s["id"] for s in repeated])
        self.assertTrue(set(s["id"] for s in sections).isdisjoint(s["id"] for s in changed))

    def test_section_reading_includes_children_and_preserves_evidence(self):
        structure = self.session.list_sections("paper", "v1")
        method = next(s for s in structure["sections"] if s["title"] == "2 Method")
        request = SectionReadRequest(
            document_id="paper", document_ids=["paper"], section_id=method["id"],
            version_id="v1", generation="g1", limit=2,
        )
        first = self.session.read_section(request)
        second = self.session.read_section(request.model_copy(update={"offset": first["next_offset"]}))
        self.assertEqual([s["chunk_id"] for s in first["evidence"] + second["evidence"]],
                         ["c2", "c3", "c4", "c5"])
        self.assertIsNone(second["next_offset"])
        evidence = first["evidence"][0]
        self.assertEqual(evidence["excerpt"], "Original passage 2.")
        self.assertEqual(evidence["rects"], [[0.1, 0.2, 0.5, 0.3]])
        self.assertEqual(evidence["elements"][0]["id"], "p2:e0")
        self.assertEqual(evidence["section_id"], method["id"])
        self.assertEqual(evidence["document_version_id"], "v1")

    def test_legacy_backfill_is_idempotent_and_does_not_change_passages(self):
        with self.catalog.connect() as db, db:
            before = db.execute("SELECT id, content, metadata FROM indexed_chunks ORDER BY id").fetchall()
            db.execute("DELETE FROM section_passages")
            db.execute("DELETE FROM document_sections")
            db.execute("DELETE FROM section_index_versions")
        self.store.initialize()
        first_ids = [s["id"] for s in self.session.list_sections("paper")["sections"]]
        self.store.initialize()
        self.assertEqual(first_ids, [s["id"] for s in self.session.list_sections("paper")["sections"]])
        with self.catalog.connect() as db:
            self.assertEqual(before, db.execute("SELECT id, content, metadata FROM indexed_chunks ORDER BY id").fetchall())
        self.assertEqual(self.original.read_bytes(), b"original PDF fixture")

    def test_scope_and_retired_generation_are_checked(self):
        structure = self.session.list_sections("paper")
        section_id = structure["sections"][0]["id"]
        request = SectionReadRequest(document_id="paper", section_id=section_id, generation="g1")
        other = self.service.session(KnowledgeScope(document_ids=["other"]))
        self.assertIsNone(other.list_sections("paper"))
        self.assertIsNone(other.read_section(request))
        with self.assertRaises(ValueError):
            self.session.list_sections("paper", "retired-version")
        with self.assertRaises(ValueError):
            self.session.read_section(request.model_copy(update={"generation": "retired-generation"}))

    def test_failed_publication_rolls_back_chunks_and_structure(self):
        job_id = self.store.enqueue({"id": "paper"}, "v2", self.original)
        self.store.claim()
        with patch("ingest_store.replace_sections", side_effect=RuntimeError("publication failure")):
            with self.assertRaises(RuntimeError):
                self.store.publish("paper", "v2", job_id, [("replacement", "New text", {})], ["new text"])
        self.assertEqual(self.session.list_sections("paper")["generation"], "g1")
        self.assertEqual(self.session.read_passage("c0")[0]["excerpt"], "Original passage 0.")
        with self.catalog.connect() as db:
            self.assertIsNone(db.execute("SELECT id FROM indexed_chunks WHERE id='replacement'").fetchone())

    def test_plain_text_has_an_explicit_fallback_and_removal_cleans_structure(self):
        sections, _, _ = build_sections("text", "v1", "g", [("plain", "Text", {})])
        self.assertEqual(sections[0]["title"], "正文")
        self.assertFalse(sections[0]["heading_detected"])
        self.assertIsNone(sections[0]["page_start"])
        self.store.remove(["paper"])
        with self.catalog.connect() as db:
            for table in ["document_sections", "section_passages", "section_index_versions"]:
                self.assertEqual(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], 0)
