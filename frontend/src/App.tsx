import React, { useState, useEffect, useRef, useCallback } from 'react';
import { renderAsync } from 'docx-preview';
import { Icon } from '@iconify/react';
import { Modal, Input, Select, message } from 'antd';
import type { Source } from './services/api';
import OnlinePaperSearch, { type OnlinePaperAttachment } from './components/OnlinePaperSearch';
import ReferenceSources, { ReferencePanel, type ReferenceFile } from './components/ReferenceSources';
import { chatStream, parseFileOnly, getDocumentFileUrl, getDocumentView, getDocuments, uploadDocument, reindexDocument, replaceDocument, getFolders, createFolder, renameFolder, deleteFolder, batchOperateDocuments, searchDocuments, updateDocumentAccess, toggleDocumentFavorite, generateDocumentSummary } from './services/api';
import IngestionStatus, { isIngestionPending } from './components/IngestionStatus';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remend, { isWithinCodeBlock } from 'remend';
import type { PdfNavigation, PdfPageJump } from './components/PdfReferencePreview';

const PdfReferencePreview = React.lazy(() => import('./components/PdfReferencePreview'));
const noPdfSources: Source[] = [];

function clampSummaryWidth(width: number) {
  return Math.max(16, Math.min(40, width));
}


function formatStreamingMarkdown(content: string) {
  const markdown = remend(content, { katex: false });
  // A chunk can end immediately after the opening bold marker.
  return isWithinCodeBlock(markdown, markdown.length - 1)
    ? markdown
    : markdown.replace(/(^|\s)\*\*$/, '$1');
}


interface Message {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  complete?: boolean; // 标记消息是否完成
}

