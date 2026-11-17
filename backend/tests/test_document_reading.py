import re
import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from document_reading import prepare_full_context, packs


def source(n, text):
    return {'id': 'paper', 'filename': 'paper.pdf', 'citation_number': n,
            'excerpt': text, 'page_index': n - 1, 'chunk_id': str(n), 'rects': [[1, 2, 3, 4]]}


class FullDocumentReadingTest(TestCase):
    def test_short_document_includes_end_without_model_call(self):
        sources = [source(1, 'Introduction'), source(2, 'The final result is 73.')]
        client = Mock()
        text, usage, report = prepare_full_context(sources, 'result?', client, 'test')
        self.assertIn('73', text)
        self.assertIn('【2 paper.pdf', text)
        self.assertEqual(report['chunks_read'], 2)
        self.assertEqual(usage, 0)
        client.chat.completions.create.assert_not_called()

    def test_long_document_reads_every_chunk_and_preserves_original_ids(self):
        sources = [source(i, ('正文内容 ' * 150) + f' unique-marker-{i}') for i in range(1, 25)]
        client = Mock()
        def reduce(**kwargs):
            batch = kwargs['messages'][-1]['content']
            numbers = list(dict.fromkeys(re.findall(r'【(\d+) ', batch)))
            note = json.dumps({'notes': [{'text': 'fact', 'sources': [int(n)]} for n in numbers]})
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=note),
                                                            finish_reason='stop')],
                                   usage=SimpleNamespace(total_tokens=11))
        client.chat.completions.create.side_effect = reduce
        text, usage, report = prepare_full_context(sources, 'overview', client, 'test', budget=4096)
        batches = '\n'.join(c.kwargs['messages'][-1]['content'] for c in client.chat.completions.create.call_args_list)
        for i in range(1, 25):
            self.assertIn(f'unique-marker-{i}', batches)
            self.assertIn(f'(#evidence-{i})', text)
        self.assertLessEqual(len(text.encode('utf-8')), 4096)
        self.assertEqual(report['chunks_read'], 24)
        self.assertEqual(usage, 11 * report['model_calls'])
        self.assertEqual(sources[-1]['rects'], [[1, 2, 3, 4]])

    def test_oversized_passage_keeps_source_label_and_tail(self):
        text = '【17 paper.pdf】\n' + '中' * 6000 + 'TAIL'
        batches = list(packs([text], 4096))
        self.assertGreater(len(batches), 1)
        self.assertTrue(all('【17 paper.pdf】' in batch for batch in batches))
        self.assertTrue(all(len(batch.encode('utf-8')) <= 4096 for batch in batches))
        self.assertIn('TAIL', batches[-1])

    def test_invalid_reduction_citation_fails_instead_of_faking_coverage(self):
        client = Mock()
        client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({'notes':[{'text':'wrong', 'sources':[999]}]})),
                                     finish_reason='stop')], usage=None)
        with self.assertRaisesRegex(ValueError, '有效原文引用'):
            prepare_full_context([source(1, 'X' * 9000)], 'overview', client, 'test', budget=4096)
