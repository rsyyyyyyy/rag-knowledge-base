from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
import chromadb
import os
import json
from datetime import datetime
from pathlib import Path
from functools import lru_cache
from fastembed import TextEmbedding
from openai import APIError, APIStatusError, APITimeoutError, OpenAI
from chromadb import EmbeddingFunction, Documents, Embeddings
import zipfile
import re
from urllib.parse import quote
import PyPDF2
from docx import Document

DEEPSEEK_MODEL = "deepseek-flash"
EMBEDDING_MODEL = "BAAI/bge-small-zh-v1.5"


def get_deepseek_client():
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="未配置 DeepSeek API 密钥（DEEPSEEK_API_KEY）")
    return OpenAI(api_key=api_key, base_url="https://api.deepseek.com", timeout=60.0, max_retries=0)


def deepseek_error(error: APIError) -> HTTPException:
    if isinstance(error, APIStatusError):
        if error.status_code == 401:
            return HTTPException(status_code=502, detail="DeepSeek API 密钥无效或已撤销")
        if error.status_code == 402:
            return HTTPException(status_code=502, detail="DeepSeek API 账户余额不足")
        if error.status_code == 429:
            return HTTPException(status_code=503, detail="DeepSeek API 请求过于频繁，请稍后重试")
    if isinstance(error, APITimeoutError):
        return HTTPException(status_code=504, detail="DeepSeek API 请求超时，请稍后重试")
    return HTTPException(status_code=502, detail="DeepSeek API 暂时不可用，请稍后重试")

app = FastAPI()

# 配置 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 本地持久化目录与元数据文件
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
CHROMA_DIR = DATA_DIR / "chroma_db"
DOC_META_FILE = DATA_DIR / "documents.json"
FOLDER_META_FILE = DATA_DIR / "folders.json"

ALLOWED_EXTENSIONS = {".txt", ".md", ".pdf", ".doc", ".docx"}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20MB

@lru_cache(maxsize=1)
def get_embedding_model() -> TextEmbedding:
    return TextEmbedding(model_name=EMBEDDING_MODEL)


class LocalEmbedding(EmbeddingFunction):
    @staticmethod
    def name() -> str:
        return "local_bge_small_zh_v15"

    def __call__(self, input: Documents) -> Embeddings:
        return list(get_embedding_model().embed(input))

    def embed_query(self, input: Documents) -> Embeddings:
        return list(get_embedding_model().query_embed(input))


# 向量模型改变后使用新的集合，避免将不同模型生成的向量混用。
CHROMA_DIR.mkdir(parents=True, exist_ok=True)
local_embedding = LocalEmbedding()
COLLECTION_NAME = "knowledge_base_bge_small_zh_v15"


def _init_chromadb():
    global client, collection
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    try:
        collection = client.get_or_create_collection(
            name=COLLECTION_NAME, embedding_function=local_embedding,
            metadata={"hnsw:space": "cosine"},
        )
        print(f"[ChromaDB] Collection '{COLLECTION_NAME}' loaded, {collection.count()} chunks")
    except Exception as error:
        print(f"[ChromaDB] Rebuilding collection '{COLLECTION_NAME}': {error}")
        client.delete_collection(COLLECTION_NAME)
        collection = client.get_or_create_collection(
            name=COLLECTION_NAME, embedding_function=local_embedding,
            metadata={"hnsw:space": "cosine"},
        )


_init_chromadb()


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 100) -> list[str]:
    """将长文本按段落边界分块，每块约 chunk_size 字符，相邻块有 overlap 字符重叠"""
    text = text.strip()
    if not text:
        return []
    if len(text) <= chunk_size:
        return [text]

    paragraphs = re.split(r'\n{2,}', text)
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) + 1 <= chunk_size:
            current = f"{current}\n{para}" if current else para
        else:
            if current:
                chunks.append(current)
            if len(para) > chunk_size:
                words = para
                while len(words) > chunk_size:
                    chunks.append(words[:chunk_size])
                    words = words[chunk_size - overlap:]
                current = words
            else:
                current = para
    if current:
        chunks.append(current)
    return chunks


def index_document_to_chroma(doc_id: str, text: str, filename: str, file_size: int) -> int:
    """将文档分块后写入 ChromaDB，返回写入的分块数。嵌入失败时抛出异常。"""
    delete_document_from_chroma(doc_id)
    chunks = chunk_text(text)
    if not chunks:
        print(f"[Index] {doc_id} ({filename}): no chunks generated")
        return 0
    chunk_ids = [f"{doc_id}_chunk_{i}" for i in range(len(chunks))]
    metadatas = [
        {"doc_id": doc_id, "filename": filename, "size": file_size, "chunk_index": i}
        for i in range(len(chunks))
    ]
    try:
        collection.add(documents=chunks, ids=chunk_ids, metadatas=metadatas)
        print(f"[Index] {doc_id} ({filename}): indexed {len(chunks)} chunks successfully")
    except Exception as e:
        print(f"[Index] {doc_id} ({filename}): FAILED to index - {e}")
        raise
    return len(chunks)


def delete_document_from_chroma(doc_id: str) -> None:
    """删除某文档的全部分块向量"""
    try:
        existing = collection.get(where={"doc_id": doc_id})
        if existing and existing["ids"]:
            collection.delete(ids=existing["ids"])
    except Exception:
        try:
            collection.delete(ids=[doc_id])
        except Exception:
            pass


def ensure_storage_ready() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    if not DOC_META_FILE.exists():
        DOC_META_FILE.write_text("[]", encoding="utf-8")
    if not FOLDER_META_FILE.exists():
        FOLDER_META_FILE.write_text("[]", encoding="utf-8")


def load_documents_meta() -> list[dict]:
    ensure_storage_ready()
    try:
        return json.loads(DOC_META_FILE.read_text(encoding="utf-8"))
    except Exception:
        # 元数据损坏时兜底
        return []


def save_documents_meta(items: list[dict]) -> None:
    ensure_storage_ready()
    DOC_META_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def safe_filename(filename: str) -> str:
    # 最小化清洗，避免路径穿越
    return os.path.basename(filename).replace("..", "_")


