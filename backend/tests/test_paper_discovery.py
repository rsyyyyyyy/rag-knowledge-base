import json
import tempfile
from pathlib import Path
from threading import RLock
from types import SimpleNamespace
from unittest import TestCase

from catalog import Catalog
from ingest_store import IngestStore
from knowledge_search import KnowledgeScope, KnowledgeSearchService
from paper_index import initialize_paper_search, replace_profile_search
from search_text import exact_document_match


class Embedding:
    def __init__(self):
        self.calls = 0
        self.fail = False

    def name(self):
        return 'fixture-synonyms'

    def __call__(self, input):
        self.calls += len(input)
        if self.fail:
            raise RuntimeError('embedding unavailable')
        return [[1., 0.] if any(t in text for t in ['评审', 'deliberation', 'reviewers']) else [0., 1.]
                for text in input]

    def embed_query(self, input):
        if self.fail:
            raise RuntimeError('embedding unavailable')
        return [[1., 0.] for _ in input]


class PaperDiscoveryTest(TestCase):
    def test_filename_remains_an_exact_entry_after_bibliographic_title_enrichment(self):
        metadata = {'filename': '图结构.pdf', 'title': 'Process-Centric Analysis of Agentic Software Systems'}
        self.assertTrue(exact_document_match('我想找图结构.pdf', metadata))
        self.assertTrue(exact_document_match('图结构', metadata))
        self.assertFalse(exact_document_match('another paper', metadata))

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.original = root / 'paper.pdf'
        self.original.write_bytes(b'original')
        self.catalog = Catalog(root)
        self.catalog.initialize()
        self.catalog.save('folders', [{'id': 'f1', 'name': 'Methods'}, {'id': 'f2', 'name': 'Other'}])
        self.catalog.save('documents', [
            {'id': id_, 'metadata': {'filename': id_ + '.pdf', 'folder_id': folder}}
            for id_, folder in [('target', 'f1'), ('long', 'f2'), ('detail', 'f1')]])
        self.store = IngestStore(self.catalog)
        self.store.initialize()
        self.embed = Embedding()
        self.all_ids = []
        for doc_id, texts in [
            ('long', ['Unrelated boilerplate'] * 35),
            ('detail', ['ZX-481 identifies a calibration result.']),
            ('target', ['Background context.', 'Independent stakeholder agents deliberate.', 'They aggregate judgments.'])]:
            records = [(f'{doc_id}-{i}', text, dict(filename=doc_id+'.pdf', version_id='v1',
                chunk_index=i, page_index=i, rects_json='[[0.1,0.2,0.5,0.3]]',
                section_heading='1 Introduction' if i == 0 else '2 Method')) for i,text in enumerate(texts)]
            self.store.adopt_legacy(doc_id, 'v1', self.original, 'g-' + doc_id, records, False)
            self.all_ids.extend(id_ for id_,_,_ in records)
        self.search = KnowledgeSearchService(SimpleNamespace(
            store=self.store, index_lock=RLock(), embed=self.embed,
            collection=SimpleNamespace(query=self.vector_query)))
        self.search.profile_config_key = 'cfg'
        session = self.search.session(KnowledgeScope(document_ids=['target']))
        proof = session.read_passage('target-1')[0]
        self.note = {'id': 'note-debate', 'facet': 'methodology', 'text': '多个评审角色独立打分后讨论分歧',
                     'evidence': [proof]}
        with self.store.transaction() as db:
            replace_profile_search(db, 'target', 'g-target', 'cfg', {'notes': [self.note]})

    def vector_query(self, **kwargs):
        allowed = kwargs['where']['index_generation']['$in']
        with self.catalog.connect() as db:
            ids = [id_ for id_ in self.all_ids if (row := db.execute(
                'SELECT generation FROM indexed_chunks WHERE id=?', (id_,)).fetchone()) and row[0] in allowed]
        ids = ids[:kwargs['n_results']]
        return {'ids': [ids], 'distances': [[0.3 + i/100 for i in range(len(ids))]]}

    def test_card_recovers_paper_outside_body_pool_and_fusion_prevents_long_paper_dominance(self):
        baseline = self.search.session(KnowledgeScope()).search_papers('评审角色讨论分歧', 2, 'hybrid')
        upgraded = self.search.session(KnowledgeScope()).search_papers('评审角色讨论分歧', 2)
        self.assertNotIn('target', [p['document_id'] for p in baseline['papers']])
        self.assertEqual(upgraded['papers'][0]['document_id'], 'target')
        self.assertIn('profile_lexical', upgraded['papers'][0]['rank_signals'])
        self.assertEqual(upgraded['papers'][0]['matched_notes'][0]['evidence'][0]['chunk_id'], 'target-1')
        candidates = self.search.session(KnowledgeScope()).search_knowledge('评审角色讨论分歧', 2)
        self.assertEqual(len({c['document_id'] for c in candidates}), 2)
        self.assertNotIn('evidence_id', candidates[0])

    def test_semantic_paraphrase_and_embedding_cache(self):
        first = self.search.session(KnowledgeScope()).search_papers('reviewers deliberate to agreement', 2)
        target = next(p for p in first['papers'] if p['document_id'] == 'target')
        self.assertIn('profile_vector', target['rank_signals'])
        self.assertNotIn('profile_lexical', target['rank_signals'])
        calls = self.embed.calls
        self.search.session(KnowledgeScope()).search_papers('reviewers settle disagreements', 2)
        self.assertEqual(self.embed.calls, calls)

    def test_scope_config_and_reindex_exclude_old_cards(self):
        for scope in [KnowledgeScope(document_ids=[]), KnowledgeScope(folder_ids=['f2']),
                      KnowledgeScope(document_ids=['target'], folder_ids=['f2'])]:
            papers = self.search.session(scope).search_papers('评审角色讨论分歧')['papers']
            self.assertNotIn('target', [p['document_id'] for p in papers])
        self.search.profile_config_key = 'changed'
        papers = self.search.session(KnowledgeScope()).search_papers('评审角色讨论分歧', 2)['papers']
        self.assertFalse(any(p['matched_notes'] for p in papers))
        self.search.profile_config_key = 'cfg'
        self.store.adopt_legacy('target', 'v2', self.original, 'g-new',
            [('new-target', 'Revised paper text', {'chunk_index': 0, 'version_id': 'v2'})], False)
        papers = self.search.session(KnowledgeScope(document_ids=['target'])).search_papers('评审角色讨论分歧')['papers']
        self.assertEqual(papers, [])  # fixture vector list deliberately lacks the new chunk

    def test_body_detail_remains_available_without_card_and_exact_name_is_reserved(self):
        papers = self.search.session(KnowledgeScope()).search_papers('ZX-481')['papers']
        self.assertTrue(any(p['document_id'] == 'detail' for p in papers))
        exact = self.search.session(KnowledgeScope()).search_papers('detail.pdf', 1)['papers']
        self.assertEqual(exact[0]['document_id'], 'detail')

    def test_section_expansion_reads_own_section_and_obeys_budget(self):
        session = self.search.session(KnowledgeScope(document_ids=['target']))
        expanded = session.expand_sections(['target-1'], max_passages=5)
        self.assertEqual([s['chunk_id'] for s in expanded], ['target-1', 'target-2'])
        self.assertEqual(expanded[1]['page_index'], 2)
        self.assertEqual(len(session.expand_sections(['target-1'], max_passages=1)), 1)
        self.assertEqual(session.expand_sections(['long-1']), [])

    def test_semantic_failure_keeps_lexical_card_and_body_and_deletion_cleans_index(self):
        self.embed.fail = True
        result = self.search.session(KnowledgeScope()).search_papers('评审角色讨论分歧', 2)
        self.assertTrue(result['warnings'])
        self.assertIn('target', [p['document_id'] for p in result['papers']])
        self.embed.fail = False
        self.search.session(KnowledgeScope()).search_papers('评审角色讨论分歧')
        self.store.remove(['target'])
        with self.catalog.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM profile_search').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM profile_embeddings').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM profile_fts WHERE profile_fts MATCH '评审'").fetchone()[0], 0)

    def test_fts_migration_and_replacement_are_idempotent(self):
        with self.store.transaction() as db:
            replace_profile_search(db, 'target', 'g-target', 'cfg', {'notes': [self.note]})
            initialize_paper_search(db)
            self.assertEqual(db.execute('SELECT count(*) FROM profile_search').fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM profile_fts WHERE profile_fts MATCH '评审'").fetchone()[0], 1)
