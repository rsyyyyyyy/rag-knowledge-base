const API_BASE_URL = import.meta.env.DEV
  ? '/api'
  : (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8001/api');

export function getDocumentFileUrl(documentId: string, versionId?: string): string {
  const url = `${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/file`;
  return versionId ? `${url}?version_id=${encodeURIComponent(versionId)}` : url;
}

export interface DirectoryItem {
  level: number;
  title: string;
  id: string;
}

export interface DocumentViewResponse {
  id: string;
  filename: string;
  file_type: string;
  view_type: 'text' | 'txt' | 'md' | 'pdf' | 'docx' | 'unsupported';
  content?: string;
  url?: string;
  message?: string;
  directory?: DirectoryItem[];
  version_id?: string;
}

export const getDocumentView = async (documentId: string, includePdfText = true): Promise<DocumentViewResponse> => {
  const query = includePdfText ? '' : '?include_pdf_text=false';
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/view${query}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || 'Failed to load document view');
  }
  return data as DocumentViewResponse;
};

export interface DocumentOutlineItem {
  title: string;
  level: number;
  page_index: number;
}

export interface DocumentSection {
  id: string;
  parent_id: string | null;
  title: string;
  level: number;
  position: number;
  page_start: number | null;
  page_end: number | null;
  heading_detected: boolean | number;
}

export interface DocumentStructure {
  document_id: string;
  version_id: string | null;
  generation: string | null;
  structure_version: string;
  sections: DocumentSection[];
}

export interface SectionReading {
  section_id: string;
  title: string;
  version_id: string;
  generation: string;
  evidence: Source[];
  total: number;
  next_offset: number | null;
}

export type ProfileFacet = 'research_question' | 'methodology' | 'findings' | 'conditions' | 'limitations';

export interface ProfileNote {
  id: string;
  facet: ProfileFacet | 'overview';
  text: string;
  evidence: Source[];
}

export interface ReadingArtifact {
  version_id: string;
  generation: string;
  model: string;
  created_at: string;
  partial: boolean;
  fields: Record<ProfileFacet, string[]>;
  notes: ProfileNote[];
  sections: (DocumentSection & { note_ids: string[]; status: 'ready' | 'not_confirmed' })[];
}

export interface ProfileResponse {
  state: 'not_ready' | 'not_generated' | 'queued' | 'processing' | 'ready' | 'partial' | 'failed' | 'cancelled';
  artifact: ReadingArtifact | null;
  error: string | null;
  progress: { completed: number; total: number; stage: string } | null;
}

export async function getDocumentProfile(documentId: string, versionId: string, signal?: AbortSignal): Promise<ProfileResponse> {
  const params = new URLSearchParams({ version_id: versionId });
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/profile?${params}`, { signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || '读取文献卡片失败');
  return data;
}

export async function generateDocumentProfile(
  documentId: string, versionId: string, force = false, signal?: AbortSignal,
): Promise<ProfileResponse> {
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/profile`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version_id: versionId, force }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || '生成文献卡片失败');
  return data;
}

export async function getDocumentSections(documentId: string, versionId: string, signal?: AbortSignal): Promise<DocumentStructure> {
  const params = new URLSearchParams({ version_id: versionId });
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/sections?${params}`, { signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || '读取章节失败');
  return data;
}

export async function readDocumentSection(
  documentId: string, sectionId: string, versionId: string,
  generation: string, offset = 0, signal?: AbortSignal,
): Promise<SectionReading> {
  const response = await fetch(`${API_BASE_URL}/knowledge/read-section`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      document_id: documentId, section_id: sectionId,
      document_ids: [documentId], version_id: versionId, generation, offset, limit: 10,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || '读取章节正文失败');
  return data;
}

export type AnnotationKind = 'highlight' | 'underline' | 'note';

export interface PdfAnnotation {
  id: string;
  document_id: string;
  version_id: string;
  page_index: number;
  kind: AnnotationKind;
  color: string;
  rects: [number, number, number, number][];
  quote: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface AnnotationDraft {
  page_index: number;
  kind: AnnotationKind;
  color: string;
  rects: [number, number, number, number][];
  quote: string;
  note: string;
}

export const getDocumentOutline = async (documentId: string): Promise<DocumentOutlineItem[]> => {
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/outline`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || 'Failed to load document outline');
  }
  return (data.outline ?? []) as DocumentOutlineItem[];
};

