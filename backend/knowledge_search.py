import json
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

from pydantic import BaseModel, Field

from search_text import exact_document_match, match_expression
from document_structure import STRUCTURE_VERSION
from paper_index import PaperIndex


RetrievalMode = Literal["multilevel", "hybrid", "vector"]
RRF_K = 60


def default_folder_id(folders):
    return next((folder["id"] for folder in folders
                 if folder.get("name") == "默认文件夹" and not folder.get("parent_id")), None)


class KnowledgeScope(BaseModel):
    document_ids: list[str] | None = Field(default=None, max_length=100)
    folder_ids: list[str] | None = Field(default=None, max_length=100)


class KnowledgeSearch(KnowledgeScope):
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=8, ge=1, le=50)
    retrieval_mode: RetrievalMode = "multilevel"


class PassageRequest(KnowledgeScope):
    chunk_id: str = Field(min_length=1, max_length=200)
    adjacent: int = Field(default=0, ge=0, le=2)


class DocumentListRequest(KnowledgeScope):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=20, ge=1, le=100)


class SectionReadRequest(KnowledgeScope):
    document_id: str = Field(min_length=1, max_length=200)
    section_id: str = Field(min_length=1, max_length=200)
    version_id: str | None = Field(default=None, max_length=128)
    generation: str | None = Field(default=None, max_length=200)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=30, ge=1, le=100)


def placeholders(values):
    return ", ".join("?" for _ in values)