def generate_doc_id(existing: list[dict]) -> str:
    if not existing:
        return "doc_1"
    max_id = 0
    for item in existing:
        doc_id = str(item.get("id", ""))
        if doc_id.startswith("doc_"):
            try:
                max_id = max(max_id, int(doc_id.split("_")[1]))
            except Exception:
                pass
    return f"doc_{max_id + 1}"


def load_folders_meta() -> list[dict]:
    ensure_storage_ready()
    try:
        return json.loads(FOLDER_META_FILE.read_text(encoding="utf-8"))
    except Exception:
        # 元数据损坏时兜底
        return []


def save_folders_meta(items: list[dict]) -> None:
    ensure_storage_ready()
    FOLDER_META_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def generate_folder_id(existing: list[dict]) -> str:
    if not existing:
        return "folder_1"
    max_id = 0
    for item in existing:
        folder_id = str(item.get("id", ""))
        if folder_id.startswith("folder_"):
            try:
                max_id = max(max_id, int(folder_id.split("_")[1]))
            except Exception:
                pass
    return f"folder_{max_id + 1}"


def strip_xml_tags(text: str) -> str:
    no_tags = re.sub(r"<[^>]+>", "", text)
    return no_tags.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")


def read_docx_text(file_path: Path) -> str:
    try:
        with zipfile.ZipFile(file_path, "r") as zf:
            xml_bytes = zf.read("word/document.xml")
            xml_text = xml_bytes.decode("utf-8", errors="ignore")
            
            # 去除XML标签
            text = strip_xml_tags(xml_text)
            
            # 处理Word文档中的特殊标记
            # 去除HYPERLINK标记
            text = re.sub(r'HYPERLINK \\l "_[^"\\n]+"', '', text)
            # 去除PAGEREF标记
            text = re.sub(r'PAGEREF _[^\\n]+ \\h', '', text)
            # 去除TOC标记
            text = re.sub(r'TOC\\o "[^"\\n]+" \\h', '', text)
            # 处理转义字符
            text = text.replace('\\&quot;', '"')
            text = text.replace('\\&lt;', '<')
            text = text.replace('\\&gt;', '>')
            text = text.replace('\\&amp;', '&')
            # 处理换行符
            text = text.replace('\\n', '\n')
            text = text.replace('\\u', ' ')
            # 处理多余的空格，但保留换行符
            # 只将一行内的连续空格替换为单个空格
            lines = text.split('\n')
            processed_lines = []
            for line in lines:
                # 去除行首行尾的空格，然后将行内连续空格替换为单个空格
                processed_line = re.sub(r'\s+', ' ', line.strip())
                if processed_line:
                    processed_lines.append(processed_line)
            # 重新组合行
            text = '\n'.join(processed_lines)
            
            return text.strip()
    except Exception:
        return ""


def read_pdf_text(file_path: Path) -> str:
    try:
        with open(file_path, "rb") as f:
            pdf_reader = PyPDF2.PdfReader(f)
            text = ""
            for page in pdf_reader.pages:
                text += page.extract_text() + "\n"
            return text.strip()
    except Exception:
        return ""


def read_docx_text_improved(file_path: Path) -> str:
    try:
        doc = Document(file_path)
        text = ""
        for paragraph in doc.paragraphs:
            if paragraph.text.strip():
                text += paragraph.text + "\n"
        return text.strip()
    except Exception:
        # 回退到原始方法
        return read_docx_text(file_path)


# 问答请求模型
class QueryRequest(BaseModel):
    question: str
    top_k: int = 20
    rag_enabled: bool = True
    attachment_text: str | None = None
    attachment_filename: str | None = None


@app.on_event("startup")
def on_startup() -> None:
    ensure_storage_ready()
    _reindex_missing_documents()


def _resolve_doc_path(doc: dict) -> Path | None:
    """解析文档的实际文件路径，兼容项目迁移后路径变化的情况"""
    meta = doc.get("metadata", {})
    original = Path(meta.get("path", ""))
    if original.is_file():
        return original
    # 项目可能已迁移，尝试从当前 UPLOADS_DIR 中查找
    doc_id = doc.get("id", "")
    ext = meta.get("file_type", original.suffix)
    fallback = UPLOADS_DIR / f"{doc_id}{ext}"
    if fallback.exists():
        meta["path"] = str(fallback)
        return fallback
    return None


def _reindex_missing_documents() -> None:
    """启动时检查已上传但未索引的文档（或嵌入为零向量的文档），自动重建向量索引"""
    docs = load_documents_meta()
    existing_ids_in_chroma = set()
    zero_vector_doc_ids = set()
    try:
        all_data = collection.get(include=["embeddings", "metadatas"])
        for i, meta in enumerate(all_data.get("metadatas") or []):
            if meta and "doc_id" in meta:
                doc_id_in_db = meta["doc_id"]
                existing_ids_in_chroma.add(doc_id_in_db)
                emb = all_data["embeddings"][i] if all_data.get("embeddings") is not None else None
                if emb is not None and all(v == 0.0 for v in emb):
                    zero_vector_doc_ids.add(doc_id_in_db)
    except Exception as e:
        print(f"[startup] Warning: failed to read ChromaDB: {e}")

    if zero_vector_doc_ids:
        print(f"[startup] Found {len(zero_vector_doc_ids)} documents with zero-vector embeddings: {zero_vector_doc_ids}")
        for bad_id in zero_vector_doc_ids:
            delete_document_from_chroma(bad_id)
        existing_ids_in_chroma -= zero_vector_doc_ids

    indexed = 0
    meta_changed = False
    for doc in docs:
        doc_id = doc.get("id", "")
        if doc_id in existing_ids_in_chroma:
            if doc.get("metadata", {}).get("status") in ("stored_only", "pending"):
                doc["metadata"]["status"] = "parsed"
                meta_changed = True
            continue
        file_path = _resolve_doc_path(doc)
        if not file_path:
            print(f"[startup] Skipped {doc_id}: file not found")
            continue
        ext = file_path.suffix.lower()
        filename = doc.get("metadata", {}).get("filename", file_path.name)
        file_size = doc.get("metadata", {}).get("size", 0)
        if str(file_path) != doc.get("metadata", {}).get("path", ""):
            meta_changed = True
        try:
            if ext in {".txt", ".md"}:
                text = file_path.read_text(encoding="utf-8", errors="ignore")
            elif ext == ".pdf":
                text = read_pdf_text(file_path)
            elif ext == ".docx":
                text = read_docx_text_improved(file_path)
            else:
                continue
            if text.strip():
                index_document_to_chroma(doc_id, text, filename, file_size)
                doc["metadata"]["status"] = "parsed"
                meta_changed = True
                indexed += 1
                print(f"[startup] Indexed {doc_id} ({filename})")
        except Exception as e:
            print(f"[startup] Failed to index {doc_id} ({filename}): {e}")
    if meta_changed:
        save_documents_meta(docs)
        print("[startup] Updated document metadata")
    if indexed:
        print(f"[startup] Re-indexed {indexed} documents into ChromaDB")
    else:
        print("[startup] No new documents to index")


