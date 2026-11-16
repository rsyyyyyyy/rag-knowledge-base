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
}

export const getDocumentView = async (documentId: string): Promise<DocumentViewResponse> => {
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/view`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || 'Failed to load document view');
  }
  return data as DocumentViewResponse;
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
  evidence_id?: string;
  document_version_id?: string;
  version_id?: string;
  page_index?: number;
  rects?: [number, number, number, number][];
  id: string;
  filename: string;
  chunk_id?: string;
  excerpt: string;
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
export const chatStream = async (
  question: string,
  top_k: number = 3,
  rag_enabled: boolean = true,
  onChunk: (chunk: string) => void,
  onComplete: (sources: Source[], tokenUsage: number) => void,
  attachmentText?: string,
  attachmentFilename?: string,
): Promise<void> => {
  const body: Record<string, unknown> = { question, top_k, rag_enabled };
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
      } else if (data.type === 'sources') {
        sources = data.sources;
      } else if (data.type === 'error') {
        throw new Error(data.message);
      } else if (data.type === 'end') {
        await reader.cancel();
        onComplete(sources, data.token_usage ?? 0);
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
export const updateDocumentMetadata = async (docId: string, metadata: { tags?: string[]; source?: string; project?: string; author?: string }): Promise<{ message: string; document: Document }> => {
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

  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(docId)}/metadata?${params.toString()}`, {
    method: 'PUT',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.detail || 'Failed to update document metadata');
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