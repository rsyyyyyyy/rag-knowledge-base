import json
from types import SimpleNamespace as NS
from unittest import TestCase
from unittest.mock import Mock

from paper_reranking import rerank_papers


class PaperRerankingTest(TestCase):
    def setUp(self):
        self.papers = [dict(document_id=id_, title=id_, matched_notes=[], body_previews=[])
                       for id_ in ['target', 'irrelevant']]
        self.create = Mock()
        self.client = NS(chat=NS(completions=NS(create=self.create)))

    def reply(self, ranked):
        return NS(usage=NS(total_tokens=12), choices=[NS(finish_reason='stop',
            message=NS(content=json.dumps({'ranked': ranked})))])

    def test_review_can_remove_all_irrelevant_candidates(self):
        self.create.return_value = self.reply([])
        papers, tokens = rerank_papers('a different research subject', self.papers, self.client, 'fixture', 5)
        self.assertEqual(papers, [])
        self.assertEqual(tokens, 12)

    def test_preserves_original_evidence_and_relevance_label(self):
        self.create.return_value = self.reply([{'document_id': 'target', 'relevance': 'possible'}])
        result, _ = rerank_papers('query', self.papers, self.client, 'fixture', 5)
        self.assertEqual(result[0], {**self.papers[0], 'relevance': 'possible'})

    def test_invented_duplicate_or_excess_ids_are_rejected_with_bounded_retry(self):
        for ids in [[{'document_id': 'invented', 'relevance': 'direct'}],
                    [{'document_id': 'target', 'relevance': 'direct'}] * 2]:
            with self.subTest(ids=ids):
                self.create.reset_mock()
                self.create.return_value = self.reply(ids)
                with self.assertRaises(ValueError):
                    rerank_papers('query', self.papers, self.client, 'fixture', 1)
                self.assertEqual(self.create.call_count, 2)