class KnowledgeSearchService:
    def __init__(self, ingestion):
        self.ingestion = ingestion
        self.store = ingestion.store
        self.catalog = self.store.catalog
        self.profile_config_key = None
        self.paper_index = PaperIndex(self.catalog, ingestion.embed) if hasattr(ingestion, 'embed') else None

    def session(self, scope: KnowledgeScope):
        return KnowledgeReadSession(self, scope)

    def _documents(self, scope):
        by_id = set(scope.document_ids) if scope.document_ids is not None else None
        by_folder = set(scope.folder_ids) if scope.folder_ids is not None else None
        default_id = default_folder_id(self.catalog.load('folders')) if by_folder is not None else None
        return {
            doc["id"]: doc["metadata"]
            for doc in self.catalog.load("documents")
            if (by_id is None or doc["id"] in by_id)
            and (by_folder is None or (doc["metadata"].get("folder_id") or default_id) in by_folder)
        }

    def _active(self, documents):
        with self.catalog.connect() as db:
            return {
                doc_id: (generation, version)
                for doc_id, generation, version in db.execute(
                    "SELECT doc_id, generation, version_id FROM active_indexes",
                )
                if doc_id in documents
            }

    def _vector(self, question, generations, limit):
        results = self.ingestion.collection.query(
            query_texts=[question], n_results=limit, include=["distances"],
            where={"index_generation": {"$in": generations}},
        )
        return dict(zip(results["ids"][0], results["distances"][0], strict=True))

    def _lexical(self, question, documents, active, limit):
        expression = match_expression(question)
        generations = [generation for generation, _ in active.values()]
        exact = [doc_id for doc_id in active if exact_document_match(question, documents[doc_id])]
        with self.catalog.connect() as db:
            hits = []
            if expression:
                # Reserve a bounded share for passages from a paper explicitly named in the query.
                if exact:
                    named_generations = [active[doc_id][0] for doc_id in exact]
                    hits = self._match(db, expression, named_generations, min(limit, 4))
                hits.extend(self._match(db, expression, generations, limit))

            if exact:
                for doc_id in exact[:limit]:
                    generation = active[doc_id][0]
                    first = db.execute("""
                        SELECT id FROM indexed_chunks WHERE generation = ? ORDER BY rowid LIMIT 1
                    """, (generation,)).fetchone()
                    if first and first[0] not in hits:
                        hits.insert(0 if not expression or not hits else min(4, len(hits)), first[0])
        return list(dict.fromkeys(hits))[:limit]

    @staticmethod
    def _match(db, expression, generations, limit):
        return [row[0] for row in db.execute(f"""
            SELECT c.id
            FROM chunk_fts JOIN indexed_chunks c ON c.rowid = chunk_fts.rowid
            WHERE chunk_fts MATCH ? AND c.generation IN ({placeholders(generations)})
            ORDER BY bm25(chunk_fts), c.rowid LIMIT ?
        """, (expression, *generations, limit))]

    def _chunks(self, db, chunk_ids):
        if not chunk_ids:
            return {}
        if len(chunk_ids) > 400:
            rows = {}
            for start in range(0, len(chunk_ids), 400):
                rows.update(self._chunks(db, chunk_ids[start:start + 400]))
            return rows
        return {
            chunk_id: {
                "id": chunk_id, "content": content, "metadata": json.loads(metadata),
                "generation": generation, "doc_id": doc_id, "section_id": section_id,
            }
            for chunk_id, generation, doc_id, content, metadata, section_id in db.execute(f"""
                SELECT c.id, c.generation, c.doc_id, c.content, c.metadata, s.section_id
                FROM indexed_chunks c LEFT JOIN section_passages s
                ON s.chunk_id = c.id AND s.generation = c.generation
                WHERE c.id IN ({placeholders(chunk_ids)})
            """, tuple(chunk_ids))
        }

    def search(self, question, scope, limit, mode: RetrievalMode = "hybrid"):
        if not question.strip() or limit <= 0:
            return []
        if mode == 'multilevel':
            papers, _ = self.discover(question, scope, min(limit, 50))
            # One hit per paper first; a long paper cannot consume every candidate slot.
            output = []
            for offset in range(limit):
                for paper in papers:
                    if offset < len(paper['_hits']):
                        output.append(paper['_hits'][offset])
                        if len(output) == limit:
                            return output
            return output
        with self.ingestion.index_lock:
            documents = self._documents(scope)
            active = self._active(documents)
            if not active:
                return []
            generations = [generation for generation, _ in active.values()]
            if mode == "vector":
                vector = self._vector(question, generations, limit)
                lexical = []
            else:
                pool_size = min(150, max(20, 3 * limit))
                with ThreadPoolExecutor(max_workers=1) as executor:
                    vector_future = executor.submit(self._vector, question, generations, pool_size)
                    lexical = self._lexical(question, documents, active, pool_size)
                    vector = vector_future.result()

            ranks = {}
            for lane, identifiers in (("lexical", lexical), ("vector", vector)):
                for rank, chunk_id in enumerate(identifiers, start=1):
                    ranks.setdefault(chunk_id, {})[lane] = rank
            scores = {
                chunk_id: sum(1 / (RRF_K + rank) for rank in lanes.values())
                for chunk_id, lanes in ranks.items()
            }
            ranked = sorted(ranks, key=lambda chunk_id: (
                -scores[chunk_id],
                min(ranks[chunk_id].values()),
                ranks[chunk_id].get("lexical", float("inf")),
                chunk_id,
            ))
            if not ranked:
                return []
            with self.catalog.connect() as db:
                rows = self._chunks(db, ranked[:limit])
            return [
                {
                    **rows[chunk_id], "version_id": active[rows[chunk_id]["doc_id"]][1],
                    "rank_signals": ranks[chunk_id],
                    "fusion_score": scores[chunk_id] if mode == "hybrid" else None,
                    "distance": vector.get(chunk_id),
                }
                for chunk_id in ranked[:limit]
                if chunk_id in rows
            ]

    def discover(self, query, scope, limit=8, mode='multilevel'):
        if not query.strip():
            return [], []
        with self.ingestion.index_lock:
            documents = self._documents(scope)
            active = self._active(documents)
            body = self.search(query, scope, min(150, max(30, limit * 6)),
                               'vector' if mode == 'vector' else 'hybrid')
            if mode == 'multilevel':
                represented = {hit['doc_id'] for hit in body}
                # A shared top-k can be filled by one long paper. Reserve bounded
                # per-paper body probes independently of whether a card exists.
                missing = sorted(set(active) - represented)[:20]
                for doc_id in missing:
                    body.extend(self.search(query, KnowledgeScope(document_ids=[doc_id]), 2, 'hybrid'))
            profile, warnings = (self.paper_index.search(query, active, self.profile_config_key, 150)
                                 if mode == 'multilevel' and self.paper_index else ([], []))
            by_doc, lane_ranks = {}, {}
            for hit in body:
                by_doc.setdefault(hit['doc_id'], {'body': [], 'profile': []})['body'].append(hit)
                for lane, rank in hit['rank_signals'].items():
                    key = 'body_' + lane
                    lane_ranks.setdefault(key, {})[hit['doc_id']] = min(
                        rank, lane_ranks.get(key, {}).get(hit['doc_id'], rank))
            with self.catalog.connect() as db:
                ids = list(dict.fromkeys(e.get('chunk_id') for h in profile for e in h['note']['evidence']
                                         if e.get('chunk_id')))
                originals = self._chunks(db, ids)
            for hit in profile:
                doc_id = hit['document_id']
                proof = [e for e in hit['note']['evidence'] if e.get('chunk_id') in originals
                         and originals[e['chunk_id']]['doc_id'] == doc_id
                         and originals[e['chunk_id']]['generation'] == active[doc_id][0]
                         and e.get('document_version_id') == active[doc_id][1]]
                if not proof:
                    continue
                hit = {**hit, 'note': {**hit['note'], 'evidence': proof}}
                by_doc.setdefault(doc_id, {'body': [], 'profile': []})['profile'].append(hit)
                for lane, rank in hit['rank_signals'].items():
                    lane_ranks.setdefault(lane, {})[doc_id] = min(
                        rank, lane_ranks.get(lane, {}).get(doc_id, rank))
            # Convert per-note and per-passage ranks into per-paper ranks before fusion.
            # The strongest hit counts once in each lane, independent of paper length.
            signals = {doc_id: {} for doc_id in by_doc}
            for lane, values in lane_ranks.items():
                for rank, doc_id in enumerate(sorted(values, key=lambda d: (values[d], d)), 1):
                    signals[doc_id][lane] = rank
            scores = {doc_id: sum(0.5 / (RRF_K + r) for r in lanes.values())
                      for doc_id, lanes in signals.items()}
            ordered = sorted(by_doc, key=lambda doc_id: (
                not exact_document_match(query, documents[doc_id]), -scores[doc_id], doc_id))[:limit]
            result = []
            for rank, doc_id in enumerate(ordered, 1):
                group = by_doc[doc_id]
                merged = {hit['id']: {**hit, 'retrieval_origin': ['body']} for hit in group['body']}
                for hit in group['profile']:
                    for evidence in hit['note']['evidence']:
                        chunk_id = evidence['chunk_id']
                        if chunk_id in merged:
                            if 'profile' not in merged[chunk_id]['retrieval_origin']:
                                merged[chunk_id]['retrieval_origin'].append('profile')
                            continue
                        merged[chunk_id] = {**originals[chunk_id], 'version_id': active[doc_id][1],
                            'rank_signals': hit['rank_signals'], 'fusion_score': None,
                            'distance': None, 'retrieval_origin': ['profile']}
                # Preserve independent body seeds even when a card is stale or incomplete.
                body_hits = [merged[h['id']] for h in group['body']]
                card_hits = [merged[e['chunk_id']] for h in group['profile'][:3] for e in h['note']['evidence']]
                combined, seen = [], set()
                for offset in range(max(len(body_hits), len(card_hits))):
                    for lane in (card_hits, body_hits):
                        if offset < len(lane) and lane[offset]['id'] not in seen:
                            seen.add(lane[offset]['id'])
                            combined.append({**lane[offset], 'paper_rank': rank, 'paper_score': scores[doc_id]})
                result.append({'document_id': doc_id, 'version_id': active[doc_id][1],
                    'generation': active[doc_id][0],
                    'filename': documents[doc_id].get('filename'),
                    'title': documents[doc_id].get('title') or documents[doc_id].get('filename'),
                    'rank_signals': signals[doc_id], 'fusion_score': scores[doc_id],
                    'exact_match': exact_document_match(query, documents[doc_id]),
                    'matched_notes': [h['note'] for h in group['profile'][:3]],
                    '_hits': combined})
            return result, warnings


