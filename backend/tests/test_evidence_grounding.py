import hashlib
import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from evidence_grounding import (
    clean_generated_references, deduplicate_citation_groups, ground_answer,
    normalize_citation_markers, quote_span,
)


def passage(text='The battery lasted 37 hours under controlled conditions.', number=8):
    return {'id':'paper', 'filename':'paper.pdf', 'citation_number':number, 'chunk_id':'chunk',
            'document_version_id':'v1', 'version_id':'v1', 'page_index':2,
            'text_sha256':hashlib.sha256(text.encode()).hexdigest(), 'excerpt':text,
            'rects':[(.1,.2,.9,.3)], 'elements':[{'id':'paragraph-1','start':0,'end':len(text)}],
            'source_map':[{'start':0,'end':len(text),'rect':(.1,.2,.9,.3), 'words':[
                {'start':19,'end':21,'rect':(.3,.2,.35,.3),'mapped':True},
                {'start':22,'end':27,'rect':(.36,.2,.45,.3),'mapped':True}]}]}


def response(checks):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({'checks':checks})),
                                                    finish_reason='stop')], usage=SimpleNamespace(total_tokens=13))


class EvidenceGroundingTest(TestCase):
    def test_plain_citation_markers_are_normalized_before_grounding(self):
        original = 'Result【8】[ID:9]. `[8]` [8](https://example.test) [10]'
        self.assertEqual(
            normalize_citation_markers(original, {8, 9}),
            'Result[8](#evidence-8)[9](#evidence-9). `[8]` [8](https://example.test) [10]',
        )

    def test_generated_html_reference_list_is_removed_but_inline_links_remain(self):
        answer='A fact [8](#evidence-8).\n\n<a id="evidence-8"></a>[8] paper.pdf'
        self.assertEqual(clean_generated_references(answer),'A fact [8](#evidence-8).')

    def test_verified_quote_gets_stable_span_and_dense_number(self):
        source = passage()
        answer = 'Battery duration was 37 hours. [8](paper.pdf#evidence-8)'
        client = Mock()
        client.chat.completions.create.return_value = response([
            {'ref':'0','supported':True,'claim':'Battery duration was 37 hours.',
             'passage':1,'quote':'The battery lasted 37 hours under controlled conditions.'}])
        text, sources, tokens, audit = ground_answer(answer,[source],'duration?',client,'test')
        self.assertIn('[1](#evidence-1)',text)
        self.assertEqual(sources[0]['element_refs'], ['paragraph-1'])
        self.assertEqual(sources[0]['span_id'], quote_span(source,source['excerpt'])['span_id'])
        self.assertEqual(sources[0]['page_index'],2)
        self.assertNotIn('source_map',sources[0])
        self.assertEqual(tokens,13)
        self.assertEqual(audit['verified'],1)

    def test_fake_quotes_unsupported_facts_and_wrong_numbers_do_not_get_links(self):
        for check in (
            {'supported':False},
            {'supported':True,'claim':'It lasted 99 hours.','quote':'It lasted 99 hours.','passage':1},
            {'supported':True,'claim':'It lasted 99 hours.','quote':passage()['excerpt'],'passage':1},
            {'supported':True,'claim':'It lasted 99 hours.','quote':passage()['excerpt'],'passage':999},
        ):
            client=Mock()
            client.chat.completions.create.return_value=response([{'ref':'0',**check}])
            text,sources,_,audit=ground_answer('It lasted 99 hours. [8](#evidence-8)',[passage()],
                                               'duration?',client,'test')
            self.assertEqual(sources,[])
            self.assertNotIn('#evidence-',text)
            self.assertEqual(text, '')
            self.assertNotIn('99 hours',text)
            self.assertEqual(audit['verified'],0)

    def test_ambiguous_quotes_and_wrong_document_versions_are_rejected(self):
        self.assertIsNone(quote_span(passage('A repeated sentence. A repeated sentence.'),'A repeated sentence.'))
        self.assertIsNone(quote_span({**passage(),'document_version_id':'v2'},'The battery lasted 37 hours'))
        self.assertIsNone(quote_span({**passage(),'text_sha256':'tampered'},'The battery lasted 37 hours'))

    def test_pdf_spacing_and_wrapped_words_keep_original_offsets(self):
        raw = 'Results. Wecalculateinter-raterreliabilityusingKrip-\npendorff’sAlpha. End.'
        quote = "We calculate inter-rater reliability using Krippendorff's Alpha."
        span = quote_span(passage(raw), quote)
        self.assertIsNotNone(span)
        self.assertEqual(span['excerpt'], raw[span['excerpt_start']:span['excerpt_end']])
        self.assertEqual(span['excerpt'], raw[9:-5])
        self.assertIsNone(quote_span(passage(raw), quote.replace('Alpha', 'Beta')))
        self.assertIsNone(quote_span(passage(raw + raw), quote))
        self.assertIsNone(quote_span(passage('Sample results showanaccuracyof3 7 percent.'),
                                     'Sample results show an accuracy of 37 percent.'))

    def test_neighbor_can_supply_evidence_and_duplicate_citations_merge(self):
        source=passage('This passage describes experiment setup.')
        neighbor=passage()
        neighbor['chunk_id']='neighbor'
        client=Mock()
        client.chat.completions.create.return_value=response([
            {'ref':'0','supported':True,'claim':'It lasted 37 hours.', 'quote':neighbor['excerpt'],'passage':2}])
        text,sources,_,audit=ground_answer('It lasted 37 hours. [8](#evidence-8) [8](#evidence-8)',
            [source],'duration?',client,'test',lambda _: [source,neighbor])
        self.assertEqual(len(sources),1)
        self.assertEqual(sources[0]['chunk_id'],'neighbor')
        self.assertEqual(text.count('[1](#evidence-1)'),1)
        self.assertEqual(audit['verified'],2)

    def test_citation_can_repeat_for_a_different_statement(self):
        first = '[1](#evidence-1)'
        second = '[2](#evidence-2)'
        self.assertEqual(
            deduplicate_citation_groups(f'A {first} {second}{first}。 B {first}。'),
            f'A {first} {second}。 B {first}。',
        )

    def test_missing_evidence_triggers_one_directed_read(self):
        original=passage('The introduction describes our experiment.')
        result=passage()
        result['chunk_id']='results'
        client=Mock()
        client.chat.completions.create.side_effect=[response([{'ref':'0','supported':False}]),response([
            {'ref':'0','supported':True,'claim':'It lasted 37 hours.', 'quote':result['excerpt'],'passage':2}])]
        repair=Mock(return_value=[result])
        _,sources,_,audit=ground_answer('It lasted 37 hours. [8](#evidence-8)',[original],
                                       'duration?',client,'test',repair=repair)
        repair.assert_called_once()
        self.assertEqual(sources[0]['chunk_id'],'results')
        self.assertEqual(audit['supplemental_reads'],1)

    def test_unverified_statements_do_not_leave_repeated_notices_or_periods(self):
        client = Mock()
        client.chat.completions.create.return_value = response([
            {'ref':'0','supported':False}, {'ref':'1','supported':False},
        ])
        answer = '电池持续 99 小时 [8](#evidence-8)。\n\n电池持续 88 小时 [8](#evidence-8)。'
        text, sources, _, _ = ground_answer(answer, [passage()], 'duration?', client, 'test')
        self.assertEqual(text, '')
        self.assertEqual(sources, [])

    def test_reused_number_is_checked_separately_for_different_assertions(self):
        client=Mock()
        client.chat.completions.create.return_value=response([
            {'ref':'0','supported':True,'claim':'It lasted 37 hours.', 'quote':passage()['excerpt'],'passage':1},
            {'ref':'1','supported':False}])
        text,sources,_,audit=ground_answer('It lasted 37 hours. [8](#evidence-8) It lasted 99 hours. [8](#evidence-8)',
                                           [passage()],'duration?',client,'test')
        self.assertEqual(len(sources),1)
        self.assertEqual(text.count('#evidence-'),1)
        self.assertNotIn('依据不足',text)
        self.assertNotIn('99 hours',text)
        self.assertEqual(audit['verified'],1)

    def test_redundant_unsupported_reference_does_not_discredit_verified_claim(self):
        unrelated=passage('The introduction discusses another topic.',9)
        unrelated['chunk_id']='unrelated'
        client=Mock()
        client.chat.completions.create.return_value=response([
            {'ref':'0','supported':True,'claim':'It lasted 37 hours.', 'quote':passage()['excerpt'],'passage':1},
            {'ref':'1','supported':False}])
        text,sources,_,_=ground_answer('It lasted 37 hours. [8](#evidence-8) [9](#evidence-9)',
                                      [passage(),unrelated],'duration?',client,'test')
        self.assertEqual(len(sources),1)
        self.assertIn('37 hours',text)
        self.assertNotIn('依据不足',text)
        self.assertEqual(text.count('#evidence-'),1)

    def test_unknown_citation_omits_the_claim_and_marker(self):
        client = Mock()
        text, sources, _, audit = ground_answer('- 该实验持续 99 小时 [9](#evidence-9)。',
                                                [passage()], 'duration?', client, 'test')
        self.assertEqual(text, '')
        self.assertEqual(sources, [])
        self.assertEqual(audit['unsupported'], 1)
        client.chat.completions.create.assert_not_called()

    def test_repair_cannot_silently_change_document_or_version(self):
        for changed in ({'id':'different-paper'}, {'version_id':'v2','document_version_id':'v2'}):
            foreign={**passage(),**changed}
            client=Mock()
            client.chat.completions.create.return_value=response([
                {'ref':'0','supported':True,'claim':'It lasted 37 hours.', 'quote':foreign['excerpt'],'passage':1}])
            _,sources,_,_=ground_answer('It lasted 37 hours. [8](#evidence-8)',[passage()],
                                       'duration?',client,'test',expand=lambda _: [foreign])
            self.assertEqual(sources,[])