interface Document {
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

interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

function App() {
  const formatFileSize = (size: number) => {
    if (!Number.isFinite(size) || size < 0) return '-';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return '-';
    try {
      const date = new Date(dateString);
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (error) {
      return '-';
    }
  };



  const [activeTab, setActiveTab] = useState('ask');
  const [referenceFile, setReferenceFile] = useState<ReferenceFile | null>(null);
  const citationSelection = useRef(0);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showCommandHint, setShowCommandHint] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState(0);
  const [ragEnabled, setRagEnabled] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [chatAttachment, setChatAttachment] = useState<{
    filename: string; text: string; basis?: OnlinePaperAttachment['basis']; sourceUrl?: string;
  } | null>(null);
  const [onlinePaperSearchOpen, setOnlinePaperSearchOpen] = useState(false);
  const [showAttachmentChoice, setShowAttachmentChoice] = useState(false);
  const [pendingAttachmentFile, setPendingAttachmentFile] = useState<File | null>(null);
  const [recommendedQuestions] = useState([
    { id: 1, title: '快速分析', content: '总结"2026行业报告"的核心观点', category: 'analysis' },
    { id: 2, title: '关联搜索', content: '目前库里有哪些关于"向量数据库"的内容？', category: 'search' },
    { id: 3, title: '知识问答', content: '什么是RAG技术？它的工作原理是什么？', category: 'knowledge' },
    { id: 4, title: '文档查询', content: '2026行业报告中关于低空经济的部分有哪些内容？', category: 'document' }
  ]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [currentFolderPath, setCurrentFolderPath] = useState<string[]>([]); // 面包屑路径
  const [documentView, setDocumentView] = useState<any | null>(null);
  const [documentViewLoading, setDocumentViewLoading] = useState(false);
  const [documentViewError, setDocumentViewError] = useState('');
  const [summaryWidth, setSummaryWidth] = useState(20);
  const summaryDrag = useRef<{ x: number; width: number; containerWidth: number } | null>(null);
  const [pdfNavigation, setPdfNavigation] = useState<PdfNavigation | null>(null);
  const [pdfPageJump, setPdfPageJump] = useState<PdfPageJump | null>(null);
  const handlePdfPreviewError = useCallback(() => setDocumentViewError('无法加载 PDF 原件。'), []);
  const pdfDirectory = pdfNavigation?.bookmarks.length
    ? pdfNavigation.bookmarks
    : Array.from({ length: pdfNavigation?.totalPages ?? 0 }, (_, pageIndex) => ({
        title: `第 ${pageIndex + 1} 页`, level: 0, pageIndex,
      }));
  // 智能总结状态
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState<boolean>(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingUploadFolder, setIsCreatingUploadFolder] = useState(false);
  const creatingUploadFolderRef = useRef(false);
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [renameFolderId, setRenameFolderId] = useState('');
  const [renameFolderName, setRenameFolderName] = useState('');
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteFolderId, setDeleteFolderId] = useState('');
  const [selectedDocuments, setSelectedDocuments] = useState<string[]>([]);
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
  const [isCopyModalOpen, setIsCopyModalOpen] = useState(false);
  const [targetFolderId, setTargetFolderId] = useState('');
  const [isGridView, setIsGridView] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isRenameFileModalOpen, setIsRenameFileModalOpen] = useState(false);
  const [renameFileId, setRenameFileId] = useState('');
  const [renameFileName, setRenameFileName] = useState('');
  const [isEditFileModalOpen, setIsEditFileModalOpen] = useState(false);
  const [editFileId, setEditFileId] = useState('');
  const [isPermissionModalOpen, setIsPermissionModalOpen] = useState(false);
  const [permissionFileId, setPermissionFileId] = useState('');
  const [filePermission, setFilePermission] = useState('private'); // private, shared, public
  const [sortBy, setSortBy] = useState('uploaded_at'); // uploaded_at, filename, size
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc'); // asc, desc
  const [fileTypeFilter, setFileTypeFilter] = useState('all'); // all, pdf, docx, txt
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false); // 文件夹选择对话框
  const [filesToUpload, setFilesToUpload] = useState<File[]>([]); // 待上传的文件
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({}); // 上传进度
  const [isDragging, setIsDragging] = useState(false); // 拖拽状态
  const [recentDocuments, setRecentDocuments] = useState<Document[]>([]); // 最近使用的文档
  const [favoriteDocuments, setFavoriteDocuments] = useState<Document[]>([]); // 收藏的文档
  const [filterType, setFilterType] = useState('all'); // 筛选类型：all, recent, favorite
  const [activeFilter, setActiveFilter] = useState('all'); // 当前激活的筛选
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const followChatRef = useRef(true);
  const chatInFlightRef = useRef(false);
  const docxContainerRef = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 加载文档列表
  useEffect(() => {
    const loadDocuments = async () => {
      try {
        const docs = await getDocuments();
        setDocuments(docs);

        // 更新最近使用的文档（按访问时间排序）
        const recentDocs = [...docs].sort((a, b) => {
          const dateA = new Date((a.metadata.last_accessed_at as string) || (a.metadata.uploaded_at as string)).getTime();
          const dateB = new Date((b.metadata.last_accessed_at as string) || (b.metadata.uploaded_at as string)).getTime();
          return dateB - dateA;
        }).slice(0, 5);
        setRecentDocuments(recentDocs);

        // 更新收藏的文档
        const favDocs = docs.filter(doc => doc.metadata.is_favorite);
        setFavoriteDocuments(favDocs);
      } catch (error) {
        console.error('Error loading documents:', error);
        message.error('加载文档失败');
      }
    };
    loadDocuments();
  }, []);

  const hasPendingIngestion = [documents, recentDocuments, favoriteDocuments]
    .some(list => list.some(doc => isIngestionPending(doc.metadata.status)));

  useEffect(() => {
    if (!hasPendingIngestion) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updates = new Map((await getDocuments()).map(doc => [doc.id, doc.metadata]));
        if (cancelled) return;
        const updateStatuses = (list: Document[]) => list.map(doc => {
          if (!isIngestionPending(doc.metadata.status)) return doc;
          const update = updates.get(doc.id);
          if (!update || update.job_id !== doc.metadata.job_id) return doc;
          return { ...doc, metadata: { ...doc.metadata, ...update } };
        });
        setDocuments(updateStatuses);
        setRecentDocuments(updateStatuses);
        setFavoriteDocuments(updateStatuses);
      } catch (error) {
        console.error('Error checking ingestion status:', error);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1500);
      }
    };
    timer = setTimeout(poll, 700);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasPendingIngestion]);

  // 加载文件夹列表
  useEffect(() => {
    const loadFolders = async () => {
      try {
        const folderList = await getFolders();
        setFolders(folderList);

        // 检查是否存在默认文件夹，如果不存在则创建
        const defaultFolderName = '默认文件夹';
        const defaultFolder = folderList.find(folder => folder.name === defaultFolderName);
        if (!defaultFolder) {
          try {
            const createResult = await createFolder(defaultFolderName, null);
            // 重新加载文件夹列表
            const updatedFolderList = await getFolders();
            setFolders(updatedFolderList);
            // 设置默认文件夹为活动目录
            handleFolderSelect(createResult.folder.id);
          } catch (error) {
            console.error('Error creating default folder:', error);
          }
        } else {
          // 设置默认文件夹为活动目录
          handleFolderSelect(defaultFolder.id);
        }
      } catch (error) {
        console.error('Error loading folders:', error);
        message.error('加载文件夹失败');
      }
    };
    loadFolders();
  }, []);

  // 生成智能总结
  const generateSummary = async () => {
    if (!selectedDocument) {
      message.warning('请先选择一个文档');
      return;
    }

    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const response = await generateDocumentSummary(selectedDocument.id);
      setSummary(response.summary);
      message.success('文档总结生成成功');
    } catch (error) {
      setSummaryError('生成总结失败，请重试');
      message.error(`生成总结失败：${error instanceof Error ? error.message : '未知错误'}`);
      console.error('Failed to generate summary:', error);
    } finally {
      setSummaryLoading(false);
    }
  };

  // 创建文件夹
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      message.warning('请输入文件夹名称');
      return;
    }

    try {
      await createFolder(newFolderName, null);
      // 重新加载所有文件夹
      const folderList = await getFolders();
      setFolders(folderList);
      setNewFolderName('');
      setIsFolderModalOpen(false);
      message.success('文件夹创建成功');
    } catch (error) {
      console.error('Error creating folder:', error);
      message.error(`创建文件夹失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  // 切换文件夹
  const handleFolderSelect = async (folderId: string | null) => {
    // 如果folderId为null，选择默认文件夹
    const targetFolderId = folderId || (folders.find(f => f.name === '默认文件夹')?.id || null);
    setSelectedFolder(targetFolderId);
    // 更新面包屑路径
    if (targetFolderId) {
      // 构建面包屑路径
      const path: string[] = [];
      let currentId: string | null = targetFolderId;
      while (currentId) {
        const folder = folders.find(f => f.id === currentId);
        if (folder) {
          path.unshift(folder.name);
          currentId = folder.parent_id;
        } else {
          break;
        }
      }
      setCurrentFolderPath(path);
    } else {
      setCurrentFolderPath([]);
    }
    // 重新加载文件列表
    await handleSearch(targetFolderId);
  };



  // 文件夹列表组件
  const FolderList = () => {
    return (
      <div className="space-y-1">
        {folders.map((folder) => (
          <div key={folder.id} className="relative">
            <button
              className={`w-full flex items-center justify-between space-x-3 px-3 py-2 rounded-lg transition-all ${selectedFolder === folder.id ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200/50 dark:hover:bg-slate-800'}`}
              onClick={() => handleFolderSelect(folder.id)}
            >
              <div className="flex items-center space-x-3">
                <Icon
                  icon="solar:folder-bold"
                  className={`${selectedFolder === folder.id ? 'text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400'}`}
                />
                <span className="font-medium truncate">{folder.name}</span>
              </div>
              <div className="flex items-center space-x-1">
                <button
                  className={`p-1 rounded transition-colors ${selectedFolder === folder.id ? 'hover:bg-brand-200 dark:hover:bg-brand-900/50' : 'hover:bg-gray-300 dark:hover:bg-slate-700'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRenameFolder(folder.id, folder.name);
                  }}
                  title="重命名"
                >
                  <Icon icon="solar:pen-line-duotone" className="text-sm" />
                </button>
                <button
                  className={`p-1 rounded transition-colors ${selectedFolder === folder.id ? 'hover:bg-brand-200 dark:hover:bg-brand-900/50' : 'hover:bg-gray-300 dark:hover:bg-slate-700'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteFolder(folder.id);
                  }}
                  title="删除"
                >
                  <Icon icon="solar:trash-bin-line-duotone" className="text-sm" />
                </button>
              </div>
            </button>
          </div>
        ))}
      </div>
    );
  };

  // 文件夹选择组件
  const FolderSelectorList = () => {
    return (
      <div className="space-y-1">
        {folders.map((folder) => (
          <div key={folder.id} className="relative">
            <button
              className={`w-full flex items-center justify-between space-x-3 px-3 py-2 rounded-lg transition-all ${selectedFolder === folder.id ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200/50 dark:hover:bg-slate-800'}`}
              onClick={() => handleFolderSelect(folder.id)}
            >
              <div className="flex items-center space-x-3">
                <Icon
                  icon="solar:folder-bold"
                  className={`${selectedFolder === folder.id ? 'text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400'}`}
                />
                <span className="font-medium truncate">{folder.name}</span>
              </div>
            </button>
          </div>
        ))}
      </div>
    );
  };

  // 打开重命名文件夹模态框
  const handleRenameFolder = (folderId: string, folderName: string) => {
    setRenameFolderId(folderId);
    setRenameFolderName(folderName);
    setIsRenameModalOpen(true);
  };

  // 执行文件夹重命名
  const handleRenameFolderSubmit = async () => {
    if (!renameFolderName.trim()) {
      message.warning('请输入文件夹名称');
      return;
    }

    try {
      await renameFolder(renameFolderId, renameFolderName);
      // 重新加载所有文件夹
      const folderList = await getFolders();
      setFolders(folderList);
      setIsRenameModalOpen(false);
      message.success('文件夹重命名成功');
    } catch (error) {
      console.error('Error renaming folder:', error);
      message.error(`重命名文件夹失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  // 打开删除文件夹模态框
  const handleDeleteFolder = (folderId: string) => {
    setDeleteFolderId(folderId);
    setIsDeleteModalOpen(true);
  };

  // 执行文件夹删除
  const handleDeleteFolderSubmit = async () => {
    try {
      await deleteFolder(deleteFolderId);
      // 重新加载所有文件夹
      const folderList = await getFolders();
      setFolders(folderList);
      if (selectedFolder === deleteFolderId) {
        setSelectedFolder(null);
        setCurrentFolderPath([]);
      }
      setIsDeleteModalOpen(false);
      message.success('文件夹删除成功');
    } catch (error) {
      console.error('Error deleting folder:', error);
      // 捕获并显示后端返回的具体错误信息
      if (error instanceof Error) {
        if (error.message.includes('Cannot delete folder with subfolders')) {
          message.error('删除失败：该文件夹包含子文件夹');
        } else if (error.message.includes('Cannot delete folder with files')) {
          message.error('删除失败：该文件夹包含文件');
        } else {
          message.error(`删除文件夹失败：${error.message}`);
        }
      } else {
        message.error('删除文件夹失败：未知错误');
      }
    }
  };

  // 切换文件选择状态
  const toggleDocumentSelection = (docId: string) => {
    setSelectedDocuments(prev => {
      if (prev.includes(docId)) {
        return prev.filter(id => id !== docId);
      } else {
        return [...prev, docId];
      }
    });
  };

  // 打开移动文件模态框
  const handleMoveDocuments = () => {
    if (selectedDocuments.length === 0) {
      message.warning('请先选择文件');
      return;
    }
    setIsMoveModalOpen(true);
  };

  // 打开复制文件模态框
  const handleCopyDocuments = () => {
    if (selectedDocuments.length === 0) {
      message.warning('请先选择文件');
      return;
    }
    setIsCopyModalOpen(true);
  };

  // 执行文件移动
  const handleMoveDocumentsSubmit = async () => {
    try {
      await batchOperateDocuments('move', selectedDocuments, targetFolderId);
      // 重新加载文档列表，保持当前的搜索和筛选状态
      await handleSearch();
      setSelectedDocuments([]);
      setIsMoveModalOpen(false);
      message.success('文件移动成功');
    } catch (error) {
      console.error('Error moving documents:', error);
      message.error(`移动文件失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  // 执行文件复制
  const handleCopyDocumentsSubmit = async () => {
    try {
      await batchOperateDocuments('copy' as any, selectedDocuments, targetFolderId);
      // 重新加载文档列表，保持当前的搜索和筛选状态
      await handleSearch();
      setSelectedDocuments([]);
      setIsCopyModalOpen(false);
      message.success('文件复制成功');
    } catch (error) {
      console.error('Error copying documents:', error);
      message.error(`复制文件失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  // 批量删除文件
  const handleDeleteDocuments = async () => {
    if (selectedDocuments.length === 0) {
      message.warning('请先选择文件');
      return;
    }

    // 显示确认对话框
    Modal.confirm({
      title: '确认删除',
      content: `确定要删除选中的 ${selectedDocuments.length} 个文件吗？删除后将无法恢复。`,
      okType: 'danger',
      onOk: async () => {
        try {
          // 调用批量删除API
          await batchOperateDocuments('delete', selectedDocuments);

          // 重新加载文档列表，保持当前的搜索和筛选状态
          await handleSearch();

          // 清空选中状态
          setSelectedDocuments([]);

          // 显示成功消息
          message.success(`成功删除 ${selectedDocuments.length} 个文件`);
        } catch (error) {
          console.error('Error deleting documents:', error);
          message.error(`删除文件失败：${error instanceof Error ? error.message : '未知错误'}`);
        }
      }
    });
  };



  // 处理文件选择，打开文件夹选择对话框
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setFilesToUpload(Array.from(files));
      setIsFolderSelectorOpen(true);
    }
    if (e.target) {
      e.target.value = '';
    }
  };

  // 拖拽事件处理
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      setFilesToUpload(Array.from(files));
      setIsFolderSelectorOpen(true);
    }
  };

  // 处理文件夹选择确认，开始上传文件
  const handleFolderSelectConfirm = async () => {
    if (!selectedFolder) {
      message.warning('请选择一个文件夹作为上传目标');
      return;
    }

    setIsLoading(true);
    setIsFolderSelectorOpen(false);

    try {
      const allowedTypes = ['.txt', '.md', '.pdf', '.doc', '.docx'];
      const maxSize = 20 * 1024 * 1024; // 20MB

      // 类型和大小校验
      const validFiles = [];
      for (const file of filesToUpload) {
        const ext = file.name.substring(file.name.lastIndexOf('.'));
        if (!allowedTypes.includes(ext.toLowerCase())) {
          message.error(`文件 "${file.name}" 类型不支持，仅支持：${allowedTypes.join(', ')}`);
          continue;
        }
        if (file.size > maxSize) {
          message.error(`文件 "${file.name}" 大小超过限制（最大20MB）`);
          continue;
        }
        validFiles.push(file);
      }

      if (validFiles.length === 0) {
        message.warning('没有符合条件的文件可上传');
        setIsLoading(false);
        return;
      }

      // 上传文件并显示进度
      const uploadPromises = validFiles.map(async (file) => {
        try {
          // 初始化进度
          setUploadProgress(prev => ({ ...prev, [file.name]: 0 }));

          // 调用上传文档API
          const uploadRes = await uploadDocument(file, selectedFolder, (progress) => {
            setUploadProgress(prev => ({ ...prev, [file.name]: progress }));
          });
          const realSize = uploadRes.document?.metadata?.size ?? file.size;

          if (uploadRes.duplicate) {
            message.info('此文件已在当前文件夹中。');
          } else {
            message.success('文件已上传（' + formatFileSize(realSize) + '），已加入入库队列。');
          }
        } catch (error) {
          console.error(`Error uploading file ${file.name}:`, error);
          message.error(`文件 "${file.name}" 上传失败：${error instanceof Error ? error.message : '未知错误'}`);
        }
      });

      await Promise.all(uploadPromises);

      // 重新加载文档列表，保持当前的搜索和筛选状态
      await handleSearch(selectedFolder);

      // 清空待上传文件和进度
      setFilesToUpload([]);
      setUploadProgress({});
    } catch (error) {
      console.error('Error uploading files:', error);
      message.error(`抱歉，文件上传失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsLoading(false);
    }
  };

  // 执行文件重命名
  const handleRenameFileSubmit = async () => {
    if (!renameFileName.trim()) {
      message.warning('请输入文件名');
      return;
    }

    try {
      await batchOperateDocuments('rename', [renameFileId], '', renameFileName);
      // 重新加载文档列表，保持当前的搜索和筛选状态
      await handleSearch();
      setIsRenameFileModalOpen(false);
      message.success('文件重命名成功');
    } catch (error) {
      console.error('Error renaming file:', error);
      message.error(`重命名文件失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  // 执行文件编辑（替换）
  const handleEditFileSubmit = async (file: File) => {
    if (!file) {
      message.warning('请选择文件');
      return;
    }

    try {
      setIsLoading(true);
      const { document } = await replaceDocument(editFileId, file);
      applyIngestionUpdate(document);
      message.success('新版本已加入入库队列。');
      setIsEditFileModalOpen(false);
    } catch (error) {
      console.error('Error editing file:', error);
      message.error(`编辑文件失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const applyIngestionUpdate = (updated: Document) => {
    const update = (list: Document[]) => list.map(doc => doc.id === updated.id ? updated : doc);
    setDocuments(update);
    setRecentDocuments(update);
    setFavoriteDocuments(update);
  };

  const retryIngestion = async (docId: string) => {
    try {
      const { document } = await reindexDocument(docId);
      applyIngestionUpdate(document);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重试入库失败');
    }
  };

  const showReplaceDialog = (docId: string) => {
    setEditFileId(docId);
    setIsEditFileModalOpen(true);
  };

  // 执行文件权限设置
  const handlePermissionFileSubmit = async () => {
    try {
      setIsLoading(true);
      // 调用API设置文件权限
      await batchOperateDocuments('permission', [permissionFileId], '', filePermission);
      // 显示设置成功消息
      message.success('文件权限设置成功');
      // 重新加载文档列表，保持当前的搜索和筛选状态
      await handleSearch();
      setIsPermissionModalOpen(false);
    } catch (error) {
      console.error('Error setting file permission:', error);
      message.error(`设置文件权限失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsLoading(false);
    }
  };





  // 切换视图模式
  const toggleViewMode = () => {
    setIsGridView(!isGridView);
  };

  // 防止TS严格模式下出现未使用变量/函数的编译错误
  useEffect(() => {
    // 这些变量/函数在当前版本未直接使用，但保留代码以支持后续功能扩展。
  }, [setRenameFileId, setEditFileId, setPermissionFileId, handleCopyDocuments, toggleViewMode]);

  // 搜索文件
  const handleSearch = async (folderId?: string | null) => {
    try {
      const effectiveFolderId = folderId !== undefined ? folderId : selectedFolder;
      // 当folderId为空字符串或null时，不传递folder_id参数
      const results = await searchDocuments(
        searchQuery,
        effectiveFolderId || undefined,
        fileTypeFilter === 'all' ? undefined : fileTypeFilter,
        sortBy,
        sortOrder
      );
      setDocuments(results);
    } catch (error) {
      console.error('Error searching documents:', error);
      message.error(`搜索文件失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  // 切换深色模式
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const handleTabSwitch = (tab: string) => {
    setActiveTab(tab);
  };

  const toggleDrawer = () => {
    setIsDrawerOpen(!isDrawerOpen);
  };

  const toggleDarkMode = () => {
    setIsDarkMode(!isDarkMode);
  };

  const openDocumentInViewer = async (doc: Document) => {
    setPdfNavigation(null);
    setPdfPageJump(null);
    setSelectedDocument(doc);
    setIsDrawerOpen(true);
    setDocumentViewLoading(true);
    setDocumentViewError('');
    // 清空之前的总结状态
    setSummary(null);
    setSummaryError(null);
    try {
      // 更新文档访问时间
      await updateDocumentAccess(doc.id);

      const view = await getDocumentView(doc.id);
      setDocumentView(view);
      // 保持在知识库页面，在右侧显示文档预览
      setIsDrawerOpen(true);

      // 重新加载文档列表，更新最近使用状态
      const docs = await getDocuments();
      setDocuments(docs);

      // 更新最近使用的文档
      const recentDocs = [...docs].sort((a, b) => {
        const dateA = new Date((a.metadata.last_accessed_at as string) || (a.metadata.uploaded_at as string)).getTime();
        const dateB = new Date((b.metadata.last_accessed_at as string) || (b.metadata.uploaded_at as string)).getTime();
        return dateB - dateA;
      }).slice(0, 5);
      setRecentDocuments(recentDocs);
    } catch (error) {
      setDocumentView(null);
      setDocumentViewError(error instanceof Error ? error.message : '加载文档失败');
    } finally {
      setDocumentViewLoading(false);
    }
  };

  // 渲染DOCX文件
  useEffect(() => {
    if (documentViewLoading) return;
    if (documentView?.view_type === 'docx' && selectedDocument && docxContainerRef.current) {
      const container = docxContainerRef.current;
      if (container.childElementCount > 0) return;
      container.innerHTML = '';

      fetch(getDocumentFileUrl(selectedDocument.id))
        .then((response) => response.arrayBuffer())
        .then((arrayBuffer) => {
          renderAsync(arrayBuffer, container, undefined, {
            className: 'docx-preview',
            inWrapper: false
          });
        })
        .catch((error) => {
          console.error('Error loading DOCX:', error);
          container.innerHTML = '<div class="p-6 text-center text-red-500">DOCX 加载失败，请使用上方"下载文件"</div>';
        });
    }
  }, [documentView, selectedDocument, documentViewLoading]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputValue(value);
    setShowCommandHint(value.startsWith('/'));

    // 自动调整高度
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  const sendQuestion = async (text: string) => {
    const question = text.trim();
    if (!question || isLoading || chatInFlightRef.current) return;

    chatInFlightRef.current = true;
    followChatRef.current = true;
    setInputValue('');
    setShowCommandHint(false);
    setIsLoading(true);

    const attachment = chatAttachment;
    const displayContent = attachment ? `${question}\n📎 附件：${attachment.filename}` : question;
    const replyId = Date.now();
    setChatAttachment(null);
    setMessages(previous => [
      ...previous,
      { role: 'user', content: displayContent },
      { id: replyId, role: 'assistant', content: '', complete: false },
    ]);

    try {
      await chatStream(
        question,
        20,
        ragEnabled,
        chunk => {
          setMessages(previous => previous.map(reply =>
            reply.id === replyId ? { ...reply, content: reply.content + chunk } : reply
          ));
        },
        (sources, tokenUsage) => {
          const linkedSources = sources.map(source => source.id === 'attachment' && attachment?.basis
            ? { ...source, attachmentBasis: attachment.basis, sourceUrl: attachment.sourceUrl }
            : source);
          setMessages(previous => previous.map(reply =>
            reply.id === replyId ? { ...reply, complete: true, sources: linkedSources } : reply
          ));
          setTokenUsage(previous => previous + tokenUsage);
        },
        attachment?.text,
        attachment?.filename,
        attachment?.basis,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : '问答请求失败，请稍后重试。';
      setMessages(previous => previous.map(reply =>
        reply.id === replyId
          ? { ...reply, content: reply.content ? `${reply.content}\n\n${detail}` : detail, complete: true }
          : reply
      ));
    } finally {
      chatInFlightRef.current = false;
      setIsLoading(false);
    }
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendQuestion(inputValue);
    }
  };

  useEffect(() => {
    const container = chatScrollRef.current;
    if (container && followChatRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  // 初始化时自动调整textarea高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, []);

  return (
    <div className={`flex flex-col bg-gray-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 ${activeTab === 'ask' ? 'h-dvh overflow-hidden' : 'min-h-screen'}`}>
      {/* 顶栏：技术感知与状态 */}
      <header className="h-16 shrink-0 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between px-6 bg-white dark:bg-slate-900 z-50 shadow-sm sticky top-0">
        <div className="flex items-center space-x-4">
          <div className="p-2 bg-brand-600 rounded-lg shadow-md">
            <Icon icon="solar:library-bold-duotone" className="text-white text-xl" />
          </div>
          <h1 className="text-lg font-bold tracking-tight">NexusMind <span className="text-xs font-normal text-gray-400 bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 rounded ml-2">v2.1 Beta</span></h1>
        </div>
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2 bg-gray-100 dark:bg-slate-800 px-3 py-1.5 rounded-full shadow-sm">
            <Icon icon="simple-icons:deepseek" className="text-brand-500" />
            <span className="text-sm font-medium">DeepSeek Flash</span>
          </div>
          {/* 技术感知：向量库状态 */}
          <div className="hidden md:flex items-center space-x-4 border-l border-gray-200 dark:border-slate-800 pl-6">
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-gray-400 uppercase leading-none mb-1">Token 消耗量</span>
              <div className="w-24 h-1.5 bg-gray-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div className="bg-brand-500 h-full w-[45%] transition-all duration-1000 ease-in-out"></div>
              </div>
              <span className="text-[10px] text-gray-500 mt-1">{tokenUsage} tokens</span>
            </div>
            <div className="flex items-center space-x-1" title="本地部署环境">
              <Icon icon="solar:lock-bold-duotone" className="text-gray-400" />
              <span className="text-xs text-gray-500">Local Privacy Mode</span>
            </div>
          </div>
          {/* 深色模式切换 */}
          <button
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-slate-800 transition-colors"
            onClick={toggleDarkMode}
            title={isDarkMode ? '切换到浅色模式' : '切换到深色模式'}
          >
            {isDarkMode ? (
              <Icon icon="solar:sun-bold" className="text-yellow-400" />
            ) : (
              <Icon icon="solar:moon-bold" className="text-gray-600" />
            )}
          </button>
          {/* 用户信息 */}
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-brand-600 to-indigo-600 flex items-center justify-center text-white font-bold text-sm">JS</div>
            <div className="hidden md:block">
              <p className="text-sm font-semibold">James Stark</p>
              <p className="text-[10px] text-gray-500">高级研究员</p>
            </div>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左侧：导航菜单 */}
        <aside className={`w-64 flex-col border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 md:min-w-[16rem] shadow-sm ${activeTab === 'ask' && referenceFile ? 'hidden lg:flex' : 'flex'}`}>
          <div className="p-4 flex-1 overflow-y-auto hide-scrollbar space-y-6">
            {/* 快捷操作 */}
            <div className="space-y-1">
              <button
                className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-all ${activeTab === 'ask' ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800'}`}
                onClick={() => handleTabSwitch('ask')}
              >
                <Icon icon="solar:chat-round-dots-line-duotone" className={activeTab === 'ask' ? 'text-brand-600 dark:text-brand-400' : ''} />
                <span className="font-medium">智能问答</span>
              </button>
              <button
                className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-all ${activeTab === 'knowledge' ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800'}`}
                onClick={() => handleTabSwitch('knowledge')}
              >
                <Icon icon="solar:database-bold-duotone" className={activeTab === 'knowledge' ? 'text-brand-600 dark:text-brand-400' : ''} />
                <span className="font-medium">知识库</span>
              </button>
              <button
                className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-all ${activeTab === 'write' ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800'}`}
                onClick={() => handleTabSwitch('write')}
              >
                <Icon icon="solar:pen-2-line-duotone" className={activeTab === 'write' ? 'text-brand-600 dark:text-brand-400' : ''} />
                <span className="font-medium">创作中心</span>
              </button>
            </div>

            {/* 最近访问 */}
            <div className="pt-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 px-3">最近访问</p>
              <div className="space-y-2">
                {recentDocuments.length > 0 ? (
                  recentDocuments.map((doc) => (
                    <a key={doc.id} className="flex items-center space-x-2 text-xs text-gray-600 dark:text-slate-400 hover:text-brand-600 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors" href="#" onClick={(e) => {
                      e.preventDefault();
                      openDocumentInViewer(doc);
                    }}>
                      <Icon icon="solar:history-line-duotone" />
                      <span className="truncate">{doc.metadata.filename}</span>
                    </a>
                  ))
                ) : (
                  <div className="px-3 py-4 text-xs text-gray-400">最近没有访问过文件</div>
                )}
              </div>
            </div>

            {/* 收藏文件 */}
            <div className="pt-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 px-3">我的收藏</p>
              <div className="space-y-2">
                {favoriteDocuments.length > 0 ? (
                  favoriteDocuments.map((doc) => (
                    <a key={doc.id} className="flex items-center space-x-2 text-xs text-gray-600 dark:text-slate-400 hover:text-brand-600 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors" href="#" onClick={(e) => {
                      e.preventDefault();
                      openDocumentInViewer(doc);
                    }}>
                      <Icon icon="solar:heart-bold" className="text-red-500" />
                      <span className="truncate">{doc.metadata.filename}</span>
                    </a>
                  ))
                ) : (
                  <div className="px-3 py-4 text-xs text-gray-400">还没有收藏任何文件</div>
                )}
              </div>
            </div>

            {/* 标签云 */}
            <div className="pt-6 pb-6">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 px-3">知识标签</h3>
              <div className="flex flex-wrap gap-2 px-3">
                <span className="px-2 py-1 bg-gray-100 dark:bg-slate-800 rounded text-[10px] font-medium cursor-pointer hover:bg-brand-100 dark:hover:bg-brand-900/30 hover:text-brand-600 transition-colors">#人工智能</span>
                <span className="px-2 py-1 bg-gray-100 dark:bg-slate-800 rounded text-[10px] font-medium cursor-pointer hover:bg-brand-100 dark:hover:bg-brand-900/30 hover:text-brand-600 transition-colors">#经济学</span>
                <span className="px-2 py-1 bg-gray-100 dark:bg-slate-800 rounded text-[10px] font-medium cursor-pointer hover:bg-brand-100 dark:hover:bg-brand-900/30 hover:text-brand-600 transition-colors">#RAG落地</span>
                <span className="px-2 py-1 bg-gray-100 dark:bg-slate-800 rounded text-[10px] font-medium cursor-pointer hover:bg-brand-100 dark:hover:bg-brand-900/30 hover:text-brand-600 transition-colors">#低空经济</span>
              </div>
            </div>
          </div>
        </aside>

        {/* 中间：主内容区 (Main Stage) */}
        <main className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-white dark:bg-slate-950 ${activeTab === 'ask' && referenceFile ? 'overflow-hidden md:flex-row' : ''}`}>
          {/* 场景1：智能问答 Area */}
          {activeTab === 'ask' && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* 消息展示区 */}
              <div
                ref={chatScrollRef}
                className={`min-h-0 flex-1 overflow-y-auto p-4 space-y-8 hide-scrollbar ${referenceFile ? "md:px-6" : "md:px-20"}`}
                onScroll={event => {
                  const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
                  followChatRef.current = scrollHeight - scrollTop - clientHeight <= 48;
                }}
              >
                {messages.length === 0 ? (
                  /* 欢迎语 */
                  <div className="py-12 flex flex-col items-center text-center space-y-4">
                    <div className="w-20 h-20 bg-brand-50 dark:bg-brand-900/20 rounded-3xl flex items-center justify-center group">
                      <Icon icon="solar:magic-stick-3-bold-duotone" className="text-5xl text-brand-600 transition-transform group-hover:scale-110" />
                    </div>
                    <h2 className="text-3xl font-bold">你好，我是你的知识助手</h2>
                    <p className="text-gray-500 max-w-md">已索引 1,284 篇文档。你可以像聊天一样询问我任何知识，我会提供基于原文的准确回答。</p>
                    <div className="grid grid-cols-2 gap-3 w-full max-w-lg mt-6 text-left">
                      {recommendedQuestions.map((question) => (
                        <button
                          key={question.id}
                          className="p-3 border border-gray-200 dark:border-slate-800 rounded-xl hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-all group"
                          onClick={() => void sendQuestion(question.content)}
                        >
                          <p className="text-xs font-semibold text-brand-600 mb-1">{question.title}</p>
                          <p className="text-sm text-gray-600 dark:text-slate-400">{question.content}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* 消息列表 */
                  messages.map((message, index) => (
                    <div key={index} className={`flex space-x-4 max-w-4xl ${message.role === 'user' ? 'justify-end' : ''}`}>
                      {message.role === 'assistant' && (
                        <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center shrink-0">
                          <Icon icon="solar:magic-stick-3-bold" className="text-white" />
                        </div>
                      )}
                      <div className={`space-y-4 min-w-0 flex-1 ${message.role === 'user' ? 'text-right' : ''}`}>
                        <div className={`text-slate-800 dark:text-slate-200 leading-relaxed text-sm ${message.role === 'user' ? 'bg-gray-100 dark:bg-slate-800 p-4 rounded-xl' : ''}`}>
                          {message.role === 'assistant' ? (
                            <div className="chat-markdown">
                              {message.complete === false && !message.content ? (
                                <p className="typing-cursor">正在思考...</p>
                              ) : (
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                                  a: ({ href, children }) => {
                                    const match = /^#evidence-(\d+)$/.exec(href ?? '');
                                    if (!match) return <a href={href}>{children}</a>;
                                    const source = message.sources?.find(item => item.citation_number === Number(match[1]));
                                    if (!source) return <span>{children}</span>;
                                    return <button type="button" className="px-0.5 text-brand-600 underline"
                                      aria-label={`查看引用 ${match[1]}`}
                                      onClick={() => setReferenceFile({
                                        id: source.id, filename: source.filename, versionId: source.version_id,
                                        selectionId: ++citationSelection.current, sources: [source],
                                      })}>{children}</button>;
                                  },
                                }}>
                                  {message.complete === false ? formatStreamingMarkdown(message.content) : message.content}
                                </ReactMarkdown>
                              )}
                            </div>
                          ) : (
                            message.content
                          )}
                        </div>
                        {message.role === 'assistant' && !!message.sources?.length && (
                          <ReferenceSources sources={message.sources} onSelect={setReferenceFile} />
                        )}
                      </div>
                      {message.role === 'user' && (
                        <div className="w-8 h-8 rounded-lg bg-gray-300 dark:bg-slate-700 flex items-center justify-center shrink-0">
                          <Icon icon="solar:user-bold" className="text-gray-600 dark:text-gray-300" />
                        </div>
                      )}
                    </div>
                  ))
                )}

                {/* 加载状态 */}
                {isLoading && messages.at(-1)?.complete !== false && (
                  <div className="flex space-x-4 max-w-4xl">
                    <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center shrink-0">
                      <Icon icon="solar:magic-stick-3-bold" className="text-white" />
                    </div>
                    <div className="space-y-4 flex-1">
                      <div className="text-slate-800 dark:text-slate-200 leading-relaxed text-sm">
                        <p className="typing-cursor">正在思考...</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 输入区 */}
              <div className={`shrink-0 p-4 border-t border-gray-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 ${referenceFile ? "md:px-6" : "md:px-20"}`}>
                <div className="max-w-4xl mx-auto relative">
                  {/* 快捷指令预览 */}
                  <div className={`absolute bottom-full left-0 mb-2 w-64 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-gray-200 dark:border-slate-700 p-2 z-50 ${showCommandHint ? '' : 'hidden'}`} id="command-hint">
                    <div className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg cursor-pointer flex items-center justify-between group">
                      <div className="flex items-center space-x-2">
                        <Icon icon="solar:trash-bin-trash-bold" className="text-brand-500" />
                        <span className="text-xs font-semibold">/clear</span>
                      </div>
                      <span className="text-[10px] text-gray-400">清空对话</span>
                    </div>
                    <div className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg cursor-pointer flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Icon icon="solar:magic-stick-bold" className="text-brand-500" />
                        <span className="text-xs font-semibold">/summarize</span>
                      </div>
                      <span className="text-[10px] text-gray-400">自动摘要</span>
                    </div>
                  </div>

                  <div className="relative flex items-end bg-white dark:bg-slate-800 border-2 border-brand-100 dark:border-slate-700 focus-within:border-brand-500 shadow-xl rounded-2xl transition-all p-2">
                    <button
                      className="p-2 text-gray-400 hover:text-brand-600 transition-colors"
                      onClick={() => {
                        const fileInput = document.createElement('input');
                        fileInput.type = 'file';
                        fileInput.accept = '.pdf,.doc,.docx,.txt,.md';
                        fileInput.onchange = async (e) => {
                          const target = e.target as HTMLInputElement;
                          if (target.files && target.files.length > 0) {
                            setPendingAttachmentFile(target.files[0]);
                            setShowAttachmentChoice(true);
                          }
                        };
                        fileInput.click();
                      }}
                    >
                      <Icon icon="solar:paperclip-line-duotone" className="text-2xl" />
                    </button>
                    <button type="button" title="联网找论文" aria-label="联网找论文" disabled={isLoading}
                      className="shrink-0 p-2 text-gray-500 transition-colors hover:text-brand-600 disabled:opacity-50"
                      onClick={() => setOnlinePaperSearchOpen(true)}>
                      <Icon icon="solar:global-line-duotone" className="text-xl" />
                    </button>
                    <textarea
                      ref={textareaRef}
                      className="w-full bg-transparent border-none focus:ring-0 text-sm py-2.5 max-h-32 hide-scrollbar resize-none font-medium"
                      value={inputValue}
                      onChange={handleInputChange}
                      onKeyDown={handleInputKeyDown}
                      placeholder="向你的知识库提问... (输入 / 获取命令)"
                      rows={1}
                    ></textarea>
                    <div className="flex items-center space-x-1 pr-1 pb-1">
                      <button
                        className={`flex items-center space-x-1 mr-2 px-2 py-1 rounded-lg transition-all ${ragEnabled ? 'bg-brand-100 dark:bg-brand-900/30' : 'bg-gray-100 dark:bg-slate-700'}`}
                        onClick={() => setRagEnabled(!ragEnabled)}
                      >
                        <Icon
                          icon="solar:database-bold-duotone"
                          className={`${ragEnabled ? 'text-brand-600' : 'text-gray-500'}`}
                        />
                        <span className={`text-[10px] font-bold ${ragEnabled ? 'text-brand-600' : 'text-gray-500'}`}>
                          {ragEnabled ? 'RAG On' : 'RAG Off'}
                        </span>
                      </button>
                      <button
                        className="p-2 bg-brand-600 text-white rounded-xl shadow-lg shadow-brand-200 hover:bg-brand-700 transition-all group transform hover:scale-105"
                        aria-label="发送消息"
                        disabled={isLoading || !inputValue.trim()}
                        onClick={() => void sendQuestion(inputValue)}
                      >
                        <Icon icon="solar:send-bold" className="text-xl group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                      </button>
                    </div>
                  </div>
                  {chatAttachment && (
                    <div className="flex items-center justify-between bg-brand-50 dark:bg-brand-900/20 border border-brand-200 dark:border-brand-800 rounded-lg px-3 py-2 mt-2">
                      <div className="flex items-center space-x-2 min-w-0">
                        <Icon icon="solar:document-text-bold" className="text-brand-600 shrink-0" />
                        <span className="text-xs text-brand-700 dark:text-brand-300 truncate">📎 {chatAttachment.filename}</span>
                        <span className="text-[10px] text-gray-500 shrink-0">
                          {chatAttachment.basis === 'pdf' ? '开放 PDF' : chatAttachment.basis === 'abstract' ? '仅摘要' : '仅作为附件'}
                        </span>
                        {chatAttachment.sourceUrl && <a href={chatAttachment.sourceUrl} target="_blank" rel="noreferrer"
                          className="shrink-0 text-xs text-brand-600 underline">来源</a>}
                      </div>
                      <button
                        className="text-gray-400 hover:text-red-500 transition-colors shrink-0 ml-2"
                        onClick={() => setChatAttachment(null)}
                      >
                        <Icon icon="solar:close-circle-bold" className="text-lg" />
                      </button>
                    </div>
                  )}
                  <p className="text-center text-[10px] text-gray-400 mt-2">使用 <kbd className="px-1 border rounded">Shift</kbd> + <kbd className="px-1 border rounded">Enter</kbd> 换行</p>

                  <OnlinePaperSearch open={onlinePaperSearchOpen} onClose={() => setOnlinePaperSearchOpen(false)}
                    onAttach={setChatAttachment}
                    onImport={() => { void getDocuments().then(setDocuments).catch(() => {}); }} />
                  {/* 附件选择弹窗 */}
                  <Modal
                    title="选择附件用途"
                    open={showAttachmentChoice}
                    onCancel={() => { setShowAttachmentChoice(false); setPendingAttachmentFile(null); }}
                    footer={null}
                    centered
                    width={420}
                  >
                    {pendingAttachmentFile && (
                      <div className="space-y-3">
                        <div className="flex items-center space-x-2 p-3 bg-gray-50 rounded-lg">
                          <Icon icon="solar:file-bold-duotone" className="text-2xl text-brand-600" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{pendingAttachmentFile.name}</p>
                            <p className="text-xs text-gray-500">{formatFileSize(pendingAttachmentFile.size)}</p>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <button
                            className="w-full flex items-center space-x-3 p-3 border-2 border-brand-200 rounded-xl hover:bg-brand-50 hover:border-brand-400 transition-all"
                            onClick={async () => {
                              const file = pendingAttachmentFile;
                              setShowAttachmentChoice(false);
                              setPendingAttachmentFile(null);
                              setIsLoading(true);
                              try {
                                const uploadRes = await uploadDocument(file);
                                const realSize = uploadRes.document?.metadata?.size ?? file.size;
                                if (uploadRes.duplicate) message.info('此文件已在知识库中。');
                                else message.success('文件已上传（' + formatFileSize(realSize) + '），已加入入库队列。');
                                const docs = await getDocuments();
                                setDocuments(docs);
                              } catch (error) {
                                message.error(`上传失败：${error instanceof Error ? error.message : '未知错误'}`);
                              } finally {
                                setIsLoading(false);
                              }
                            }}
                          >
                            <Icon icon="solar:database-bold-duotone" className="text-2xl text-brand-600" />
                            <div className="text-left">
                              <p className="text-sm font-semibold text-brand-700">加入知识库</p>
                              <p className="text-xs text-gray-500">文件将永久存储在知识库中，后续 RAG 检索可使用</p>
                            </div>
                          </button>
                          <button
                            className="w-full flex items-center space-x-3 p-3 border-2 border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-400 transition-all"
                            onClick={async () => {
                              const file = pendingAttachmentFile;
                              setShowAttachmentChoice(false);
                              setPendingAttachmentFile(null);
                              setIsLoading(true);
                              try {
                                const result = await parseFileOnly(file);
                                if (!result.text) {
                                  message.warning(`无法从 "${file.name}" 提取文本内容`);
                                  return;
                                }
                                setChatAttachment({ filename: result.filename, text: result.text });
                                message.success(`附件 "${file.name}" 已就绪，发送消息时将作为上下文提供给 AI`);
                              } catch (error) {
                                message.error(`解析失败：${error instanceof Error ? error.message : '未知错误'}`);
                              } finally {
                                setIsLoading(false);
                              }
                            }}
                          >
                            <Icon icon="solar:paperclip-line-duotone" className="text-2xl text-gray-600" />
                            <div className="text-left">
                              <p className="text-sm font-semibold text-gray-700">仅作为附件</p>
                              <p className="text-xs text-gray-500">文件内容仅用于本次对话，不存入知识库</p>
                            </div>
                          </button>
                        </div>
                      </div>
                    )}
                  </Modal>
                </div>
              </div>
            </div>
          )}
          {activeTab === 'ask' && referenceFile && (
            <ReferencePanel file={referenceFile} onClose={() => setReferenceFile(null)} />
          )}

          {/* 场景2：知识库 Area */}
          {activeTab === 'knowledge' && (
            <div className="flex-1 flex flex-col h-full overflow-y-auto">
              <div className="p-4 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-900 shadow-sm">
                <div className="flex items-center space-x-4">
                  <button
                    className="flex items-center space-x-1 text-sm text-gray-500 hover:text-brand-600 transition-colors"
                    onClick={() => setActiveTab('ask')}
                  >
                    <Icon icon="solar:alt-arrow-left-bold" />
                    <span>返回问答</span>
                  </button>
                  <div className="h-4 w-px bg-gray-200 dark:bg-slate-800"></div>
                  <h3 className="text-sm font-bold flex items-center space-x-2">
                    <Icon icon="solar:database-bold-duotone" className="text-brand-600" />
                    <span>知识库管理</span>
                  </h3>
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="file"
                    id="file-upload"
                    ref={fileInputRef}
                    accept=".pdf,.doc,.docx,.txt,.md"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                  />

                </div>
              </div>

              {/* 面包屑导航 */}
              <div className="px-6 py-2 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50">
                <div className="flex items-center space-x-2">
                  {currentFolderPath.length > 0 ? (
                    currentFolderPath.map((folderName, index) => (
                      <React.Fragment key={index}>
                        {index > 0 && <Icon icon="solar:chevron-right-bold" className="text-sm text-gray-400" />}
                        <span className="text-sm">{folderName}</span>
                      </React.Fragment>
                    ))
                  ) : (
                    <span className="text-sm text-brand-600">默认文件夹</span>
                  )}
                </div>
              </div>

              <div className="flex-1 bg-gray-100 dark:bg-slate-900 p-4 md:p-6 overflow-auto">
                <div className="max-w-6xl mx-auto space-y-4 md:space-y-6">
                  {/* 文件夹管理 */}
                  <div className="bg-white dark:bg-slate-800 rounded-xl shadow-md border border-gray-200 dark:border-slate-700 p-3 md:p-4">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold flex items-center space-x-2">
                        <Icon icon="solar:folder-bold" className="text-brand-600" />
                        <span>文件夹</span>
                      </h4>
                      <button
                        className="text-brand-600 hover:text-brand-700 transition-colors"
                        onClick={() => setIsFolderModalOpen(true)}
                      >
                        <Icon icon="solar:folder-add-bold" className="transition-transform hover:scale-110" />
                      </button>
                    </div>
                    <div className="space-y-2">
                      <FolderList />
                    </div>
                  </div>

                  {/* 文件管理 */}
                  <div className="bg-white dark:bg-slate-800 rounded-xl shadow-md border border-gray-200 dark:border-slate-700 p-3 md:p-4">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-3 space-y-3 md:space-y-0">
                      <h4 className="text-sm font-bold flex items-center space-x-2">
                        <Icon icon="solar:file-text-bold-duotone" className="text-brand-600" />
                        <span>文件</span>
                      </h4>
                      <div className="flex flex-col md:flex-row items-center space-y-2 md:space-y-0 md:space-x-2">
                        {/* 搜索框 */}
                        <div className="relative w-full md:w-64">
                          <input
                            type="text"
                            placeholder="搜索文件..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                handleSearch();
                              }
                            }}
                            className="w-full px-3 py-2 pl-10 bg-gray-100 dark:bg-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <Icon
                            icon="solar:search-bold"
                            className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                          />
                        </div>
                        {/* 筛选选项 */}
                        <div className="flex items-center space-x-2">
                          <select
                            value={activeFilter}
                            onChange={(e) => {
                              setActiveFilter(e.target.value);
                              setFilterType(e.target.value);
                            }}
                            className="px-2 py-1 bg-gray-100 dark:bg-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value="all">全部文件</option>
                            <option value="recent">最近使用</option>
                            <option value="favorite">我的收藏</option>
                          </select>
                        </div>
                        {/* 排序选项 */}
                        <div className="flex items-center space-x-2">
                          <select
                            value={sortBy}
                            onChange={(e) => {
                              setSortBy(e.target.value);
                              handleSearch();
                            }}
                            className="px-2 py-1 bg-gray-100 dark:bg-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value="uploaded_at">时间</option>
                            <option value="filename">名称</option>
                            <option value="size">大小</option>
                          </select>
                          <button
                            onClick={() => {
                              setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
                              handleSearch();
                            }}
                            className="p-1 bg-gray-100 dark:bg-slate-800 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                            title={sortOrder === 'desc' ? '切换为升序' : '切换为降序'}
                          >
                            <Icon
                              icon={sortOrder === 'desc' ? 'solar:sort-desc-bold' : 'solar:sort-asc-bold'}
                              className="text-gray-600 dark:text-slate-400"
                            />
                          </button>
                        </div>
                        {/* 文件类型筛选 */}
                        <select
                          value={fileTypeFilter}
                          onChange={(e) => {
                            setFileTypeFilter(e.target.value);
                            handleSearch();
                          }}
                          className="px-2 py-1 bg-gray-100 dark:bg-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                        >
                          <option value="all">所有类型</option>
                          <option value=".pdf">PDF</option>
                          <option value=".docx">DOCX</option>
                          <option value=".txt">TXT</option>
                          <option value=".md">MD</option>
                        </select>
                        {/* 操作按钮 */}
                        <div className="flex items-center space-x-2">
                          {selectedDocuments.length > 0 && (
                            <>
                              <button
                                className="text-brand-600 hover:text-brand-700 transition-colors"
                                onClick={() => {
                                  const selectedDocs = documents.filter(doc => selectedDocuments.includes(doc.id));
                                  const fileNames = selectedDocs.map(doc => doc.metadata.filename).join('、');
                                  setInputValue(`请分析以下文件：${fileNames}`);
                                  setActiveTab('ask');
                                }}
                                title="批量添加到AI对话"
                              >
                                <Icon icon="solar:chat-round-dots-bold" className="transition-transform hover:scale-110" />
                              </button>
                              <button
                                className="text-brand-600 hover:text-brand-700 transition-colors"
                                onClick={handleMoveDocuments}
                                title="移动文件"
                              >
                                <Icon icon="solar:move-bold" className="transition-transform hover:scale-110" />
                              </button>
                            </>
                          )}

                          <button
                            className={`text-red-600 transition-colors ${selectedDocuments.length > 0 ? 'hover:text-red-700' : 'text-gray-300 dark:text-slate-600 cursor-not-allowed'}`}
                            onClick={handleDeleteDocuments}
                            title={selectedDocuments.length > 0 ? `删除选中的文件（${selectedDocuments.length}）` : '请先勾选文件后再删除'}
                            disabled={selectedDocuments.length === 0}
                          >
                            <Icon icon="solar:trash-bin-trash-bold" className="transition-transform hover:scale-110" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* 拖拽上传区域 */}
                    <div
                      ref={dropZoneRef}
                      className={`mt-4 mb-4 p-8 border-2 border-dashed rounded-xl transition-all ${isDragging ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-gray-300 dark:border-slate-700 hover:border-brand-400'}`}
                      onDragEnter={handleDragEnter}
                      onDragLeave={handleDragLeave}
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                    >
                      <div className="text-center">
                        <Icon icon="solar:upload-cloud-bold" className="text-4xl text-gray-400 mx-auto mb-3" />
                        <p className="text-gray-500 mb-2">拖拽文件到此处上传</p>
                        <p className="text-xs text-gray-400 mb-4">支持 .txt, .md, .pdf, .doc, .docx 格式，单个文件最大20MB</p>
                        <button
                          className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-bold flex items-center space-x-1 transition-all hover:shadow-md hover:bg-brand-700 mx-auto"
                          onClick={() => {
                            if (fileInputRef.current) {
                              fileInputRef.current.value = '';
                              fileInputRef.current.click();
                            }
                          }}
                        >
                          <Icon icon="solar:upload-bold" />
                          <span>点击上传</span>
                        </button>
                      </div>
                    </div>

                    {/* 上传进度 */}
                    {Object.keys(uploadProgress).length > 0 && (
                      <div className="mt-4 mb-4 space-y-2">
                        {Object.entries(uploadProgress).map(([fileName, progress]) => (
                          <div key={fileName} className="space-y-1">
                            <div className="flex justify-between items-center">
                              <span className="text-sm text-gray-600 dark:text-slate-400 truncate" style={{ maxWidth: '200px' }}>
                                {fileName}
                              </span>
                              <span className="text-xs text-gray-500">{progress}%</span>
                            </div>
                            <div className="w-full bg-gray-200 dark:bg-slate-700 rounded-full h-2">
                              <div
                                className="bg-brand-600 h-2 rounded-full transition-all duration-300"
                                style={{ width: `${progress}%` }}
                              ></div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 文件列表 */}
                    <div className="mt-4">
                      {(() => {
                        let filteredDocs = documents;
                        if (filterType === 'recent') {
                          filteredDocs = recentDocuments;
                        } else if (filterType === 'favorite') {
                          filteredDocs = favoriteDocuments;
                        }
                        return filteredDocs;
                      })().length === 0 ? (
                        <div className="text-center py-8">
                          <Icon icon={filterType === 'recent' ? 'solar:clock-bold' : filterType === 'favorite' ? 'solar:heart-bold' : 'solar:file-search-bold'} className="text-4xl text-gray-400 mx-auto mb-3" />
                          <p className="text-gray-500">
                            {filterType === 'recent' ? '最近没有使用过文件' :
                              filterType === 'favorite' ? '还没有收藏任何文件' :
                                '该文件夹中没有文件'}
                          </p>

                        </div>
                      ) : (
                        <div className={isGridView ? 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4' : 'space-y-2'}>
                          {(() => {
                            let filteredDocs = documents;
                            if (filterType === 'recent') {
                              filteredDocs = recentDocuments;
                            } else if (filterType === 'favorite') {
                              filteredDocs = favoriteDocuments;
                            }
                            return filteredDocs;
                          })().map((doc) => (
                            <div
                              key={doc.id}
                              className={`${isGridView ? 'bg-gray-50 dark:bg-slate-800 rounded-xl p-4 border border-gray-200 dark:border-slate-700 hover:shadow-md transition-all cursor-pointer' : 'flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 hover:shadow-sm transition-all cursor-pointer'} ${selectedDocuments.includes(doc.id) ? 'ring-2 ring-brand-500' : ''}`}
                              onClick={() => openDocumentInViewer(doc)}
                            >
                              {isGridView ? (
                                <div className="flex flex-col space-y-3">
                                  <div className="flex items-center space-x-3">
                                    <input
                                      type="checkbox"
                                      className="h-4 w-4 accent-blue-600 cursor-pointer"
                                      checked={selectedDocuments.includes(doc.id)}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={() => toggleDocumentSelection(doc.id)}
                                      aria-label={`选择文件 ${doc.metadata.filename}`}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center justify-between">
                                        <h5 className="font-medium text-sm truncate" onClick={() => openDocumentInViewer(doc)} style={{ cursor: 'pointer' }}>
                                          {doc.metadata.filename}
                                        </h5>
                                        <button
                                          className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                                          onClick={async (e) => {
                                            e.stopPropagation();
                                            try {
                                              await toggleDocumentFavorite(doc.id, !doc.metadata.is_favorite);
                                              // 重新加载文档列表
                                              const docs = await getDocuments();
                                              setDocuments(docs);
                                              // 更新收藏的文档
                                              const favDocs = docs.filter(d => d.metadata.is_favorite);
                                              setFavoriteDocuments(favDocs);
                                            } catch (error) {
                                              message.error('更新收藏状态失败');
                                            }
                                          }}
                                        >
                                          <Icon
                                            icon={doc.metadata.is_favorite ? 'solar:heart-bold' : 'solar:heart-linear'}
                                            className={doc.metadata.is_favorite ? 'text-red-500' : 'text-gray-400 dark:text-slate-500'}
                                          />
                                        </button>
                                      </div>
                                      <div className="text-xs text-gray-500 space-y-1">
                                        <div>{formatFileSize(doc.metadata.size)} • {(doc.metadata.file_type as string) || ''}</div>
                                        <div>{formatDate(doc.metadata.uploaded_at)}</div>
                                        <IngestionStatus
                                          metadata={doc.metadata}
                                          onRetry={() => retryIngestion(doc.id)}
                                          onReplace={() => showReplaceDialog(doc.id)}
                                        />
                                      </div>
                                    </div>
                                  </div>

                                </div>
                              ) : (
                                <div className="flex items-center space-x-3 flex-1 min-w-0">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 accent-blue-600 cursor-pointer"
                                    checked={selectedDocuments.includes(doc.id)}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={() => toggleDocumentSelection(doc.id)}
                                    aria-label={`选择文件 ${doc.metadata.filename}`}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between">
                                      <h5 className="font-medium text-sm truncate" onClick={() => openDocumentInViewer(doc)} style={{ cursor: 'pointer' }}>
                                        {doc.metadata.filename}
                                      </h5>
                                      <button
                                        className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          try {
                                            await toggleDocumentFavorite(doc.id, !doc.metadata.is_favorite);
                                            // 重新加载文档列表
                                            const docs = await getDocuments();
                                            setDocuments(docs);
                                            // 更新收藏的文档
                                            const favDocs = docs.filter(d => d.metadata.is_favorite);
                                            setFavoriteDocuments(favDocs);
                                          } catch (error) {
                                            message.error('更新收藏状态失败');
                                          }
                                        }}
                                      >
                                        <Icon
                                          icon={doc.metadata.is_favorite ? 'solar:heart-bold' : 'solar:heart-linear'}
                                          className={doc.metadata.is_favorite ? 'text-red-500' : 'text-gray-400 dark:text-slate-500'}
                                        />
                                      </button>
                                    </div>
                                    <div className="text-xs text-gray-500 space-y-1">
                                      <div>{formatFileSize(doc.metadata.size)} • {(doc.metadata.file_type as string) || ''}</div>
                                      <div>{formatDate(doc.metadata.uploaded_at)}</div>
                                      <IngestionStatus
                                        metadata={doc.metadata}
                                        onRetry={() => retryIngestion(doc.id)}
                                        onReplace={() => showReplaceDialog(doc.id)}
                                      />
                                    </div>
                                  </div>

                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 场景3：创作中心 Area */}
          {activeTab === 'write' && (
            <div className="flex-1 flex flex-col h-full p-6 md:px-20">
              <div className="flex items-center space-x-4 mb-6">
                <button
                  className="flex items-center space-x-1 text-sm text-gray-500 hover:text-brand-600 transition-colors"
                  onClick={() => setActiveTab('ask')}
                >
                  <Icon icon="solar:alt-arrow-left-bold" />
                  <span>返回问答</span>
                </button>
                <div className="h-4 w-px bg-gray-200 dark:bg-slate-800"></div>
                <h3 className="text-sm font-bold flex items-center space-x-2">
                  <Icon icon="solar:pen-2-line-duotone" className="text-brand-600" />
                  <span>创作中心</span>
                </h3>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-xl shadow-md border border-gray-200 dark:border-slate-700 p-6">
                <h4 className="text-lg font-bold mb-4">文档创作</h4>
                <p className="text-gray-500 mb-6">创作中心功能正在开发中，敬请期待！</p>
                <button
                  className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-bold flex items-center space-x-1 transition-all hover:shadow-md hover:bg-brand-700"
                  onClick={() => setActiveTab('ask')}
                >
                  <Icon icon="solar:message-circle-bold" />
                  <span>返回智能问答</span>
                </button>
              </div>
            </div>
          )}
        </main>

      </div>

      {/* 全屏文档预览 */}
      {isDrawerOpen && selectedDocument && (
        <div className="fixed inset-0 bg-white dark:bg-slate-900 z-[9999] flex flex-col">
          {/* 顶部导航栏 */}
          <div className="p-3 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between bg-gray-50 dark:bg-slate-800">
            <div className="flex items-center space-x-3">
              <button
                className="p-2 hover:bg-gray-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
                onClick={toggleDrawer}
                title="返回仓库"
              >
                <Icon icon="solar:arrow-left-bold" className="text-gray-600 dark:text-gray-400" />
              </button>
              <h4 className="font-medium text-sm text-gray-800 dark:text-gray-200">{selectedDocument.metadata.filename}</h4>
            </div>
            <div className="flex items-center space-x-2">
              <button
                className="px-3 py-1.5 bg-brand-600 text-white rounded-lg text-xs font-bold flex items-center space-x-1 transition-all hover:shadow-md hover:bg-brand-700"
                onClick={() => {
                  generateSummary();
                }}
                title="智能总结"
              >
                <Icon icon="solar:document-text-bold" className="text-sm" />
                <span>智能总结</span>
              </button>
            </div>
          </div>

          {/* 主内容区域 */}
          <div className="flex-1 flex overflow-hidden">
            {/* 左侧目录导航 */}
            <div className="w-64 border-r border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900 overflow-y-auto">
              <div className="p-4 border-b border-gray-200 dark:border-slate-800">
                <h5 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">文档目录</h5>
              </div>
              <div className="p-2">
                {documentView?.view_type === 'pdf' ? (
                  pdfNavigation ? (
                    <nav className="space-y-1" aria-label={pdfNavigation.bookmarks.length ? 'PDF 章节目录' : 'PDF 页码导航'}>
                      {!pdfNavigation.bookmarks.length && <p className="px-3 py-2 text-xs text-gray-500">PDF 没有可用书签，按页码浏览。</p>}
                      {pdfDirectory.map((item, index) => (
                        <button key={index} type="button"
                          className="block w-full break-words rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-200 dark:hover:bg-slate-800"
                          style={{ paddingLeft: Math.min(item.level, 5) * 12 + 12 }}
                          title={`跳到第 ${item.pageIndex + 1} 页`}
                          onClick={() => setPdfPageJump(pdfNavigation.bookmarks.length ? { ...item } : { pageIndex: item.pageIndex })}>
                          {item.title}
                        </button>
                      ))}
                    </nav>
                  ) : <p className="px-3 py-4 text-xs text-gray-500">{documentViewError ? '目录暂时无法加载' : '正在读取 PDF 目录…'}</p>
                ) : documentView?.directory && documentView.directory.length > 0 ? (
                  <div className="space-y-1">
                    {documentView.directory.map((item: any, index: number) => (
                      <div
                        key={item.id || index}
                        className={`px-3 py-2 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-800 text-sm text-gray-700 dark:text-gray-300 cursor-pointer transition-colors ${index === 0 ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400 font-medium' : ''}`}
                        style={{ paddingLeft: `${(item.level - 1) * 12 + 12}px` }}
                        onClick={() => {
                          if (item.id) {
                            const element = document.getElementById(item.id);
                            if (element) {
                              element.scrollIntoView({ behavior: 'smooth' });
                            }
                          }
                        }}
                      >
                        {item.title}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-4 text-xs text-gray-400">
                    文档中未检测到目录
                  </div>
                )}
              </div>
            </div>

            {/* 中间文档内容 */}
            <div className="min-w-0 flex-1 overflow-auto">
              {documentViewLoading ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-brand-600 mx-auto mb-4"></div>
                    <p className="text-gray-500">加载中...</p>
                  </div>
                </div>
              ) : documentViewError ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <Icon icon="solar:alert-circle-bold" className="text-red-500 text-4xl mb-4" />
                    <p className="text-red-500 mb-4">{documentViewError}</p>
                  </div>
                </div>
              ) : documentView ? (
                <div className="h-full flex flex-col">

                  {/* 内容区域 */}
                  <div className="flex-1 overflow-auto">
                    {documentView?.view_type === 'pdf' && selectedDocument && (
                      <div className="h-full p-3">
                        <React.Suspense fallback={<p role="status">正在加载 PDF 阅读器…</p>}>
                          <PdfReferencePreview key={selectedDocument.id} url={getDocumentFileUrl(selectedDocument.id)}
                            sources={noPdfSources} onError={handlePdfPreviewError}
                            onNavigation={setPdfNavigation} pageJump={pdfPageJump} />
                        </React.Suspense>
                      </div>
                    )}
                    {documentView?.view_type === 'docx' && documentView?.content && (
                      <div className="h-full overflow-auto p-6">
                        <div className="text-sm whitespace-pre-wrap break-words">
                          {documentView.content}
                        </div>
                      </div>
                    )}
                    {(documentView?.view_type === 'txt' || documentView?.view_type === 'md' || documentView?.view_type === 'text') && (
                      <div className="h-full overflow-auto p-6">
                        <div className="text-sm whitespace-pre-wrap break-words">
                          {documentView?.content && documentView?.directory ? (
                            documentView.content.split('\n').map((line: string, index: number) => {
                              // 查找当前行是否是目录项
                              const directoryItem = documentView.directory.find((item: any) => {
                                // 对于TXT文件，目录项的ID是section-行号
                                return item.id === `section-${index}`;
                              });
                              if (directoryItem) {
                                return (
                                  <div key={index} id={directoryItem.id} className="font-bold mt-4 mb-2">
                                    {line}
                                  </div>
                                );
                              }
                              return <div key={index}>{line}</div>;
                            })
                          ) : (
                            documentView?.content
                          )}
                        </div>
                      </div>
                    )}
                    {documentView?.view_type === 'md' && (
                      <div className="h-full overflow-auto p-6">
                        <div className="text-sm whitespace-pre-wrap break-words">
                          {documentView?.content && documentView?.directory ? (
                            documentView.content.split('\n').map((line: string, index: number) => {
                              const trimmedLine = line.trim();
                              if (trimmedLine.startsWith('#')) {
                                const level = (trimmedLine.match(/#/g) || []).length;
                                const title = trimmedLine.replace(/^#+\s*/, '').trim();
                                // 使用与后端相同的ID生成逻辑
                                const id = title.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-').replace(/\?/g, '');
                                return (
                                  <div key={index} id={id} className={`font-bold ${level === 1 ? 'text-xl mt-6 mb-3' : level === 2 ? 'text-lg mt-4 mb-2' : 'text-base mt-3 mb-1'}`}>
                                    {line}
                                  </div>
                                );
                              }
                              return <div key={index}>{line}</div>;
                            })
                          ) : (
                            documentView?.content
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <Icon icon="solar:file-search-bold" className="text-gray-400 text-4xl mb-4" />
                    <p className="text-gray-500">文档预览不可用</p>
                  </div>
                </div>
              )}
            </div>

            {/* 右侧智能总结 */}
            <div role="separator" aria-label="调整智能总结栏宽度" aria-orientation="vertical"
              aria-valuemin={16} aria-valuemax={40} aria-valuenow={Math.round(summaryWidth)} tabIndex={0}
              className="hidden w-2 shrink-0 cursor-col-resize touch-none select-none bg-gray-200 hover:bg-brand-500 focus-visible:bg-brand-500 dark:bg-slate-800 lg:block"
              onPointerDown={event => {
                if (event.button !== 0 || !event.isPrimary) return;
                const handle = event.currentTarget;
                const containerWidth = handle.parentElement?.clientWidth;
                if (!containerWidth) return;
                summaryDrag.current = { x: event.clientX, width: summaryWidth, containerWidth };
                handle.setPointerCapture(event.pointerId);
                event.preventDefault();
              }}
              onPointerMove={event => {
                const start = summaryDrag.current;
                if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                setSummaryWidth(clampSummaryWidth(start.width + (start.x - event.clientX) / start.containerWidth * 100));
              }}
              onLostPointerCapture={() => { summaryDrag.current = null; }}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                setSummaryWidth(width => clampSummaryWidth(width + (event.key === 'ArrowLeft' ? 2 : -2)));
              }}
            />
            <div style={{ '--summary-width': summaryWidth + '%' } as React.CSSProperties}
              className="w-64 overflow-y-auto border-l border-gray-200 bg-gray-50 dark:border-slate-800 dark:bg-slate-900 lg:w-[var(--summary-width)] lg:shrink-0">
              <div className="p-4 border-b border-gray-200 dark:border-slate-800">
                <h5 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">智能总结</h5>
                {pdfNavigation && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">PDF 原文 · 共 {pdfNavigation.totalPages} 页</p>}
              </div>
              <div className="p-4">
                {summaryLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-brand-600 mr-2"></div>
                    <span className="text-sm text-gray-500">生成中...</span>
                  </div>
                ) : summaryError ? (
                  <div className="text-red-500 text-sm mb-4">
                    {summaryError}
                  </div>
                ) : summary ? (
                  <div className="text-sm text-gray-700 dark:text-gray-300 space-y-2">
                    {summary.split('\n').map((line, index) => (
                      <p key={index}>{line}</p>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <Icon icon="solar:document-text-bold" className="text-gray-400 text-3xl mb-2 mx-auto" />
                    <p className="text-sm text-gray-500">点击上方"智能总结"按钮生成文档摘要</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 文件夹选择对话框 */}
      <Modal
        title="选择上传目标文件夹"
        open={isFolderSelectorOpen}
        onOk={handleFolderSelectConfirm}
        okButtonProps={{ disabled: isCreatingUploadFolder }}
        onCancel={() => setIsFolderSelectorOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <div className="max-h-96 overflow-y-auto">
          <div className="space-y-2 mb-4">
            <FolderSelectorList />
          </div>
          <div className="border-t border-gray-200 dark:border-slate-700 pt-4">
            <h5 className="text-sm font-medium mb-2">创建新文件夹</h5>
            <div className="flex space-x-2">
              <Input
                placeholder="输入文件夹名称"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                className="flex-1"
              />
              <button
                className="px-3 py-1 bg-brand-600 text-white rounded-lg text-sm font-bold transition-all hover:shadow-md hover:bg-brand-700 disabled:opacity-50"
                disabled={isCreatingUploadFolder}
                onClick={async () => {
                  if (creatingUploadFolderRef.current) return;
                  const name = newFolderName.trim();
                  if (!name) {
                    message.warning('请输入文件夹名称');
                    return;
                  }
                  creatingUploadFolderRef.current = true;
                  setIsCreatingUploadFolder(true);
                  try {
                    const { folder } = await createFolder(name);
                    setFolders(current => current.some(item => item.id === folder.id) ? current : [...current, folder]);
                    setSelectedFolder(folder.id);
                    setNewFolderName('');
                    message.success('文件夹创建成功');
                  } catch (error) {
                    message.error('创建文件夹失败，' + (error instanceof Error ? error.message : '请稍后重试。'));
                  } finally {
                    creatingUploadFolderRef.current = false;
                    setIsCreatingUploadFolder(false);
                  }
                }}
              >
                <Icon icon="solar:folder-add-bold" className="mr-1" />
                创建
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* 新建文件夹对话框 */}
      <Modal
        title="新建文件夹"
        open={isFolderModalOpen}
        onOk={handleCreateFolder}
        onCancel={() => setIsFolderModalOpen(false)}
        okText="创建"
        cancelText="取消"
      >
        <Input
          placeholder="请输入文件夹名称"
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
        />
      </Modal>

      {/* 重命名文件夹对话框 */}
      <Modal
        title="重命名文件夹"
        open={isRenameModalOpen}
        onOk={handleRenameFolderSubmit}
        onCancel={() => setIsRenameModalOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <Input
          placeholder="请输入新的文件夹名称"
          value={renameFolderName}
          onChange={(e) => setRenameFolderName(e.target.value)}
        />
      </Modal>

      {/* 删除文件夹对话框 */}
      <Modal
        title="删除文件夹"
        open={isDeleteModalOpen}
        onOk={handleDeleteFolderSubmit}
        onCancel={() => setIsDeleteModalOpen(false)}
        okText="删除"
        cancelText="取消"
        okType="danger"
      >
        <p>确定要删除该文件夹吗？删除后将无法恢复。</p>
      </Modal>

      {/* 移动文件对话框 */}
      <Modal
        title="移动文件"
        open={isMoveModalOpen}
        onOk={handleMoveDocumentsSubmit}
        onCancel={() => setIsMoveModalOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <div className="max-h-96 overflow-y-auto">
          <div className="space-y-2">
            {folders.map((folder) => (
              <button
                key={folder.id}
                className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition-all ${targetFolderId === folder.id ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200/50 dark:hover:bg-slate-800'}`}
                onClick={() => setTargetFolderId(folder.id)}
              >
                <Icon icon="solar:folder-bold" />
                <span className="font-medium">{folder.name}</span>
              </button>
            ))}
          </div>
        </div>
      </Modal>

      {/* 复制文件对话框 */}
      <Modal
        title="复制文件"
        open={isCopyModalOpen}
        onOk={handleCopyDocumentsSubmit}
        onCancel={() => setIsCopyModalOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <div className="max-h-96 overflow-y-auto">
          <div className="space-y-2">
            {folders.map((folder) => (
              <button
                key={folder.id}
                className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition-all ${targetFolderId === folder.id ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200/50 dark:hover:bg-slate-800'}`}
                onClick={() => setTargetFolderId(folder.id)}
              >
                <Icon icon="solar:folder-bold" />
                <span className="font-medium">{folder.name}</span>
              </button>
            ))}
          </div>
        </div>
      </Modal>

      {/* 重命名文件对话框 */}
      <Modal
        title="重命名文件"
        open={isRenameFileModalOpen}
        onOk={handleRenameFileSubmit}
        onCancel={() => setIsRenameFileModalOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <Input
          placeholder="请输入新的文件名"
          value={renameFileName}
          onChange={(e) => setRenameFileName(e.target.value)}
        />
      </Modal>

      {/* 编辑文件对话框 */}
      <Modal
        title="替换文件"
        open={isEditFileModalOpen}
        onOk={() => document.getElementById('edit-file-input')?.click()}
        onCancel={() => setIsEditFileModalOpen(false)}
        okText="选择文件"
        cancelText="取消"
      >
        <p className="mb-4">请选择新文件来替换当前文件：</p>
        <input
          type="file"
          id="edit-file-input"
          accept=".pdf,.doc,.docx,.txt,.md"
          className="hidden"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) {
              handleEditFileSubmit(file);
            }
          }}
        />
      </Modal>

      {/* 权限设置对话框 */}
      <Modal
        title="设置文件权限"
        open={isPermissionModalOpen}
        onOk={handlePermissionFileSubmit}
        onCancel={() => setIsPermissionModalOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <Select
          defaultValue="private"
          value={filePermission}
          onChange={setFilePermission}
          style={{ width: '100%' }}
        >
          <Select.Option value="private">私有</Select.Option>
          <Select.Option value="shared">共享</Select.Option>
          <Select.Option value="public">公开</Select.Option>
        </Select>
      </Modal>


    </div>
  );
}

export default App;