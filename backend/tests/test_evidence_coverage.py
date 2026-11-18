import json
from threading import RLock
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from evidence_coverage import EvidenceItem, render_coverage, run_coverage
from test_evidence_grounding import passage


class EvidenceCoverageTest(TestCase):
    def test_invalid_quote_and_unsupported_number_stay_missing_without_duplicate_notices(self):
        source = passage()
        items = [EvidenceItem('item_1', '实验时长', 'duration', 'paper', 'paper.pdf'),
                 EvidenceItem('item_2', '显存', 'GPU memory', 'paper', 'paper.pdf')]
        checks = [
            {'id': 'item_1', 'coverage': 'full', 'facts': [
                {'text': '电池持续 99 小时。', 'passage': 1, 'quote': source['excerpt']},
                {'text': '电池持续 37 小时。', 'passage': 1, 'quote': source['excerpt']},
            ]},
            {'id': 'item_2', 'coverage': 'full', 'facts': [
                {'text': '显存为 16 GB。', 'passage': 1, 'quote': 'The experiment used 16 GB of GPU memory.'},
            ]},
        ]
        create = Mock(return_value=SimpleNamespace(usage=SimpleNamespace(total_tokens=12), choices=[
            SimpleNamespace(finish_reason='stop', message=SimpleNamespace(content=json.dumps({'items': checks})))
        ]))
        registry = SimpleNamespace(search=SimpleNamespace(ingestion=SimpleNamespace(index_lock=RLock())),
            current_versions=lambda: {'paper': ('generation', 'v1')}, read_for_coverage=Mock(return_value=[source]))
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

        result, tokens, report = run_coverage(items, [source], registry, client, 'test', '电池时长与显存')

        self.assertEqual([row['status'] for row in report['items']], ['partial', 'missing'])
        self.assertEqual(tokens, 12)
        create.assert_called_once()  # Re-reading the same evidence does not trigger another model review.
        answer, sources = render_coverage(items, result)
        self.assertNotIn('本轮还未核实', answer)
        self.assertIn('37 小时', answer)
        self.assertNotIn('99 小时', answer)
        self.assertNotIn('16 GB', answer)
        self.assertNotIn('- paper.pdf · 实验时长', answer)
        self.assertNotIn('显存', answer)
        self.assertEqual(sources[0]['excerpt'], source['excerpt'])

    def test_partial_item_keeps_its_verified_fact_and_citation(self):
        item = EvidenceItem('item_1', '实验设置', 'experimental setup', 'paper', 'paper.pdf')
        evidence = {**passage(), 'span_id': 'quote-1'}
        answer, _ = render_coverage([item], {'item_1': {
            'coverage': 'partial', 'facts': [('电池持续 37 小时。', evidence)],
        }})
        self.assertNotIn('未核实', answer)
        self.assertIn('[1](#evidence-1)', answer)