export const getDocumentAnnotations = async (
  documentId: string,
  versionId: string,
): Promise<PdfAnnotation[]> => {
  const params = new URLSearchParams({ version_id: versionId });
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/annotations?${params}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || 'Failed to load PDF annotations');
  }
  return (data.annotations ?? []) as PdfAnnotation[];
};

export const createDocumentAnnotation = async (
  documentId: string,
  versionId: string,
  draft: AnnotationDraft,
): Promise<PdfAnnotation> => {
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...draft, version_id: versionId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || 'Failed to create PDF annotation');
  }
  return data as PdfAnnotation;
};

export const updateDocumentAnnotation = async (
  documentId: string,
  annotationId: string,
  patch: { note?: string; color?: string; kind?: AnnotationKind },
): Promise<PdfAnnotation> => {
  const response = await fetch(
    `${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/annotations/${encodeURIComponent(annotationId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || 'Failed to update PDF annotation');
  }
  return data as PdfAnnotation;
};

export const deleteDocumentAnnotation = async (
  documentId: string,
  annotationId: string,
): Promise<void> => {
  const response = await fetch(
    `${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/annotations/${encodeURIComponent(annotationId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 204) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.detail || 'Failed to delete PDF annotation');
  }
};

// 文档类型
export interface Document {
  id: string;
  metadata: {
    filename: string;
    size: number;
    status?: string;
    job_id?: string;
    searchable?: boolean;
    error_message?: string | null;
    uploaded_at: string;
    [key: string]: unknown;
  };
}

// 检索结果类型
export interface RetrievedDocument extends Document {
  content: string;
  distance?: number | null;
  similarity?: number | null;
  rank_signals?: { lexical?: number; vector?: number };
  fusion_score?: number | null;
}

// 来源类型
export interface Source {
  section_id?: string | null;
  evidence_id?: string;
  citation_number?: number;
  citation_precision?: 'fragment' | 'page' | 'line' | 'quote' | 'text';
  span_id?: string;
  element_refs?: string[];
  claim?: string;
  excerpt_start?: number;
  excerpt_end?: number;
  document_version_id?: string;
  version_id?: string;
  page_index?: number;
  rects?: [number, number, number, number][];
  id: string;
  filename: string;
  chunk_id?: string;
  excerpt: string;
  attachmentBasis?: 'pdf' | 'abstract';
  sourceUrl?: string;
}

export interface PaperMatch {
  relevance?: 'direct' | 'possible';
  document_id: string;
  version_id: string;
  filename: string;
  title: string;
  rank_signals: Record<string, number>;
  matched_notes: ProfileNote[];
  body_previews: { text: string; source: Source }[];
}

export interface PaperSearchResult {
  papers: PaperMatch[];
  warnings: string[];
  ranking_note: string;
}

export async function discoverPapers(query: string, folderId: string | undefined, signal: AbortSignal): Promise<PaperSearchResult> {
  const response = await fetch(`${API_BASE_URL}/knowledge/search-papers`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: 5, retrieval_mode: 'multilevel',
      ...(folderId ? { folder_ids: [folderId] } : {}) }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(typeof detail.detail === 'string' ? detail.detail : '查找文献失败，请重试');
  }
  return response.json();
}

// 问答响应类型
export interface ChatResponse {
  answer: string;
  sources: Source[];
  model_used: string;
  token_usage?: number;
}

// 上传文档
export const uploadDocument = async (file: File, folderId?: string, onProgress?: (progress: number) => void): Promise<{ message: string; document_id: string; document?: Document; duplicate?: boolean }> => {
  const formData = new FormData();
  formData.append('file', file);
  if (folderId !== undefined) {
    formData.append('folder_id', folderId);
  }

  const url = `${API_BASE_URL}/documents/upload`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress(progress);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data);
        } catch (error) {
          reject(new Error('Failed to parse response'));
        }
      } else {
        try {
          const data = JSON.parse(xhr.responseText);
          reject(new Error(data?.detail || 'Failed to upload document'));
        } catch (error) {
          reject(new Error('Failed to upload document'));
        }
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Network error'));
    });

    xhr.open('POST', url);
    xhr.send(formData);
  });
};

