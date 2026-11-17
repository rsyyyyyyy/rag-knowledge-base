"""Search derived reading notes independently of original passages.

Notes are discovery hints. Answers must read their original versioned evidence.
Local embeddings are cached in SQLite; cosine scores are ranking signals, not confidence.
"""
import hashlib
import json
import logging
import math
from threading import RLock

from search_text import index_text, match_expression

logger = logging.getLogger(__name__)
INDEX_VERSION = 'paper-notes-v1'


def replace_profile_search(db, doc_id, generation, config_key, content):
    db.execute('DELETE FROM profile_search WHERE doc_id=? AND generation=? AND config_key=?',
               (doc_id, generation, config_key))
    for note in content.get('notes', []):
        if not note.get('text') or not note.get('evidence'):
            continue
        identity = json.dumps([doc_id, generation, config_key, note['id']])
        db.execute('INSERT INTO profile_search VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (
            hashlib.sha256(identity.encode()).hexdigest(), doc_id, generation, config_key,
            note['facet'], note['text'], index_text(note['text']), json.dumps(note, ensure_ascii=False)))


def initialize_paper_search(db):
    existing = db.execute("SELECT 1 FROM sqlite_master WHERE name='profile_search'").fetchone()
    for sql in [
        '''CREATE TABLE IF NOT EXISTS profile_search (
            id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, generation TEXT NOT NULL,
            config_key TEXT NOT NULL, facet TEXT NOT NULL, content TEXT NOT NULL,
            search_text TEXT NOT NULL, note TEXT NOT NULL)''',
        'CREATE INDEX IF NOT EXISTS profile_search_scope ON profile_search(doc_id,generation,config_key)',
        '''CREATE VIRTUAL TABLE IF NOT EXISTS profile_fts USING fts5(
            search_text, content='profile_search', content_rowid='rowid')''',
        '''CREATE TABLE IF NOT EXISTS profile_embeddings (
            id TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(id,model))''',
        '''CREATE TRIGGER IF NOT EXISTS profile_search_insert AFTER INSERT ON profile_search BEGIN
            INSERT INTO profile_fts(rowid,search_text) VALUES (new.rowid,new.search_text); END''',
        '''CREATE TRIGGER IF NOT EXISTS profile_search_delete AFTER DELETE ON profile_search BEGIN
            INSERT INTO profile_fts(profile_fts,rowid,search_text) VALUES ('delete',old.rowid,old.search_text);
            DELETE FROM profile_embeddings WHERE id=old.id; END''',
    ]:
        db.execute(sql)
    if not existing:
        for doc_id, generation, config, raw in db.execute(
                'SELECT doc_id,generation,config_key,content FROM document_profiles').fetchall():
            replace_profile_search(db, doc_id, generation, config, json.loads(raw))


class PaperIndex:
    def __init__(self, catalog, embed):
        self.catalog = catalog
        self.embed = embed
        name = embed.name() if hasattr(embed, 'name') else type(embed).__qualname__
        self.model = INDEX_VERSION + ':' + name
        self.lock = RLock()

    def search(self, query, documents, config_key, limit):
        if not documents or not config_key:
            return [], []
        scope = json.dumps(list(documents))
        with self.catalog.connect() as db:
            rows = db.execute('''
                SELECT p.id,p.doc_id,p.note,e.vector FROM profile_search p
                JOIN active_indexes a ON a.doc_id=p.doc_id AND a.generation=p.generation
                LEFT JOIN profile_embeddings e ON e.id=p.id AND e.model=?
                WHERE p.config_key=? AND p.doc_id IN (SELECT value FROM json_each(?))
            ''', (self.model, config_key, scope)).fetchall()
            lexical = []
            expression = match_expression(query)
            if rows and expression:
                lexical = [r[0] for r in db.execute('''
                    SELECT p.id FROM profile_fts JOIN profile_search p ON p.rowid=profile_fts.rowid
                    JOIN active_indexes a ON a.doc_id=p.doc_id AND a.generation=p.generation
                    WHERE profile_fts MATCH ? AND p.config_key=?
                    AND p.doc_id IN (SELECT value FROM json_each(?))
                    ORDER BY bm25(profile_fts),p.id LIMIT ?
                ''', (expression, config_key, scope, limit))]
        if not rows:
            return [], []
        by_id = {r[0]: {'id': r[0], 'document_id': r[1], 'note': json.loads(r[2])} for r in rows}
        warnings = []
        semantic = []
        try:
            with self.lock:
                vectors = {r[0]: json.loads(r[3]) for r in rows if r[3]}
                missing = [r for r in rows if r[0] not in vectors]
                for start in range(0, len(missing), 64):
                    batch = missing[start:start + 64]
                    embedded = self.embed(input=[json.loads(r[2])['text'] for r in batch])
                    entries = [(r[0], [float(x) for x in v]) for r, v in zip(batch, embedded, strict=True)]
                    with self.catalog.connect() as db, db:
                        for id_, vector in entries:
                            # Deletion or replacement during local embedding must not create orphan cache rows.
                            db.execute('''INSERT OR REPLACE INTO profile_embeddings
                                SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM profile_search WHERE id=?)''',
                                (id_, self.model, json.dumps(vector), id_))
                            vectors[id_] = vector
                q = [float(x) for x in self.embed.embed_query(input=[query])[0]]
                def cosine(vector):
                    dot = sum(a*b for a,b in zip(q, vector, strict=True))
                    norm = math.sqrt(sum(x*x for x in q)*sum(x*x for x in vector))
                    return dot/norm if norm else -1
                semantic = sorted(vectors, key=lambda id_: (-cosine(vectors[id_]), id_))[:limit]
        except Exception as error:
            logger.warning('Paper semantic retrieval unavailable: %s', type(error).__name__)
            warnings.append('卡片语义检索暂不可用，本轮保留卡片关键词和正文检索。')
        ranks = {}
        for lane, ids in [('profile_lexical', lexical), ('profile_vector', semantic)]:
            for rank, id_ in enumerate(ids, 1):
                ranks.setdefault(id_, {})[lane] = rank
        hits = [{**by_id[id_], 'rank_signals': lanes,
                 'score': sum(1/(60+r) for r in lanes.values())} for id_, lanes in ranks.items()]
        return sorted(hits, key=lambda hit: (-hit['score'], hit['id']))[:limit], warnings
