"""Run from backend with: python -m unittest discover -s tests -p test_metadata.py."""
import io
from unittest import TestCase
from unittest.mock import patch

import metadata_enrichment
from metadata_enrichment import (
    build_metadata_updates,
    extract_pdf_metadata,
    normalize_doi,
    title_similarity,
)


def make_pdf(text, title=None):
    from PyPDF2 import PdfWriter
    from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    writer.add_blank_page(540, 700)
    page = writer.pages[-1]
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
    })
    content = DecodedStreamObject()
    content.set_data(f"BT /F1 12 Tf 70 560 Td ({text}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(content)
    if title:
        writer.add_metadata({"/Title": title})
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class MetadataEnrichmentTest(TestCase):
    def test_normalize_doi_accepts_urls_prefixes_and_trailing_punctuation(self):
        self.assertEqual(normalize_doi("https://doi.org/10.1234/ABC.1"), "10.1234/abc.1")
        self.assertEqual(normalize_doi("doi: 10.1234/abc.1."), "10.1234/abc.1")
        self.assertEqual(normalize_doi("not a doi"), "")

    def test_title_similarity_ignores_punctuation_and_case(self):
        self.assertGreater(
            title_similarity("Attention Is All You Need!", "attention is all you need"),
            0.99,
        )
        self.assertLess(title_similarity("A Study of Retrieval", "Unrelated Paper"), 0.5)

    def test_extract_pdf_metadata_reads_title_and_doi(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory(prefix="metadata-pdf-") as directory:
            path = Path(directory) / "paper.pdf"
            path.write_bytes(make_pdf("doi: 10.1234/example.2024", title="A Useful Paper"))
            metadata = extract_pdf_metadata(path)
        self.assertEqual(metadata["title"], "A Useful Paper")
        self.assertEqual(metadata["doi"], "10.1234/example.2024")

    @patch.object(metadata_enrichment, "lookup_openalex")
    @patch.object(metadata_enrichment, "lookup_crossref")
    @patch.object(metadata_enrichment, "extract_pdf_metadata")
    def test_fills_only_missing_fields_from_sources(self, pdf, crossref, openalex):
        pdf.return_value = {"doi": "10.1234/example"}
        crossref.return_value = {
            "title": "A Study", "authors": ["Ada Lovelace"], "year": 2024,
            "venue": "Journal of Tests", "doi": "10.1234/example",
        }
        openalex.return_value = {"citation_count": 12, "abstract": "An abstract"}
        updates = build_metadata_updates({"filename": "paper.pdf"}, None)
        self.assertEqual(updates["doi"], "10.1234/example")
        self.assertEqual(updates["title"], "A Study")
        self.assertEqual(updates["authors"], ["Ada Lovelace"])
        self.assertEqual(updates["author"], "Ada Lovelace")
        self.assertEqual(updates["year"], 2024)
        self.assertEqual(updates["venue"], "Journal of Tests")
        self.assertEqual(updates["citation_count"], 12)
        self.assertIn("crossref", updates["metadata_source"])
        self.assertIn("metadata_checked_at", updates)

    @patch.object(metadata_enrichment, "lookup_openalex", return_value={})
    @patch.object(metadata_enrichment, "lookup_crossref", return_value={})
    @patch.object(metadata_enrichment, "extract_pdf_metadata", return_value={})
    def test_does_not_overwrite_existing_values(self, _pdf, _crossref, _openalex):
        existing = {
            "filename": "paper.pdf", "title": "My Title", "authors": ["Me"],
            "year": 2020, "venue": "My Venue", "doi": "10.1234/mine",
        }
        updates = build_metadata_updates(existing, None)
        for key in ("title", "authors", "author", "year", "venue", "doi"):
            self.assertNotIn(key, updates)
        self.assertIn("metadata_checked_at", updates)

    @patch.object(metadata_enrichment, "lookup_openalex")
    @patch.object(metadata_enrichment, "lookup_crossref")
    @patch.object(metadata_enrichment, "extract_pdf_metadata", return_value={})
    def test_overwrite_replaces_existing_values(self, _pdf, crossref, openalex):
        crossref.return_value = {"title": "New Title", "year": 2025}
        openalex.return_value = {"venue": "New Venue"}
        updates = build_metadata_updates(
            {"filename": "paper.pdf", "title": "Old", "year": 2000, "doi": "10.1234/mine"},
            None, overwrite=True,
        )
        self.assertEqual(updates["title"], "New Title")
        self.assertEqual(updates["year"], 2025)
        self.assertEqual(updates["venue"], "New Venue")

    @patch.object(metadata_enrichment, "lookup_openalex")
    @patch.object(metadata_enrichment, "lookup_crossref", return_value={})
    @patch.object(metadata_enrichment, "extract_pdf_metadata")
    def test_unresolved_pdf_doi_falls_back_to_title_search(self, pdf, _crossref, openalex):
        pdf.return_value = {
            "doi": "10.1145/3770855.3817494ccs", "title": "AgentProcessBench",
        }
        openalex.side_effect = [
            {},
            {"title": "AgentProcessBench", "doi": "10.1145/3770855.3817494", "year": 2025},
        ]
        updates = build_metadata_updates({"filename": "AgentProcessBench.pdf"}, None)
        self.assertEqual(updates["doi"], "10.1145/3770855.3817494")
        self.assertEqual(updates["year"], 2025)

    @patch.object(metadata_enrichment, "lookup_openalex")
    @patch.object(metadata_enrichment, "lookup_crossref", return_value={})
    @patch.object(metadata_enrichment, "extract_pdf_metadata")
    def test_placeholder_doi_is_ignored(self, pdf, crossref, openalex):
        pdf.return_value = {"doi": "10.1145/nnnnnnn.nnnnnnn", "title": "A Real Title"}
        openalex.return_value = {"title": "A Real Title", "doi": "10.1145/real.1"}
        updates = build_metadata_updates({"filename": "paper.pdf"}, None)
        self.assertEqual(updates["doi"], "10.1145/real.1")
        crossref.assert_not_called()

    @patch.object(metadata_enrichment, "_get_json")
    def test_openalex_accepts_short_filename_prefix(self, get_json):
        get_json.return_value = {"results": [{
            "title": "Multi-Agent-as-Judge: Aligning LLM-Agent-Based Automated Evaluation",
            "publication_year": 2026,
            "doi": "https://doi.org/10.18653/v1/2026.acl-long.790",
            "authorships": [{"author": {"display_name": "A. Author"}}],
            "primary_location": {"source": {"display_name": "ACL"}},
            "cited_by_count": 5,
        }]}
        result = metadata_enrichment.lookup_openalex(title="Multi-Agent as Judge")
        self.assertEqual(result["year"], 2026)
        self.assertEqual(result["doi"], "10.18653/v1/2026.acl-long.790")
        self.assertEqual(result["authors"], ["A. Author"])
