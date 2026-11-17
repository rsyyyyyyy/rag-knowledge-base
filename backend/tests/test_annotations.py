"""Run from backend with: python -m unittest discover -s tests -p test_annotations.py."""
import tempfile
from pathlib import Path
from unittest import TestCase

from annotations import AnnotationStore
from catalog import Catalog


class AnnotationStoreTest(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="annotations-")
        self.addCleanup(self.directory.cleanup)
        self.catalog = Catalog(Path(self.directory.name))
        self.catalog.initialize()
        self.store = AnnotationStore(self.catalog)
        self.store.initialize()

    def test_create_list_update_and_delete(self):
        created = self.store.create(
            "doc_1", "v1", 2, "highlight", "#facc15",
            [[0.1, 0.2, 0.4, 0.25]], "selected text", "first note",
        )
        self.assertEqual(created["page_index"], 2)
        self.assertEqual(created["rects"], [[0.1, 0.2, 0.4, 0.25]])
        self.assertEqual(self.store.list("doc_1", "v1"), [created])
        self.assertEqual(self.store.list("doc_1", "v2"), [])

        updated = self.store.update("doc_1", created["id"], note="edited note")
        self.assertEqual(updated["note"], "edited note")
        self.assertEqual(updated["kind"], "highlight")

        self.assertTrue(self.store.delete("doc_1", created["id"]))
        self.assertEqual(self.store.list("doc_1", "v1"), [])
        self.assertFalse(self.store.delete("doc_1", created["id"]))

    def test_update_and_delete_are_scoped_to_the_document(self):
        created = self.store.create(
            "doc_1", "v1", 0, "underline", "#2563eb", [[0.2, 0.2, 0.6, 0.22]], "", "",
        )
        self.assertIsNone(self.store.update("doc_2", created["id"], note="x"))
        self.assertFalse(self.store.delete("doc_2", created["id"]))
        self.assertEqual(self.store.list("doc_1", "v1")[0]["id"], created["id"])
