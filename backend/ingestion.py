import hashlib
import logging
from collections import Counter, defaultdict
from pathlib import Path
from threading import Event, RLock, Thread
from uuid import uuid4

import PyPDF2

from search_text import index_text
from pdf_evidence import extract_pdf_chunks, pdf_version, PARSER_VERSION


logger = logging.getLogger(__name__)


class Ingestion:
    def __init__(self, store, collection, embed, parse_text, chunk_text):
        self.store = store
        self.collection = collection
        self.embed = embed
        self.parse_text = parse_text
        self.chunk_text = chunk_text
        self.index_lock = RLock()
        self.wake = Event()
        self.stopping = Event()
        self.worker = None

    def start(self, documents, resolve_path):
        self.store.initialize()
        self.store.recover()
        self._adopt_legacy(documents, resolve_path)
        self.stopping.clear()
        self.wake.clear()
        self.worker = Thread(target=self._run, name="document-ingestion", daemon=True)
        self.worker.start()

    def stop(self):
        self.stopping.set()
        self.wake.set()
        if self.worker:
            self.worker.join()

    def _adopt_legacy(self, documents, resolve_path):
        registered = self.store.registered_documents()
        rows = self.collection.get(include=["metadatas", "documents"])
        legacy = defaultdict(list)
        seen_generations = Counter()
        for chunk_id, content, metadata in zip(
            rows["ids"], rows["documents"], rows["metadatas"], strict=True,
        ):
            metadata = metadata or {}
            if generation := metadata.get("index_generation"):
                seen_generations[generation] += 1
            doc_id = metadata.get("doc_id")
            if doc_id and doc_id not in registered and content:
                legacy[doc_id].append((chunk_id, content, metadata))

        for doc in documents:
            doc_id = doc["id"]
            if doc_id in registered:
                continue
            path = resolve_path(doc)
            if not path:
                continue
            version = pdf_version(path)
            generation = "legacy-" + doc_id
            records = [
                (chunk_id, content, {**metadata, "index_generation": generation})
                for chunk_id, content, metadata in legacy[doc_id]
            ]
            for start in range(0, len(records), 128):
                batch = records[start:start + 128]
                self.collection.update(
                    ids=[chunk_id for chunk_id, _, _ in batch],
                    metadatas=[{k: v for k, v in metadata.items() if k not in {"source_map_json", "elements_json"}}
                               for _, _, metadata in batch],
                )
            rebuild = not records or (
                path.suffix.lower() == ".pdf"
                and any("rects_json" not in metadata for _, _, metadata in records)
            )
            self.store.adopt_legacy(doc_id, version, path, generation, records, rebuild)
            seen_generations[generation] = len(records)
        self.store.repair_missing_vectors(seen_generations)
        self.store.queue_parser_upgrades(PARSER_VERSION)
        active = self.store.active_generations()
        for generation in seen_generations.keys() - active:
            self._delete_generation(generation)

    @staticmethod
    def save_original(uploads, content, extension):
        version = hashlib.sha256(content).hexdigest()
        path = uploads / (version + extension)
        if not path.is_file() or pdf_version(path) != version:
            temporary = uploads / (uuid4().hex + ".tmp")
            try:
                temporary.write_bytes(content)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        return version, path

    def _run(self):
        while not self.stopping.is_set():
            self.wake.clear()
            try:
                job = self.store.claim()
                if job:
                    self._process(*job)
                    continue
            except Exception:
                logger.exception("Ingestion worker could not access its queue")
            self.wake.wait(timeout=1)

    def _process(self, job_id, doc_id, version, raw_path, doc):
        path = Path(raw_path)
        try:
            if not path.is_file() or pdf_version(path) != version:
                self.store.finish(job_id, "failed", "原文件缺失或已变化，请重新上传原文件。")
                return
            extension = path.suffix.lower()
            if extension == ".doc":
                self.store.finish(job_id, "stored_only", "请转换为 DOCX 或带文字层的 PDF 后入库。")
                return
            if extension == ".pdf":
                try:
                    pdf = PyPDF2.PdfReader(path)
                    if pdf.is_encrypted and not pdf.decrypt(""):
                        self.store.finish(job_id, "failed", "PDF 已加密，请上传解密后的文件。")
                        return
                    if not len(pdf.pages):
                        raise ValueError("Empty PDF")
                except Exception:
                    self.store.finish(job_id, "failed", "PDF 损坏或格式无效，请核对后替换文件。")
                    return
                try:
                    chunks = list(extract_pdf_chunks(path))
                except Exception:
                    logger.exception("PDF geometry extraction failed for document %s", doc_id)
                    chunks = []
                if not chunks:
                    chunks = [(text, {}) for text in self.chunk_text(self.parse_text(path))]
                if not chunks:
                    self.store.finish(job_id, "no_text_extracted", "PDF 没有可检索的文字层，请先进行 OCR。")
                    return
            else:
                chunks = [(text, {}) for text in self.chunk_text(self.parse_text(path))]
                if not chunks:
                    self.store.finish(job_id, "no_text_extracted", "文件没有可检索的文本。")
                    return

            filename = doc["metadata"]["filename"]
            records = [
                (f"{job_id}_{index}", text, {
                    "doc_id": doc_id, "filename": filename, "size": path.stat().st_size,
                    "chunk_index": index, "index_generation": job_id,
                    **({"version_id": version, **position} if position else {}),
                })
                for index, (text, position) in enumerate(chunks)
            ]
            for start in range(0, len(records), 128):
                batch = records[start:start + 128]
                texts = [text for _, text, _ in batch]
                self.collection.upsert(
                    ids=[chunk_id for chunk_id, _, _ in batch],
                    documents=texts,
                    embeddings=self.embed(texts),
                    metadatas=[{k: v for k, v in metadata.items() if k not in {"source_map_json", "elements_json"}}
                               for _, _, metadata in batch],
                )
            tokenized = [index_text(text) for _, text, _ in records]
            with self.index_lock:
                published, previous = self.store.publish(doc_id, version, job_id, records, tokenized)
                if not published:
                    self._delete_generation(job_id)
                elif previous:
                    self._delete_generation(previous)
        except Exception:
            logger.exception("Indexing failed for document %s, job %s", doc_id, job_id)
            self._delete_generation(job_id)
            self.store.finish(job_id, "failed", "文档入库失败，请重试。")

    def _delete_generation(self, generation):
        try:
            self.collection.delete(where={"index_generation": generation})
        except Exception:
            logger.exception("Could not remove retired vector generation %s", generation)

    def remove(self, doc_ids, uploads, legacy_paths):
        with self.index_lock:
            unreferenced = self.store.remove(doc_ids)
            for doc_id in doc_ids:
                try:
                    self.collection.delete(where={"doc_id": doc_id})
                except Exception:
                    logger.exception("Could not remove vectors for document %s", doc_id)
            for path in unreferenced - legacy_paths:
                try:
                    if path.resolve().parent == uploads.resolve():
                        path.unlink(missing_ok=True)
                except OSError:
                    logger.exception("Could not remove unreferenced original %s", path)