class KnowledgeReadSession:
    def __init__(self, service, scope):
        self.service = service
        # HTTP requests are already validated. Internal snapshots can include
        # more active papers than the limit for an explicit user selection.
        self.scope = KnowledgeScope.model_construct(**scope.model_dump(include={"document_ids", "folder_ids"}))
        self.evidence = {}

    def list_sections(self, document_id, version_id=None):
        with self.service.ingestion.index_lock, self.service.catalog.connect() as db:
            documents = self.service._documents(self.scope)
            active = self.service._active(documents)
            if document_id not in documents:
                return None
            if document_id not in active:
                return {"document_id": document_id, "version_id": None, "generation": None,
                        "structure_version": STRUCTURE_VERSION, "sections": []}
            generation, current_version = active[document_id]
            if version_id is not None and version_id != current_version:
                raise ValueError("文献版本已更新，请重新打开文献后查看章节。")
            rows = db.execute("""
                SELECT id, parent_id, title, level, position, page_start, page_end,
                       heading_detected, end_position - start_position + 1
                FROM document_sections WHERE generation = ? ORDER BY position
            """, (generation,)).fetchall()
            sections = [
                dict(zip(("id", "parent_id", "title", "level", "position", "page_start",
                          "page_end", "heading_detected", "passage_count"), row, strict=True))
                for row in rows
            ]
            return {"document_id": document_id, "version_id": current_version,
                    "generation": generation, "structure_version": STRUCTURE_VERSION,
                    "sections": sections}

    def read_section(self, request: SectionReadRequest):
        with self.service.ingestion.index_lock, self.service.catalog.connect() as db:
            documents = self.service._documents(self.scope)
            active = self.service._active(documents)
            current = active.get(request.document_id)
            if current is None:
                return None
            generation, version_id = current
            if ((request.version_id is not None and request.version_id != version_id)
                    or (request.generation is not None and request.generation != generation)):
                raise ValueError("章节对应的文献或索引已更新，请重新打开章节。")
            section = db.execute("""
                SELECT title, start_position, end_position, page_start, page_end
                FROM document_sections WHERE id = ? AND doc_id = ? AND generation = ?
            """, (request.section_id, request.document_id, generation)).fetchone()
            if section is None:
                return None
            title, start, end, page_start, page_end = section
            ids = [row[0] for row in db.execute("""
                SELECT chunk_id FROM section_passages
                WHERE generation = ? AND position BETWEEN ? AND ?
                ORDER BY position LIMIT ? OFFSET ?
            """, (generation, start, end, request.limit, request.offset))]
            evidence = self.read_passages(ids)
            next_offset = request.offset + len(ids)
            return {
                "document_id": request.document_id, "version_id": version_id,
                "generation": generation, "section_id": request.section_id,
                "title": title, "page_start": page_start, "page_end": page_end,
                "evidence": evidence, "total": end - start + 1,
                "next_offset": next_offset if next_offset < end - start + 1 else None,
            }

    def list_documents(self, offset=0, limit=20):
        with self.service.ingestion.index_lock:
            matching = self.service._documents(self.scope)
            active = self.service._active(matching)
            statuses = self.service.store.status_snapshot()
            ordered = sorted(matching, key=lambda doc_id: (
                matching[doc_id].get("uploaded_at") or "", doc_id,
            ), reverse=True)
            return {
                "total": len(ordered),
                "documents": [
                    {
                        "id": doc_id,
                        "title": matching[doc_id].get("title") or matching[doc_id].get("filename"),
                        "filename": matching[doc_id].get("filename"),
                        "author": matching[doc_id].get("author"),
                        "doi": matching[doc_id].get("doi"),
                        "folder_id": matching[doc_id].get("folder_id"),
                        "tags": matching[doc_id].get("tags", []),
                        "searchable": doc_id in active,
                        "status": statuses[doc_id][3] or ("parsed" if doc_id in active else matching[doc_id].get("status")),
                        "version_id": active[doc_id][1] if doc_id in active else None,
                    }
                    for doc_id in ordered[offset:offset + limit]
                ],
            }

    def read_documents(self):
        """Snapshot every active passage in scope, ordered by document and chunk.

        The index lock pins versions while materializing sources. No network calls
        occur under this lock. PDF positions remain on the original evidence.
        """
        with self.service.ingestion.index_lock, self.service.catalog.connect() as db:
            documents = self.service._documents(self.scope)
            active = self.service._active(documents)
            ordered = sorted(active, key=lambda doc_id: (
                documents[doc_id].get("uploaded_at") or "", doc_id,
            ), reverse=True)
            chunk_ids = []
            covered = 0
            for doc_id in ordered:
                rows = db.execute("""
                    SELECT id FROM indexed_chunks WHERE generation = ?
                    ORDER BY CAST(json_extract(metadata, '$.chunk_index') AS INTEGER), rowid
                """, (active[doc_id][0],)).fetchall()
                if rows:
                    covered += 1
                chunk_ids.extend(row[0] for row in rows)
            return self.read_passages(chunk_ids), covered, len(documents), len(active)

    def overview(self):
        return self.read_documents()

    def search_knowledge(self, query, limit=8, mode: RetrievalMode = "multilevel"):
        return [
            {
                "chunk_id": row["id"], "document_id": row["doc_id"],
                "filename": row["metadata"].get("filename"), "preview": row["content"][:180],
                "page_index": row["metadata"].get("page_index"),
                "version_id": row["version_id"],
                "rank_signals": row["rank_signals"], "fusion_score": row["fusion_score"],
                "section_id": row.get("section_id"),
                "paper_rank": row.get("paper_rank"),
                "retrieval_origin": row.get("retrieval_origin", ["body"]),
            }
            for row in self.service.search(query, self.scope, limit, mode)
        ]

    def search_papers(self, query, limit=8, mode='multilevel'):
        with self.service.ingestion.index_lock:
            papers, warnings = self.service.discover(query, self.scope, limit, mode)
            output = []
            for paper in papers:
                hits = paper.pop('_hits')
                sources = self.read_passages([h['id'] for h in hits[:2]])
                output.append({**paper, 'body_previews': [
                    {'text': source['excerpt'][:240], 'source': source} for source in sources]})
            return {'papers': output, 'warnings': warnings, 'retrieval_mode': mode,
                    'ranking_note': '按召回排名融合排序，候选仍需核对原文；排序分数不是匹配概率。'}

    def expand_sections(self, chunk_ids, max_passages=20, per_section=6):
        """Read small sections completely; use a bounded original-order window for long ones."""
        with self.service.ingestion.index_lock, self.service.catalog.connect() as db:
            seeds = self.read_passages(chunk_ids[:max_passages])
            ids = [s['chunk_id'] for s in seeds]
            visited = set()
            active = self.service._active(self.service._documents(self.scope))
            for seed in seeds:
                section_id = seed.get('section_id')
                if not section_id or section_id in visited or len(visited) >= 4:
                    continue
                visited.add(section_id)
                generation = active[seed['id']][0]
                positions = db.execute('''
                    SELECT s.start_position,s.end_position,p.position FROM document_sections s
                    JOIN section_passages p ON p.generation=s.generation AND p.chunk_id=?
                    WHERE s.id=? AND s.generation=?
                ''', (seed['chunk_id'], section_id, generation)).fetchone()
                if not positions:
                    continue
                start, end, center = positions
                selected = db.execute('''SELECT chunk_id,position FROM section_passages
                    WHERE generation=? AND position BETWEEN ? AND ?
                    ORDER BY abs(position-?),position LIMIT ?''',
                    (generation, start, end, center, per_section)).fetchall()
                for chunk_id, _ in sorted(selected, key=lambda r: r[1]):
                    if chunk_id not in ids and len(ids) < max_passages:
                        ids.append(chunk_id)
            return self.read_passages(ids)

    def read_passages(self, chunk_ids, adjacent=0):
        if not chunk_ids:
            return []
        with self.service.ingestion.index_lock, self.service.catalog.connect() as db:
            documents = self.service._documents(self.scope)
            active = self.service._active(documents)
            rows = self.service._chunks(db, chunk_ids)
            ordered = {}
            for chunk_id in chunk_ids:
                row = rows.get(chunk_id)
                if not row or row["doc_id"] not in active:
                    continue
                generation, version_id = active[row["doc_id"]]
                if row["generation"] != generation:
                    continue
                if adjacent:
                    index = row["metadata"].get("chunk_index")
                    if index is not None:
                        neighbors = [
                            neighbor_id for (neighbor_id,) in db.execute("""
                                SELECT id FROM indexed_chunks WHERE generation = ?
                                AND json_extract(metadata, '$.chunk_index') BETWEEN ? AND ?
                                ORDER BY json_extract(metadata, '$.chunk_index')
                            """, (generation, index - adjacent, index + adjacent))
                        ]
                        related = self.service._chunks(db, neighbors)
                        for neighbor_id in neighbors:
                            ordered[neighbor_id] = (related[neighbor_id], version_id)
                        continue
                ordered[chunk_id] = (row, version_id)

            for chunk_id, (row, version_id) in ordered.items():
                if chunk_id in self.evidence:
                    continue
                meta = row["metadata"]
                excerpt = {
                    "id": row["doc_id"], "chunk_id": chunk_id, "document_version_id": version_id,
                    "evidence_id": f"E{len(self.evidence) + 1}",
                    "filename": documents[row["doc_id"]].get("filename") or meta.get("filename"),
                    "excerpt": row["content"],
                    "parser_version": meta.get("parser_version"),
                    "section_id": row.get("section_id"),
                    "section_heading": meta.get("section_heading"),
                    "text_sha256": meta.get("text_sha256"),
                    "elements": json.loads(meta.get("elements_json") or "[]"),
                    "source_map": json.loads(meta.get("source_map_json") or "[]"),
                }
                if "rects_json" in meta and meta.get("version_id") == version_id:
                    excerpt.update(
                        version_id=version_id, page_index=meta["page_index"], rects=json.loads(meta["rects_json"]),
                    )
                self.evidence[chunk_id] = excerpt
            return [self.evidence[chunk_id] for chunk_id in ordered]

    def read_passage(self, chunk_id, adjacent=0):
        return self.read_passages([chunk_id], adjacent)