# 上传文档（仅确保“上传-存储-显示”闭环）
@app.post("/api/documents/parse-only")
async def parse_file_only(file: UploadFile = File(...)):
    """仅解析文件内容并返回文本，不存储到知识库"""
    try:
        original_name = safe_filename(file.filename or "unnamed_file")
        ext = Path(original_name).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

        content = await file.read()
        file_size = len(content)
        if file_size == 0:
            raise HTTPException(status_code=400, detail="Empty file is not allowed")
        if file_size > MAX_FILE_SIZE:
            raise HTTPException(status_code=413, detail="File is too large (max 20MB)")

        parsed_text = ""
        if ext in {".txt", ".md"}:
            parsed_text = content.decode("utf-8", errors="ignore")
        elif ext == ".pdf":
            import tempfile
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(content)
                tmp_path = Path(tmp.name)
            try:
                parsed_text = read_pdf_text(tmp_path)
            finally:
                tmp_path.unlink(missing_ok=True)
        elif ext in {".docx", ".doc"}:
            import tempfile
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(content)
                tmp_path = Path(tmp.name)
            try:
                parsed_text = read_docx_text_improved(tmp_path)
            finally:
                tmp_path.unlink(missing_ok=True)

        if not parsed_text.strip():
            return {"filename": original_name, "size": file_size, "text": "", "message": "No text could be extracted"}

        return {"filename": original_name, "size": file_size, "text": parsed_text, "message": "File parsed successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/documents/upload")
