import json
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from catalog import Catalog
from document_profiles import DocumentProfiles, FACETS, parse_notes
from ingest_store import IngestStore
from knowledge_search import KnowledgeScope, KnowledgeSearchService
from test_document_structure import passages


class DocumentProfilesTest(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.original = root / 'paper.pdf'
        self.original.write_bytes(b'original fixture')
        self.catalog = Catalog(root)
        self.catalog.initialize()
        self.catalog.save('documents', [{'id': 'paper', 'metadata': {'filename': 'paper.pdf'}}])
        self.store = IngestStore(self.catalog)
        self.store.initialize()
        self.store.adopt_legacy('paper', 'v1', self.original, 'g1', passages(), False)
        self.search = KnowledgeSearchService(SimpleNamespace(store=self.store, index_lock=RLock()))
        self.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=Mock(side_effect=self.respond))))

        @contextmanager
        def client_factory():
            yield self.client

        self.profiles = DocumentProfiles(self.search, client_factory, 'fixture-model', str)
        self.jobs = self.profiles.store

    def respond(self, **kwargs):
        material = kwargs['messages'][1]['content']
        if kwargs['messages'][0]['content'].startswith('你在复核文献阅读笔记'):
            payload = {'accepted_ids': [n['id'] for n in json.loads(material)]}
        elif kwargs['messages'][0]['content'].startswith('你在整理论文卡片'):
            candidates = json.loads(material)
            payload = {'fields': {facet: [n['id'] for n in candidates if n['facet'] == facet][:2]
                                  for facet in FACETS}}
        else:
            payload = {'notes': [dict(facet='methodology', text='概括原文内容',
                                     sources=[dict(number=int(number), quote=quote)])
                                  for number, quote in re.findall(r'【(\d+) [^\n]*】\n(Original passage \d+\.)', material)]}
        return SimpleNamespace(usage=SimpleNamespace(total_tokens=20), choices=[SimpleNamespace(
            finish_reason='stop', message=SimpleNamespace(content=json.dumps(payload, ensure_ascii=False)))])

    def enqueue_claim(self):
        self.profiles.enqueue('paper', version_id='v1')
        return self.jobs.claim()

    def test_quote_verification_rejects_invented_values_ids_and_text(self):
        source = self.search.session(KnowledgeScope(document_ids=['paper'])).read_passage('c0')[0]
        good = dict(facet='findings', text='概括原文内容', sources=[dict(number=1, quote='Original passage 0.')])
        notes, rejected = parse_notes(json.dumps({'notes': [good,
            {**good, 'text': '提高了99%'},
            {**good, 'sources': [dict(number=99, quote='Original passage 0.')]},
            {**good, 'sources': [dict(number=1, quote='Invented original quote.')]}]}), {1: source})
        self.assertEqual((len(notes), rejected), (1, 3))
        proof = notes[0]['evidence'][0]
        self.assertEqual(proof['excerpt'], 'Original passage 0.')
        self.assertEqual(proof['excerpt_start'], 0)
        self.assertEqual(proof['document_version_id'], 'v1')
        self.assertTrue(proof['span_id'])
        self.assertTrue(proof['rects'])
        self.assertNotIn('source_map', proof)

    def test_complete_profile_preserves_child_evidence_and_unknown_fields(self):
        self.profiles.process(self.enqueue_claim())
        result = self.jobs.get('paper', self.profiles.config_key)
        self.assertEqual(result['state'], 'ready')
        artifact = result['artifact']
        self.assertEqual(len(artifact['notes']), len(passages()))
        self.assertEqual(artifact['fields']['findings'], [])
        self.assertLessEqual(len(artifact['fields']['methodology']), 2)
        method = next(s for s in artifact['sections'] if s['title'] == '2 Method')
        self.assertEqual(len(method['note_ids']), 4)
        self.assertTrue(all(e['version_id'] == 'v1' for n in artifact['notes'] for e in n['evidence']))
        self.assertNotIn('batch_notes', result['progress'])
        calls = self.client.chat.completions.create.call_count
        self.assertIsNone(self.jobs.enqueue('paper', self.profiles.config_key))
        self.assertEqual(self.client.chat.completions.create.call_count, calls)

    def test_coalescing_and_restart_resume_completed_batch(self):
        job = self.enqueue_claim()
        self.assertEqual(self.jobs.enqueue('paper', self.profiles.config_key), job['id'])
        self.profiles.config['batch_budget'] = 160
        source = self.search.session(KnowledgeScope(document_ids=['paper'])).read_passage('c0')[0]
        notes, _ = parse_notes(json.dumps({'notes': [dict(facet='methodology', text='概括原文内容',
                          sources=[dict(number=1, quote=source['excerpt'])])]}), {1: source})
        job['progress'].update(completed=1, batch_notes=[notes])
        self.assertTrue(self.jobs.checkpoint(job, job['progress']))
        self.jobs.recover()
        resumed = self.jobs.claim()
        self.assertEqual(resumed['progress']['completed'], 1)
        self.profiles.process(resumed)
        extraction_calls = [c.kwargs for c in self.client.chat.completions.create.call_args_list
                            if c.kwargs['messages'][0]['content'].startswith('你是学术文献阅读助手')]
        self.assertTrue(extraction_calls)
        self.assertNotIn('Original passage 0.', extraction_calls[0]['messages'][1]['content'])
        self.assertIn(self.jobs.get('paper', self.profiles.config_key)['state'], ('ready', 'partial'))

    def test_reindex_and_deletion_reject_stale_publication(self):
        job = self.enqueue_claim()
        replacement = [('v2_' + id_, text, {**meta, 'version_id': 'v2'}) for id_, text, meta in passages()]
        self.store.adopt_legacy('paper', 'v2', self.original, 'g2', replacement, False)
        self.assertFalse(self.jobs.publish(job, {'partial': False}))
        self.assertEqual(self.jobs.get('paper', self.profiles.config_key)['state'], 'not_generated')
        with self.assertRaises(ValueError):
            self.jobs.get('paper', self.profiles.config_key, 'v1')
        self.profiles.enqueue('paper')
        new_job = self.jobs.claim()
        self.store.remove(['paper'])
        self.assertFalse(self.jobs.publish(new_job, {'partial': False}))
        with self.catalog.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM profile_jobs').fetchone()[0], 0)

    def test_failed_retry_retains_cached_artifact_and_new_config_invalidates(self):
        self.profiles.process(self.enqueue_claim())
        self.jobs.enqueue('paper', self.profiles.config_key, force=True)
        failed = self.jobs.claim()
        self.jobs.fail(failed['id'], '模型服务暂不可用')
        result = self.jobs.get('paper', self.profiles.config_key)
        self.assertEqual(result['state'], 'failed')
        self.assertIsNotNone(result['artifact'])
        self.assertEqual(self.jobs.get('paper', 'new-configuration')['state'], 'not_generated')

    def test_invalid_model_selection_falls_back_to_existing_notes_only(self):
        self.profiles.process(self.enqueue_claim())
        artifact = self.jobs.get('paper', self.profiles.config_key)['artifact']
        self.client.chat.completions.create.side_effect = None
        self.client.chat.completions.create.return_value = SimpleNamespace(usage=None, choices=[SimpleNamespace(
            finish_reason='stop', message=SimpleNamespace(content=json.dumps({'fields': {
                facet: ['invented'] for facet in FACETS}})))])
        progress = dict(model_calls=0, token_usage=0, partial=False)
        selected = self.profiles._select(self.client, artifact['notes'], progress)
        self.assertTrue(progress['partial'])
        self.assertTrue(set(n['id'] for n in selected) <= set(n['id'] for n in artifact['notes']))

    def test_failed_job_retries_from_checkpoint_and_force_starts_fresh(self):
        job = self.enqueue_claim()
        job['progress']['completed'] = 1
        job['progress']['batch_notes'] = [[]]
        self.jobs.checkpoint(job, job['progress'])
        self.jobs.fail(job['id'], 'temporary failure')
        self.profiles.enqueue('paper')
        retried = self.jobs.claim()
        self.assertEqual(retried['progress']['completed'], 1)
        self.jobs.fail(retried['id'], 'temporary failure')
        self.profiles.enqueue('paper', force=True)
        self.assertEqual(self.jobs.claim()['progress']['completed'], 0)

    def test_semantic_review_can_remove_a_locatable_but_unsupported_claim(self):
        original = self.respond
        def reject_review(**kwargs):
            if kwargs['messages'][0]['content'].startswith('你在复核文献阅读笔记'):
                return SimpleNamespace(usage=None, choices=[SimpleNamespace(finish_reason='stop',
                    message=SimpleNamespace(content='{"accepted_ids":[]}'))])
            return original(**kwargs)
        self.client.chat.completions.create.side_effect = reject_review
        self.profiles.process(self.enqueue_claim())
        result = self.jobs.get('paper', self.profiles.config_key)
        self.assertEqual(result['state'], 'failed')
        self.assertIsNone(result['artifact'])
