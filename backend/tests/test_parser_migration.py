import tempfile
from pathlib import Path
from unittest import TestCase

from catalog import Catalog
from ingest_store import IngestStore
from pdf_evidence import PARSER_VERSION


class ParserMigrationTest(TestCase):
    def test_upgrade_queues_once_and_keeps_old_generation_until_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            path=root/'original.pdf'
            path.write_bytes(b'original-file-is-not-modified-by-a-metadata-migration')
            catalog=Catalog(root)
            catalog.initialize()
            catalog.save('documents',[{'id':'paper','metadata':{'filename':'original.pdf'}}])
            store=IngestStore(catalog)
            store.initialize()
            store.adopt_legacy('paper','original-version',path,'old-generation',
                               [('old-chunk','Original evidence.',{})],False)
            self.assertEqual(store.queue_parser_upgrades(PARSER_VERSION),1)
            self.assertEqual(store.queue_parser_upgrades(PARSER_VERSION),0)
            with catalog.connect() as db:
                self.assertEqual(db.execute('SELECT generation FROM active_indexes').fetchone()[0],'old-generation')
                self.assertEqual(db.execute('SELECT content FROM indexed_chunks').fetchone()[0],'Original evidence.')
            job=store.claim()
            records=[('new-chunk','Original evidence.',{'parser_version':PARSER_VERSION,'source_map_json':'[{}]'})]
            published,previous=store.publish('paper','original-version',job[0],records,['original evidence'])
            self.assertTrue(published)
            self.assertEqual(previous,'old-generation')
            self.assertEqual(store.queue_parser_upgrades(PARSER_VERSION),0)
            self.assertEqual(path.read_bytes(),b'original-file-is-not-modified-by-a-metadata-migration')