export async function replaceDocument(documentId: string, file: File): Promise<{ document: Document }> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(API_BASE_URL + '/documents/' + encodeURIComponent(documentId) + '/versions', {
    method: 'POST', body: formData,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail || '替换文件失败');
  }
  return response.json();
}

// 获取文档列表
export const getDocuments = async (): Promise<Document[]> => {
  const response = await fetch(`${API_BASE_URL}/documents`);

  if (!response.ok) {
    throw new Error('Failed to get documents');
  }

  const data = await response.json();
  return data.documents;
};

// 向量检索
export const retrieveDocuments = async (question: string, top_k: number = 3): Promise<RetrievedDocument[]> => {
  const response = await fetch(`${API_BASE_URL}/retrieve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question, top_k }),
  });

  if (!response.ok) {
    throw new Error('Failed to retrieve documents');
  }

  const data = await response.json();
  return data.documents;
};

// 仅解析文件（不入库）
export const parseFileOnly = async (file: File): Promise<{ filename: string; size: number; text: string; message: string }> => {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_BASE_URL}/documents/parse-only`, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.detail || 'Failed to parse file');
  }
  return response.json();
};

// 智能问答
export const chat = async (
  question: string,
  top_k: number = 3,
  rag_enabled: boolean = true,
  attachmentText?: string,
  attachmentFilename?: string,
): Promise<ChatResponse> => {
  const body: Record<string, unknown> = { question, top_k, rag_enabled };
  if (attachmentText) body.attachment_text = attachmentText;
  if (attachmentFilename) body.attachment_filename = attachmentFilename;

  const response = await fetch(`${API_BASE_URL}/chat?rag_enabled=${rag_enabled}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || '问答请求失败，请稍后重试');
  }

  return response.json();
};

// 流式智能问答
export interface OnlinePaper {
  id: string;
  title: string;
  year: number | null;
  authors: string[];
  doi: string | null;
  source_url: string;
  pdf_url: string | null;
  can_download: boolean;
  abstract: string;
}

async function onlinePaperRequest(path: string) {
  const response = await fetch(`${API_BASE_URL}/online-papers${path}`);
  if (!response.ok) {
    const info = await response.json().catch(() => ({}));
    throw new Error(typeof info.detail === 'string' ? info.detail : '联网找论文请求失败。');
  }
  return response;
}

export async function searchOnlinePapers(query: string): Promise<OnlinePaper[]> {
  const response = await onlinePaperRequest(`?q=${encodeURIComponent(query)}`);
  const result: { papers: OnlinePaper[] } = await response.json();
  return result.papers;
}

export async function downloadOnlinePaper(paper: OnlinePaper): Promise<File> {
  const response = await onlinePaperRequest(`/${encodeURIComponent(paper.id)}/pdf`);
  const filename = paper.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 120) + '.pdf';
  return new File([await response.blob()], filename, { type: 'application/pdf' });
}

export interface ChatThread {
  id: string;
  title: string;
}

export interface ChatTurn {
  question: string;
  answer: string;
  attachment_filename?: string | null;
  sources: Source[];
}

async function requestChatHistory<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/chat/threads${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === 'string' ? error.detail : '无法读取或保存会话。');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const listChatThreads = () => requestChatHistory<{ threads: ChatThread[] }>('');
export const createChatThread = () => requestChatHistory<{ id: string }>('', 'POST');
export const getChatThread = (id: string) => requestChatHistory<{ turns: ChatTurn[] }>(`/${encodeURIComponent(id)}`);
export const renameChatThread = (id: string, title: string) => requestChatHistory<ChatThread>(`/${encodeURIComponent(id)}`, 'PATCH', { title });
export const deleteChatThread = (id: string) => requestChatHistory<void>(`/${encodeURIComponent(id)}`, 'DELETE');

export const chatStream = async (
  question: string,
  top_k: number = 3,
  rag_enabled: boolean = true,
  onChunk: (chunk: string) => void,
  onComplete: (sources: Source[], tokenUsage: number, finalAnswer?: string) => void,
  attachmentText?: string,
  attachmentFilename?: string,
  attachmentBasis?: 'pdf' | 'abstract',
  threadId?: string,
  attachmentSourceUrl?: string,
  onVerifyingCitations?: () => void,
): Promise<void> => {
  const body: Record<string, unknown> = { question, top_k, rag_enabled };
  if (threadId) body.thread_id = threadId;
  if (attachmentBasis) body.attachment_basis = attachmentBasis;
  if (attachmentSourceUrl) body.attachment_source_url = attachmentSourceUrl;
  if (attachmentText) body.attachment_text = attachmentText;
  if (attachmentFilename) body.attachment_filename = attachmentFilename;

  const response = await fetch(`${API_BASE_URL}/chat?rag_enabled=${rag_enabled}&stream=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to chat');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let sources: Source[] = [];
  let finalAnswer: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 处理接收到的数据
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      const data = JSON.parse(line);
      if (data.type === 'text' && data.content) {
        onChunk(data.content);
      } else if (data.type === 'answer') {
        finalAnswer = data.content;
      } else if (data.type === 'verifying_citations') {
        onVerifyingCitations?.();
      } else if (data.type === 'sources') {
        sources = data.sources;
      } else if (data.type === 'error') {
        throw new Error(data.message);
      } else if (data.type === 'end') {
        onComplete(sources, data.token_usage ?? 0, finalAnswer);
        await reader.cancel().catch(() => {});
        return;
      }
    }
  }

  throw new Error('问答响应意外中断，请重试');
};