async def upload_document(file: UploadFile = File(...), folder_id: str | None = Form(None)):
    try:
        ensure_storage_ready()

        original_name = safe_filename(file.filename or "unnamed_file")
        ext = Path(original_name).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

        # 读取上传内容并做大小校验
        content = await file.read()
        file_size = len(content)
        if file_size == 0:
            raise HTTPException(status_code=400, detail="Empty file is not allowed")
        if file_size > MAX_FILE_SIZE:
            raise HTTPException(status_code=413, detail="File is too large (max 20MB)")

        # 生成稳定ID与存储路径
        docs = load_documents_meta()
        doc_id = generate_doc_id(docs)
        stored_name = f"{doc_id}{ext}"
        stored_path = UPLOADS_DIR / stored_name

        # 落盘文件
        with open(stored_path, "wb") as f:
            f.write(content)

        # 尝试提取文本内容
        parsed_text = ""
        parse_status = "pending"
        if ext in {".txt", ".md"}:
            try:
                parsed_text = content.decode("utf-8", errors="ignore")
                index_document_to_chroma(doc_id, parsed_text, original_name, file_size)
                parse_status = "parsed"
            except Exception as e:
                parse_status = "failed"
                error_message = str(e)
        elif ext == ".pdf":
            try:
                parsed_text = read_pdf_text(stored_path)
                if parsed_text.strip():
                    index_document_to_chroma(doc_id, parsed_text, original_name, file_size)
                    parse_status = "parsed"
                else:
                    parse_status = "no_text_extracted"
            except Exception as e:
                parse_status = "failed"
                error_message = str(e)
        elif ext == ".docx":
            try:
                parsed_text = read_docx_text_improved(stored_path)
                if parsed_text.strip():
                    index_document_to_chroma(doc_id, parsed_text, original_name, file_size)
                    parse_status = "parsed"
                else:
                    parse_status = "no_text_extracted"
            except Exception as e:
                parse_status = "failed"
                error_message = str(e)
        else:
            parse_status = "stored_only"

        now = datetime.utcnow().isoformat() + "Z"
        metadata = {
            "filename": original_name,
            "size": file_size,
            "file_type": ext,
            "status": parse_status,
            "uploaded_at": now,
            "path": str(stored_path),
            "folder_id": folder_id,  # 使用传入的folder_id
            "tags": [],  # 标签
            "source": "",  # 来源
            "project": "",  # 项目
            "author": "",  # 作者
            "last_accessed_at": now,  # 最近访问时间
            "is_favorite": False,  # 是否收藏
        }
        # 添加失败原因（如果有）
        if parse_status == "failed" and 'error_message' in locals():
            metadata["error_message"] = error_message

        docs.append({"id": doc_id, "metadata": metadata})
        save_documents_meta(docs)

        return {
            "message": "Document uploaded successfully",
            "document_id": doc_id,
            "document": {"id": doc_id, "metadata": metadata},
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 获取文档列表（仅依赖本地元数据）
@app.get("/api/documents")
async def get_documents(folder_id: str | None = Query(None, description="Folder ID filter")):
    try:
        docs = load_documents_meta()

        if folder_id is not None:
            docs = [d for d in docs if d.get("metadata", {}).get("folder_id") == folder_id]

        # 按上传时间倒序
        docs_sorted = sorted(
            docs,
            key=lambda x: x.get("metadata", {}).get("uploaded_at", ""),
            reverse=True,
        )
        return {"documents": docs_sorted}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 获取文档原文件（用于前端点击打开/下载）
@app.get("/api/documents/{doc_id}/file")
async def get_document_file(doc_id: str):
    docs = load_documents_meta()
    target = next((d for d in docs if d.get("id") == doc_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Document not found")

    # 使用文件名构建路径，而不是存储的完整路径
    filename_in_storage = f"{doc_id}{target['metadata']['file_type']}"
    file_path = UPLOADS_DIR / filename_in_storage
    
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Stored file not found")

    ext = file_path.suffix.lower()
    media_types = {
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    media_type = media_types.get(ext, "application/octet-stream")

    download_name = target.get("metadata", {}).get("filename", file_path.name)
    encoded_name = quote(download_name)

    return FileResponse(
        path=file_path,
        filename=download_name,
        media_type=media_type,
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{encoded_name}",
            "X-Content-Type-Options": "nosniff",
        },
    )


def extract_directory(text: str, ext: str) -> list[dict]:
    """从文本中提取目录"""
    directory = []
    if ext == ".md":
        # 提取Markdown标题
        lines = text.split('\n')
        for line in lines:
            line = line.strip()
            if line.startswith('#'):
                level = line.count('#')
                title = line.lstrip('#').strip()
                if title:
                    directory.append({
                        "level": level,
                        "title": title,
                        "id": title.lower().replace(' ', '-').replace('/', '-').replace('?', '')
                    })
    elif ext == ".txt" or ext == ".docx":
        # 提取TXT和DOCX文件中的标题
        lines = text.split('\n')
        for i, line in enumerate(lines):
            line = line.strip()
            
            # 匹配数字编号标题：1. 标题、1.1 标题、1.1.1 标题
            if re.match(r'^\d+(\.\d+)*\.\s+.+', line):
                level = len(re.findall(r'\d+', line.split('.')[0]))
                title = re.sub(r'^\d+(\.\d+)*\.\s+', '', line)
                if title:
                    directory.append({
                        "level": level,
                        "title": title,
                        "id": f"section-{i}"
                    })
            
            # 匹配罗马数字标题：一、标题、（一）标题
            elif re.match(r'^[一二三四五六七八九十]+、\s*.+', line):
                title = re.sub(r'^[一二三四五六七八九十]+、\s+', '', line)
                if title:
                    directory.append({
                        "level": 1,
                        "title": title,
                        "id": f"section-{i}"
                    })
            elif re.match(r'^（[一二三四五六七八九十]+）\s*.+', line):
                title = re.sub(r'^（[一二三四五六七八九十]+）\s+', '', line)
                if title:
                    directory.append({
                        "level": 2,
                        "title": title,
                        "id": f"section-{i}"
                    })
            
            # 匹配全角数字标题：１．标题
            elif re.match(r'^[１２３４５６７８９０]+．\s*.+', line):
                title = re.sub(r'^[１２３４５６７８９０]+．\s+', '', line)
                if title:
                    directory.append({
                        "level": 1,
                        "title": title,
                        "id": f"section-{i}"
                    })
            
            # 匹配特殊字符分隔的标题：=== 标题 ===、--- 标题 ---
            elif re.match(r'^={3,}\s*.+\s*={3,}$', line):
                title = re.sub(r'^={3,}\s*(.+?)\s*={3,}$', r'\1', line)
                if title:
                    directory.append({
                        "level": 1,
                        "title": title,
                        "id": f"section-{i}"
                    })
            elif re.match(r'^-{3,}\s*.+\s*-{3,}$', line):
                title = re.sub(r'^-{3,}\s*(.+?)\s*-{3,}$', r'\1', line)
                if title:
                    directory.append({
                        "level": 2,
                        "title": title,
                        "id": f"section-{i}"
                    })
            
            # 匹配全大写的标题（可能是章节标题）
            elif re.match(r'^[A-Z][A-Z\s]{5,}$', line):
                directory.append({
                    "level": 1,
                    "title": line,
                    "id": f"section-{i}"
                })
            
            # 匹配带括号的标题：【标题】、[标题]
            elif re.match(r'^【.+】$', line) or re.match(r'^\[.+\]$', line):
                directory.append({
                    "level": 1,
                    "title": line,
                    "id": f"section-{i}"
                })
            
            # 匹配关键词开头的标题（如"第一章"、"第二章"）
            elif re.match(r'^第[一二三四五六七八九十]+[章节篇]\s*.+', line):
                directory.append({
                    "level": 1,
                    "title": line,
                    "id": f"section-{i}"
                })
    return directory

# 获取文档可浏览内容（用于前端页面内查看）
@app.get("/api/documents/{doc_id}/view")
async def get_document_view(doc_id: str):
    docs = load_documents_meta()
    target = next((d for d in docs if d.get("id") == doc_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Document not found")

    # 使用文件名构建路径，而不是存储的完整路径
    filename_in_storage = f"{doc_id}{target['metadata']['file_type']}"
    file_path = UPLOADS_DIR / filename_in_storage
    
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Stored file not found")

    ext = file_path.suffix.lower()
    filename = target.get("metadata", {}).get("filename", file_path.name)

    if ext in {".txt", ".md"}:
        text = file_path.read_text(encoding="utf-8", errors="ignore")
        directory = extract_directory(text, ext)
        return {
            "id": doc_id,
            "filename": filename,
            "file_type": ext,
            "view_type": ext[1:],  # 去掉点号，返回 "txt" 或 "md"
            "content": text,
            "directory": directory
        }

    if ext == ".pdf":
        pdf_text = read_pdf_text(file_path)
        directory = extract_directory(pdf_text, ".txt")  # PDF也用txt的目录提取逻辑
        return {
            "id": doc_id,
            "filename": filename,
            "file_type": ext,
            "view_type": "pdf",
            "url": f"/api/documents/{doc_id}/file",
            "content": pdf_text,  # 添加文本内容
            "directory": directory
        }
    elif ext == ".docx":
        # 尝试从DOCX中提取文本并生成目录
        docx_text = read_docx_text_improved(file_path)
        directory = extract_directory(docx_text, ".docx")
        return {
            "id": doc_id,
            "filename": filename,
            "file_type": ext,
            "view_type": "docx",
            "url": f"/api/documents/{doc_id}/file",
            "content": docx_text,  # 添加文本内容
            "directory": directory
        }

    return {
        "id": doc_id,
        "filename": filename,
        "file_type": ext,
        "view_type": "unsupported",
        "message": "当前文件类型暂不支持页面内预览。",
        "directory": []
    }


# 向量检索（保留）
@app.post("/api/retrieve")
async def retrieve_documents(request: QueryRequest):
    try:
        results = collection.query(query_texts=[request.question], n_results=request.top_k)
        retrieved_docs = []
        for i, doc in enumerate(results["documents"][0]):
            retrieved_docs.append(
                {
                    "id": results["ids"][0][i],
                    "content": doc,
                    "metadata": results["metadatas"][0][i],
                    "distance": results["distances"][0][i] if "distances" in results else None,
                }
            )
        return {"documents": retrieved_docs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 智能问答（RAG）
@app.post("/api/chat")
def chat(
    request: QueryRequest,
    rag_enabled: bool = Query(default=True, description="Whether to use RAG"),
    stream: bool = Query(default=False, description="Whether to stream the response"),
):
    try:
        context = ""
        sources = []
        seen_filenames: set[str] = set()

        if rag_enabled:
            try:
                total_in_db = collection.count()
            except Exception:
                total_in_db = 0

            n_results = min(request.top_k, total_in_db) if total_in_db > 0 else 0

            if n_results > 0:
                results = collection.query(
                    query_texts=[request.question], n_results=n_results
                )
                context_parts = []
                max_context_length = 60000
                for i, doc in enumerate(results["documents"][0]):
                    current_len = sum(len(p) for p in context_parts) + len(context_parts) * 5
                    if current_len + len(doc) > max_context_length:
                        break
                    context_parts.append(doc)
                    meta = results["metadatas"][0][i]
                    fname = meta.get("filename", "Unknown")
                    doc_id = meta.get("doc_id", results["ids"][0][i])
                    if fname not in seen_filenames:
                        seen_filenames.add(fname)
                        raw_rel = (1.0 - results["distances"][0][i]) if "distances" in results else 0.9
                        sources.append({
                            "id": doc_id,
                            "filename": fname,
                            "relevance": round(max(0.0, min(1.0, raw_rel)), 3),
                        })
                context = "\n---\n".join(context_parts)

        attachment_context = ""
        if request.attachment_text and request.attachment_filename:
            max_attachment_len = 30000
            att_text = request.attachment_text[:max_attachment_len]
            attachment_context = f"\n\n【用户附件《{request.attachment_filename}》内容】：\n{att_text}"
            sources.append({
                "id": "attachment",
                "filename": request.attachment_filename,
                "relevance": 1.0,
            })

        has_rag_context = rag_enabled and context
        has_attachment = bool(attachment_context)

        if has_rag_context or has_attachment:
            system_prompt = (
                "你是一个专业的知识库助手。系统会提供参考资料和/或用户上传的附件内容。\n"
                "要求：\n"
                "1. 综合所有参考资料和附件内容进行回答，尽量覆盖相关信息。\n"
                "2. 引用具体信息时，请注明来源文件名（如：根据《xxx.pdf》...）。\n"
                "3. 如果参考资料中没有相关信息，请如实说明，并尝试给出你自己的理解。\n"
                "4. 回答使用中文，语言简洁清晰，条理分明。"
            )
        else:
            system_prompt = "你是一个知识助手，请用中文回答用户的问题，语言简洁清晰。"

        user_message_parts = []
        if has_rag_context:
            user_message_parts.append(f"以下是从知识库中检索到的参考资料：\n\n{context}")
        if has_attachment:
            user_message_parts.append(attachment_context)
        user_message_parts.append(f"用户问题：{request.question}" if (has_rag_context or has_attachment) else request.question)
        user_message = "\n\n".join(user_message_parts)

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ]

        deepseek = get_deepseek_client()
        try:
            response = deepseek.chat.completions.create(
                model=DEEPSEEK_MODEL,
                messages=messages,
                stream=stream,
                stream_options={"include_usage": True} if stream else None,
                max_tokens=4000,
                temperature=0.7,
                extra_body={"thinking": {"type": "disabled"}},
            )
        except APIError as error:
            deepseek.close()
            raise deepseek_error(error) from error

        if stream:
            def generate():
                token_usage = 0
                try:
                    with response:
                        for chunk in response:
                            if chunk.usage:
                                token_usage = chunk.usage.total_tokens
                            if chunk.choices and chunk.choices[0].delta.content:
                                yield json.dumps({"type": "text", "content": chunk.choices[0].delta.content}) + "\n"
                except APIError as error:
                    yield json.dumps({"type": "error", "message": deepseek_error(error).detail}) + "\n"
                    return
                finally:
                    deepseek.close()
                if sources:
                    yield json.dumps({"type": "sources", "sources": sources}) + "\n"
                yield json.dumps({"type": "end", "token_usage": token_usage}) + "\n"

            return StreamingResponse(generate(), media_type="application/x-ndjson")

        deepseek.close()
        answer = response.choices[0].message.content if response.choices else None
        if not answer:
            raise HTTPException(status_code=502, detail="DeepSeek 未返回有效回答，请重试")
        return {
            "answer": answer,
            "sources": sources,
            "model_used": DEEPSEEK_MODEL,
            "token_usage": response.usage.total_tokens if response.usage else 0,
        }
    except HTTPException:
        raise
    except Exception as error:
        print(f"[chat] {type(error).__name__}: {error}")
        raise HTTPException(status_code=500, detail="知识库问答处理失败，请检查后端日志") from error

# 文档智能总结
@app.post("/api/documents/{doc_id}/summary")
def generate_document_summary(doc_id: str):
    try:
        docs = load_documents_meta()
        target = next((d for d in docs if d.get("id") == doc_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Document not found")

        file_path = Path(target.get("metadata", {}).get("path", ""))
        if not file_path.exists() or not file_path.is_file():
            raise HTTPException(status_code=404, detail="Stored file not found")

        ext = file_path.suffix.lower()
        filename = target.get("metadata", {}).get("filename", file_path.name)

        # 读取文档内容
        content = ""
        if ext in {".txt", ".md"}:
            content = file_path.read_text(encoding="utf-8", errors="ignore")
        elif ext == ".docx":
            content = read_docx_text(file_path)
        else:
            raise HTTPException(status_code=400, detail="Unsupported file type for summary generation")

        if not content or len(content.strip()) < 10:
            raise HTTPException(status_code=400, detail="Document content is too short or empty")

        # 限制内容长度，避免超出token限制
        max_content_length = 8000
        if len(content) > max_content_length:
            content = content[:max_content_length] + "..."

        # 构建总结提示词
        prompt = f"""请为以下文档生成一个简洁明了的总结，重点突出文档的主要内容和结论。

文档名称：{filename}
文档内容：
{content}

请用中文回答，总结应该：
1. 简短全面，控制在200字以内
2. 重点突出文档的主要内容和核心观点
3. 避免使用多余的符号和标记
4. 直接输出总结内容，不要添加任何前缀或后缀

总结："""

        try:
            with get_deepseek_client() as deepseek:
                response = deepseek.chat.completions.create(
                    model=DEEPSEEK_MODEL,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=300,
                    temperature=0.5,
                    extra_body={"thinking": {"type": "disabled"}},
                )
        except APIError as error:
            raise deepseek_error(error) from error

        summary = response.choices[0].message.content if response.choices else None
        if not summary:
            raise HTTPException(status_code=502, detail="DeepSeek 未返回有效摘要，请重试")
        summary = summary.replace("*", "").strip()
        token_usage = response.usage.total_tokens if response.usage else 0

        return {
            "document_id": doc_id,
            "filename": filename,
            "summary": summary,
            "model_used": DEEPSEEK_MODEL,
            "token_usage": token_usage
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 文件夹相关API

# 创建文件夹
@app.post("/api/folders")
async def create_folder(name: str = Query(..., description="Folder name"), parent_id: str = Query(None, description="Parent folder ID")):
    try:
        folders = load_folders_meta()
        
        # 检查文件夹名称是否已存在
        if any(folder.get("name") == name and folder.get("parent_id") == parent_id for folder in folders):
            raise HTTPException(status_code=400, detail="Folder with this name already exists in the specified parent folder")
        
        folder_id = generate_folder_id(folders)
        now = datetime.utcnow().isoformat() + "Z"
        
        new_folder = {
            "id": folder_id,
            "name": name,
            "parent_id": parent_id,
            "created_at": now,
            "updated_at": now
        }
        
        folders.append(new_folder)
        save_folders_meta(folders)
        
        return {
            "message": "Folder created successfully",
            "folder": new_folder
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 获取文件夹列表
@app.get("/api/folders")
async def get_folders(parent_id: str = Query(None, description="Parent folder ID")):
    try:
        folders = load_folders_meta()
        
        if parent_id:
            # 获取指定父文件夹下的子文件夹
            filtered_folders = [folder for folder in folders if folder.get("parent_id") == parent_id]
        else:
            # 获取根文件夹
            filtered_folders = [folder for folder in folders if folder.get("parent_id") is None]
        
        return {"folders": filtered_folders}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 重命名文件夹
@app.put("/api/folders/{folder_id}")
async def rename_folder(folder_id: str, name: str = Query(..., description="New folder name")):
    try:
        folders = load_folders_meta()
        
        # 查找文件夹
        folder_index = next((i for i, folder in enumerate(folders) if folder.get("id") == folder_id), -1)
        if folder_index == -1:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        folder = folders[folder_index]
        parent_id = folder.get("parent_id")
        
        # 检查新名称是否与同一父文件夹下的其他文件夹重复
        if any(f.get("name") == name and f.get("parent_id") == parent_id and f.get("id") != folder_id for f in folders):
            raise HTTPException(status_code=400, detail="Folder with this name already exists in the specified parent folder")
        
        # 更新文件夹名称
        folder["name"] = name
        folder["updated_at"] = datetime.utcnow().isoformat() + "Z"
        
        folders[folder_index] = folder
        save_folders_meta(folders)
        
        return {
            "message": "Folder renamed successfully",
            "folder": folder
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 删除文件夹
@app.delete("/api/folders/{folder_id}")
async def delete_folder(folder_id: str):
    try:
        folders = load_folders_meta()
        docs = load_documents_meta()
        
        # 查找文件夹
        folder_index = next((i for i, folder in enumerate(folders) if folder.get("id") == folder_id), -1)
        if folder_index == -1:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        # 检查文件夹是否有子文件夹
        has_children = any(folder.get("parent_id") == folder_id for folder in folders)
        if has_children:
            raise HTTPException(status_code=400, detail="Cannot delete folder with subfolders")
        
        # 检查文件夹是否有文件
        has_files = any(doc.get("metadata", {}).get("folder_id") == folder_id for doc in docs)
        if has_files:
            raise HTTPException(status_code=400, detail="Cannot delete folder with files")
        
        # 删除文件夹
        folders.pop(folder_index)
        save_folders_meta(folders)
        
        return {"message": "Folder deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 移动文件到文件夹
@app.put("/api/documents/{doc_id}/move")
async def move_document(doc_id: str, folder_id: str = Query(..., description="Target folder ID")):
    try:
        docs = load_documents_meta()
        folders = load_folders_meta()
        
        # 查找文件
        doc_index = next((i for i, doc in enumerate(docs) if doc.get("id") == doc_id), -1)
        if doc_index == -1:
            raise HTTPException(status_code=404, detail="Document not found")
        
        # 查找目标文件夹
        if folder_id and not any(folder.get("id") == folder_id for folder in folders):
            raise HTTPException(status_code=404, detail="Target folder not found")
        
        # 更新文件的文件夹ID
        docs[doc_index]["metadata"]["folder_id"] = folder_id
        save_documents_meta(docs)
        
        return {
            "message": "Document moved successfully",
            "document": docs[doc_index]
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 复制文件到文件夹
@app.post("/api/documents/{doc_id}/copy")
async def copy_document(doc_id: str, folder_id: str = Query(..., description="Target folder ID")):
    try:
        docs = load_documents_meta()
        folders = load_folders_meta()
        
        # 查找文件
        doc = next((doc for doc in docs if doc.get("id") == doc_id), None)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        
        # 查找目标文件夹
        if folder_id and not any(folder.get("id") == folder_id for folder in folders):
            raise HTTPException(status_code=404, detail="Target folder not found")
        
        # 复制文件
        new_doc_id = generate_doc_id(docs)
        new_doc = {
            "id": new_doc_id,
            "metadata": doc["metadata"].copy()
        }
        new_doc["metadata"]["folder_id"] = folder_id
        new_doc["metadata"]["uploaded_at"] = datetime.utcnow().isoformat() + "Z"
        
        docs.append(new_doc)
        save_documents_meta(docs)
        
        return {
            "message": "Document copied successfully",
            "document": new_doc
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 批量操作文件
@app.post("/api/documents/batch")
async def batch_operate_documents(operation: str = Query(..., description="Operation: move, delete, rename, tag, reindex"), doc_ids: str = Query(..., description="Comma-separated document IDs"), folder_id: str = Query(None, description="Target folder ID for move operation"), new_name: str = Query(None, description="New name for rename operation"), tags: str = Query(None, description="Comma-separated tags for tag operation")):
    try:
        docs = load_documents_meta()
        folders = load_folders_meta()
        
        doc_id_list = [id.strip() for id in doc_ids.split(",")]
        
        if operation == "move":
            # 查找目标文件夹
            if not folder_id:
                raise HTTPException(status_code=400, detail="Target folder ID is required for move operation")
            if not any(folder.get("id") == folder_id for folder in folders):
                raise HTTPException(status_code=404, detail="Target folder not found")
            
            # 移动文件
            for doc_id in doc_id_list:
                doc_index = next((i for i, doc in enumerate(docs) if doc.get("id") == doc_id), -1)
                if doc_index != -1:
                    docs[doc_index]["metadata"]["folder_id"] = folder_id
            
            save_documents_meta(docs)
            return {"message": f"Successfully moved {len(doc_id_list)} documents"}
        
        elif operation == "delete":
            new_docs = [doc for doc in docs if doc.get("id") not in doc_id_list]
            save_documents_meta(new_docs)
            for doc_id in doc_id_list:
                delete_document_from_chroma(doc_id)
                doc = next((d for d in docs if d.get("id") == doc_id), None)
                if doc:
                    file_path = Path(doc.get("metadata", {}).get("path", ""))
                    if file_path.exists() and file_path.is_file():
                        try:
                            file_path.unlink()
                        except Exception:
                            pass
            return {"message": f"Successfully deleted {len(doc_id_list)} documents"}
        
        elif operation == "rename":
            # 重命名文件
            if not new_name:
                raise HTTPException(status_code=400, detail="New name is required for rename operation")
            if len(doc_id_list) != 1:
                raise HTTPException(status_code=400, detail="Rename operation only supports single document")
            
            doc_id = doc_id_list[0]
            doc_index = next((i for i, doc in enumerate(docs) if doc.get("id") == doc_id), -1)
            if doc_index != -1:
                docs[doc_index]["metadata"]["filename"] = new_name
                save_documents_meta(docs)
                return {"message": "Document renamed successfully"}
            else:
                raise HTTPException(status_code=404, detail="Document not found")
        
        elif operation == "tag":
            # 批量打标签
            if not tags:
                raise HTTPException(status_code=400, detail="Tags are required for tag operation")
            tag_list = [tag.strip() for tag in tags.split(",") if tag.strip()]
            
            for doc_id in doc_id_list:
                doc_index = next((i for i, doc in enumerate(docs) if doc.get("id") == doc_id), -1)
                if doc_index != -1:
                    docs[doc_index]["metadata"]["tags"] = tag_list
            
            save_documents_meta(docs)
            return {"message": f"Successfully tagged {len(doc_id_list)} documents"}
        
        elif operation == "reindex":
            for doc_id in doc_id_list:
                doc_index = next((i for i, doc in enumerate(docs) if doc.get("id") == doc_id), -1)
                if doc_index != -1:
                    doc = docs[doc_index]
                    file_path = Path(doc.get("metadata", {}).get("path", ""))
                    if not (file_path.exists() and file_path.is_file()):
                        continue
                    ext = file_path.suffix.lower()
                    original_name = doc.get("metadata", {}).get("filename", file_path.name)
                    file_size = doc.get("metadata", {}).get("size", 0)
                    try:
                        if ext in {".txt", ".md"}:
                            parsed_text = file_path.read_text(encoding="utf-8", errors="ignore")
                        elif ext == ".pdf":
                            parsed_text = read_pdf_text(file_path)
                        elif ext == ".docx":
                            parsed_text = read_docx_text_improved(file_path)
                        else:
                            doc["metadata"]["status"] = "stored_only"
                            continue
                        if parsed_text.strip():
                            index_document_to_chroma(doc_id, parsed_text, original_name, file_size)
                            doc["metadata"]["status"] = "parsed"
                            doc["metadata"].pop("error_message", None)
                        else:
                            doc["metadata"]["status"] = "no_text_extracted"
                    except Exception as e:
                        doc["metadata"]["status"] = "failed"
                        doc["metadata"]["error_message"] = str(e)

            save_documents_meta(docs)
            return {"message": f"Successfully reindexed {len(doc_id_list)} documents"}
        
        else:
            raise HTTPException(status_code=400, detail="Invalid operation. Supported operations: move, delete, rename, tag, reindex")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 文件搜索与筛选
@app.get("/api/documents/search")
async def search_documents(
    query: str = Query(None, description="Search query"),
    folder_id: str = Query(None, description="Folder ID"),
    file_type: str = Query(None, description="File type"),
    sort_by: str = Query("uploaded_at", description="Sort by: uploaded_at, filename, size"),
    sort_order: str = Query("desc", description="Sort order: asc, desc")
):
    try:
        docs = load_documents_meta()
        
        # 筛选文件
        filtered_docs = docs
        
        if query:
            filtered_docs = [doc for doc in filtered_docs if query.lower() in doc.get("metadata", {}).get("filename", "").lower()]
        
        if folder_id is not None:
            # 如果是默认文件夹，也显示folder_id为null的文件
            if folder_id == "folder_1":
                filtered_docs = [doc for doc in filtered_docs if doc.get("metadata", {}).get("folder_id") == folder_id or doc.get("metadata", {}).get("folder_id") is None]
            else:
                filtered_docs = [doc for doc in filtered_docs if doc.get("metadata", {}).get("folder_id") == folder_id]
        
        if file_type:
            filtered_docs = [doc for doc in filtered_docs if doc.get("metadata", {}).get("file_type") == file_type]
        
        # 排序文件
        if sort_by == "uploaded_at":
            filtered_docs.sort(key=lambda x: x.get("metadata", {}).get("uploaded_at", ""), reverse=(sort_order == "desc"))
        elif sort_by == "filename":
            filtered_docs.sort(key=lambda x: x.get("metadata", {}).get("filename", ""), reverse=(sort_order == "desc"))
        elif sort_by == "size":
            filtered_docs.sort(key=lambda x: x.get("metadata", {}).get("size", 0), reverse=(sort_order == "desc"))
        
        return {"documents": filtered_docs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 重建文档索引
@app.post("/api/documents/{doc_id}/reindex")
async def reindex_document(doc_id: str):
    try:
        docs = load_documents_meta()
        target = next((d for d in docs if d.get("id") == doc_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Document not found")

        file_path = Path(target.get("metadata", {}).get("path", ""))
        if not file_path.exists() or not file_path.is_file():
            raise HTTPException(status_code=404, detail="Stored file not found")

        ext = file_path.suffix.lower()
        original_name = target.get("metadata", {}).get("filename", file_path.name)
        file_size = target.get("metadata", {}).get("size", 0)

        # 更新状态为处理中
        target["metadata"]["status"] = "processing"
        save_documents_meta(docs)

        try:
            parsed_text = ""
            if ext in {".txt", ".md"}:
                parsed_text = file_path.read_text(encoding="utf-8", errors="ignore")
            elif ext == ".pdf":
                parsed_text = read_pdf_text(file_path)
            elif ext == ".docx":
                parsed_text = read_docx_text_improved(file_path)

            if parsed_text.strip():
                index_document_to_chroma(doc_id, parsed_text, original_name, file_size)
                target["metadata"]["status"] = "parsed"
                target["metadata"].pop("error_message", None)
            else:
                target["metadata"]["status"] = "no_text_extracted"
        except Exception as e:
            target["metadata"]["status"] = "failed"
            target["metadata"]["error_message"] = str(e)
        save_documents_meta(docs)
        return {"message": "Document reindexed successfully", "document": target}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 更新文档元数据
@app.put("/api/documents/{doc_id}/metadata")
async def update_document_metadata(doc_id: str, tags: str = Query(None, description="Comma-separated tags"), source: str = Query(None, description="Source"), project: str = Query(None, description="Project"), author: str = Query(None, description="Author")):
    try:
        docs = load_documents_meta()
        target = next((d for d in docs if d.get("id") == doc_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Document not found")

        # 更新元数据
        if tags is not None:
            target["metadata"]["tags"] = [tag.strip() for tag in tags.split(",") if tag.strip()]
        if source is not None:
            target["metadata"]["source"] = source
        if project is not None:
            target["metadata"]["project"] = project
        if author is not None:
            target["metadata"]["author"] = author

        save_documents_meta(docs)
        return {"message": "Document metadata updated successfully", "document": target}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 更新文档访问时间
@app.put("/api/documents/{doc_id}/access")
async def update_document_access(doc_id: str):
    try:
        docs = load_documents_meta()
        target = next((d for d in docs if d.get("id") == doc_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Document not found")

        # 更新最近访问时间
        now = datetime.utcnow().isoformat() + "Z"
        target["metadata"]["last_accessed_at"] = now

        save_documents_meta(docs)
        return {"message": "Document access time updated successfully", "document": target}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 切换文档收藏状态
@app.put("/api/documents/{doc_id}/favorite")
async def toggle_document_favorite(doc_id: str, is_favorite: bool = Query(..., description="Whether to mark as favorite")):
    try:
        docs = load_documents_meta()
        target = next((d for d in docs if d.get("id") == doc_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Document not found")

        # 更新收藏状态
        target["metadata"]["is_favorite"] = is_favorite

        save_documents_meta(docs)
        return {"message": "Document favorite status updated successfully", "document": target}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 清空所有文件和文件夹
@app.delete("/api/clear-all")
async def clear_all_data():
    try:
        try:
            all_ids = collection.get()['ids']
            if all_ids:
                collection.delete(ids=all_ids)
        except Exception:
            pass
        
        # 清空文件元数据
        save_documents_meta([])
        
        # 清空文件夹元数据
        save_folders_meta([])
        
        # 删除所有上传的文件
        ensure_storage_ready()
        for file_path in UPLOADS_DIR.iterdir():
            if file_path.is_file():
                try:
                    file_path.unlink()
                except Exception:
                    pass
        
        return {"message": "All data cleared successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/debug/embedding-test")
async def debug_embedding_test():
    """测试本地文本向量模型。"""
    try:
        emb = local_embedding(["用于验证本地向量模型的测试文本"])[0]
        return {
            "status": "ok",
            "model": EMBEDDING_MODEL,
            "embedding_dim": len(emb),
            "non_zero_values": sum(1 for value in emb if value != 0.0),
        }
    except Exception as error:
        return {"status": "exception", "error": str(error)}


@app.get("/api/debug/chroma-status")
async def debug_chroma_status():
    """检查 ChromaDB 中各文档的索引状态"""
    try:
        all_data = collection.get(include=["embeddings", "metadatas"])
        doc_stats: dict = {}
        for i, meta in enumerate(all_data.get("metadatas") or []):
            doc_id = meta.get("doc_id", "unknown")
            if doc_id not in doc_stats:
                doc_stats[doc_id] = {"filename": meta.get("filename", "?"), "chunks": 0, "zero_vectors": 0}
            doc_stats[doc_id]["chunks"] += 1
            emb = all_data["embeddings"][i] if all_data.get("embeddings") is not None else None
            if emb is not None and all(v == 0.0 for v in emb):
                doc_stats[doc_id]["zero_vectors"] += 1
        return {"collection": collection.name, "total_chunks": len(all_data.get("ids", [])), "documents": doc_stats}
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