// 文件夹相关API

// 文件夹类型
export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

// 创建文件夹
export const createFolder = async (name: string, parent_id: string | null = null): Promise<{ message: string; folder: Folder }> => {
  const params = new URLSearchParams();
  params.append('name', name);
  if (parent_id) {
    params.append('parent_id', parent_id);
  }

  const response = await fetch(API_BASE_URL + '/folders?' + params.toString(), {
    method: 'POST',
  }).catch(() => {
    throw new Error('无法连接知识库服务，请稍后重试。');
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail || '无法连接知识库服务，请稍后重试。');
  }

  return response.json();
};

// 获取文件夹列表
export const getFolders = async (parent_id: string | null = null): Promise<Folder[]> => {
  const params = new URLSearchParams();
  if (parent_id) {
    params.append('parent_id', parent_id);
  }

  const response = await fetch(`${API_BASE_URL}/folders?${params.toString()}`);

  if (!response.ok) {
    throw new Error('Failed to get folders');
  }

  const data = await response.json();
  return data.folders;
};

// 重命名文件夹
export const renameFolder = async (folder_id: string, name: string): Promise<{ message: string; folder: Folder }> => {
  const params = new URLSearchParams();
  params.append('name', name);

  const response = await fetch(`${API_BASE_URL}/folders/${folder_id}?${params.toString()}`, {
    method: 'PUT',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to rename folder');
  }

  return response.json();
};

// 删除文件夹
export const deleteFolder = async (folder_id: string): Promise<{ message: string }> => {
  const response = await fetch(`${API_BASE_URL}/folders/${folder_id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to delete folder');
  }

  return response.json();
};

// 移动文件到文件夹
export const moveDocument = async (doc_id: string, folder_id: string): Promise<{ message: string; document: Document }> => {
  const params = new URLSearchParams();
  params.append('folder_id', folder_id);

  const response = await fetch(`${API_BASE_URL}/documents/${doc_id}/move?${params.toString()}`, {
    method: 'PUT',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to move document');
  }

  return response.json();
};

// 复制文件到文件夹
export const copyDocument = async (doc_id: string, folder_id: string): Promise<{ message: string; document: Document }> => {
  const params = new URLSearchParams();
  params.append('folder_id', folder_id);

  const response = await fetch(`${API_BASE_URL}/documents/${doc_id}/copy?${params.toString()}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to copy document');
  }

  return response.json();
};

// 批量操作文件
export const batchOperateDocuments = async (operation: 'move' | 'delete' | 'rename' | 'permission', doc_ids: string[], folder_id?: string, new_name?: string): Promise<{ message: string }> => {
  const params = new URLSearchParams();
  params.append('operation', operation);
  params.append('doc_ids', doc_ids.join(','));
  if (folder_id !== undefined) {
    params.append('folder_id', folder_id);
  }
  if (new_name) {
    params.append('new_name', new_name);
  }

  const response = await fetch(`${API_BASE_URL}/documents/batch?${params.toString()}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to batch operate documents');
  }

  return response.json();
};

// 文件搜索与筛选
export const searchDocuments = async (
  query?: string,
  folder_id?: string | null,
  file_type?: string,
  sort_by: string = 'uploaded_at',
  sort_order: 'asc' | 'desc' = 'desc'
): Promise<Document[]> => {
  const params = new URLSearchParams();
  if (query) {
    params.append('query', query);
  }
  if (folder_id !== undefined && folder_id !== null && folder_id !== 'null' && folder_id !== 'undefined') {
    params.append('folder_id', folder_id);
  }
  if (file_type) {
    params.append('file_type', file_type);
  }
  params.append('sort_by', sort_by);
  params.append('sort_order', sort_order);

  const response = await fetch(`${API_BASE_URL}/documents/search?${params.toString()}`);

  if (!response.ok) {
    throw new Error('Failed to search documents');
  }

  const data = await response.json();
  return data.documents;
};

// 重建文档索引
export const reindexDocument = async (docId: string): Promise<{ message: string; document: Document }> => {
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(docId)}/reindex`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to reindex document');
  }

  return response.json();
};

// 更新文档元数据
export const updateDocumentMetadata = async (docId: string, metadata: {
  tags?: string[];
  source?: string;
  project?: string;
  author?: string;
  authors?: string;
  title?: string;
  doi?: string;
  year?: number | string;
  venue?: string;
}): Promise<{ message: string; document: Document }> => {
  const params = new URLSearchParams();
  if (metadata.tags) {
    params.append('tags', metadata.tags.join(','));
  }
  if (metadata.source) {
    params.append('source', metadata.source);
  }
  if (metadata.project) {
    params.append('project', metadata.project);
  }
  if (metadata.author) {
    params.append('author', metadata.author);
  }
  if (metadata.authors) {
    params.append('authors', metadata.authors);
  }
  if (metadata.title) {
    params.append('title', metadata.title);
  }
  if (metadata.doi) {
    params.append('doi', metadata.doi);
  }
  if (metadata.year !== undefined && metadata.year !== '') {
    params.append('year', String(metadata.year));
  }
  if (metadata.venue) {
    params.append('venue', metadata.venue);
  }

  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(docId)}/metadata?${params.toString()}`, {
    method: 'PUT',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to update document metadata');
  }

  return response.json();
};

// 自动补全文献元数据
export const enrichDocumentMetadata = async (
  docIds?: string[],
  force = false,
  limit = 10,
): Promise<{ updated: Document[]; failed: string[]; remaining: number; message: string }> => {
  const params = new URLSearchParams();
  if (docIds?.length) {
    params.append('doc_ids', docIds.join(','));
  }
  params.append('force', String(force));
  params.append('limit', String(limit));

  const response = await fetch(`${API_BASE_URL}/documents/enrich-metadata?${params.toString()}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to enrich document metadata');
  }

  return response.json();
};

// 清空所有文件和文件夹
export const clearAllData = async (): Promise<{ message: string }> => {
  const response = await fetch(`${API_BASE_URL}/clear-all`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to clear all data');
  }

  return response.json();
};

// 更新文档访问时间
export const updateDocumentAccess = async (docId: string): Promise<{ message: string; document: Document }> => {
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(docId)}/access`, {
    method: 'PUT',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to update document access time');
  }

  return response.json();
};

// 切换文档收藏状态
export const toggleDocumentFavorite = async (docId: string, isFavorite: boolean): Promise<{ message: string; document: Document }> => {
  const params = new URLSearchParams();
  params.append('is_favorite', isFavorite.toString());

  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(docId)}/favorite?${params.toString()}`, {
    method: 'PUT',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to update document favorite status');
  }

  return response.json();
};

// 文档智能总结
export const generateDocumentSummary = async (docId: string): Promise<{ document_id: string; filename: string; summary: string; model_used: string; token_usage: number }> => {
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(docId)}/summary`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to generate document summary');
  }

  return response.json();
};
