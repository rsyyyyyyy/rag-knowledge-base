import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { renderAsync } from 'docx-preview';
import { Icon } from '@iconify/react';
import { Modal, Input, Select, Tooltip, Dropdown, message } from 'antd';
import type { ChatThread, ChatTurn, DocumentOutlineItem, ModelOption, PdfAnnotation, Source } from './services/api';
import OnlinePaperSearch, { type OnlinePaperAttachment } from './components/OnlinePaperSearch';
import ReferenceSources, { ReferencePanel, type ReferenceFile } from './components/ReferenceSources';
import { chatStream, listChatThreads, createChatThread, getChatThread, renameChatThread, deleteChatThread, parseFileOnly, getDocumentFileUrl, getDocumentView, getDocumentOutline, getDocumentAnnotations, createDocumentAnnotation, deleteDocumentAnnotation, getAvailableModels, getDocuments, uploadDocument, reindexDocument, replaceDocument, getFolders, createFolder, renameFolder, deleteFolder, batchOperateDocuments, searchDocuments, updateDocumentAccess, toggleDocumentFavorite, generateDocumentSummary, enrichDocumentMetadata, updateDocumentMetadata } from './services/api';
import IngestionStatus, { isIngestionPending } from './components/IngestionStatus';
import SectionReader from './components/SectionReader';
import PaperProfile from './components/PaperProfile';
import PaperDiscovery from './components/PaperDiscovery';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { citationNumberFromHref, remarkCitationLinks } from './citationLinks';
import remend, { isWithinCodeBlock } from 'remend';
import type { PdfNavigation, PdfPageJump } from './components/PdfReferencePreview';

const PdfReferencePreview = React.lazy(() => import('./components/PdfReferencePreview'));
const noPdfSources: Source[] = [];
type PdfDirectoryItem = PdfPageJump & { level: number };
const fallbackModels: ModelOption[] = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash', provider: 'deepseek', model: 'deepseek-flash', local: false, configured: true },
  { id: 'qwen:qwen-plus', label: '通义千问 Plus', provider: 'qwen', model: 'qwen-plus', local: false, configured: false },
  { id: 'moonshot:kimi', label: 'Kimi（Moonshot）', provider: 'moonshot', model: 'moonshot-v1-8k', local: false, configured: false },
  { id: 'openai:gpt', label: 'OpenAI GPT', provider: 'openai', model: 'gpt-4o-mini', local: false, configured: false },
  { id: 'ollama:local', label: '本地 Ollama', provider: 'ollama', model: 'qwen2.5:7b', local: true, configured: false },
];
type AnnotationHistoryEntry =
  | { type: 'create'; id: string }
  | { type: 'delete'; annotation: PdfAnnotation };

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
  verifyingCitations?: boolean;
}

function presentAnswer(content: string) {
  // Hide legacy operational notices without rewriting stored conversations.
  const endOfAnswer = content.search(/^#{1,6}[ \t]+本轮(?:还未核实|核验未完成)[ \t]*$/m);
  const visibleAnswer = endOfAnswer < 0 ? content : content.slice(0, endOfAnswer);
  return visibleAnswer.split('\n').filter(line => !(
    /^\*\*(全文阅读|文献概览|引用定位)\*\*/.test(line)
    || /^已读取 \d+\/\d+ 个正文片段。/.test(line)
    || line === '长文已分批阅读并汇总；汇总可能省略细节，可继续针对具体章节追问。'
    || line === '以下总结基于本轮能核验的原文，部分细节可能未覆盖。'
  )).join('\n')
    .replace(/(\*\*通用回答\*\*|\*\*附件回答\*\*)[ \t]*·[ \t]*本轮未找到可引用的知识库证据。?(?:以下依据本次附件。)?/g, '$1')
    .replace(/该项结论的原文依据不足。[ \t]*[。.!?！？]*|（此处原文依据不足）/g, '')
    .replace(/^已找到指定论文，但本轮未确认能支撑这个问题的原文片段。/, '')
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]*$/gm, '')
    .trim();
}

function chatMessages(turns: ChatTurn[]): Message[] {
  return turns.flatMap(turn => [
    { role: 'user', content: turn.attachment_filename
      ? `${turn.question}\n📎 附件：${turn.attachment_filename}` : turn.question },
    { role: 'assistant', content: turn.answer, sources: turn.sources, complete: true },
  ]);
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



  const [activeTab, setActiveTab] = useState('ask');
  const [referenceFile, setReferenceFile] = useState<ReferenceFile | null>(null);
  const citationSelection = useRef(0);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showCommandHint, setShowCommandHint] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [renamingThread, setRenamingThread] = useState<ChatThread | null>(null);
  const [threadName, setThreadName] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [ragEnabled, setRagEnabled] = useState(true);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => {
    try { return window.localStorage.getItem('rag-answer-model'); } catch { return null; }
  });
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [chatAttachment, setChatAttachment] = useState<{
    filename: string; text: string; basis?: OnlinePaperAttachment['basis']; sourceUrl?: string; inLibrary?: boolean;
  } | null>(null);
  const [onlinePaperSearchOpen, setOnlinePaperSearchOpen] = useState(false);
  const [showAttachmentChoice, setShowAttachmentChoice] = useState(false);
  const [pendingAttachmentFile, setPendingAttachmentFile] = useState<File | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [indexedDocuments, setIndexedDocuments] = useState<Document[] | null>(null);
  const [indexCountUnavailable, setIndexCountUnavailable] = useState(false);
  const showChatWelcome = activeTab === 'ask' && messages.length === 0 && !historyLoading;
  const [firstPaper, secondPaper] = indexedDocuments ?? [];
  const recommendedQuestions = [
    { title: '全库概览', content: '知识库里的文献主要研究哪些主题？每个主题有哪些代表论文？' },
    { title: '找相关论文', content: '知识库里有哪些论文讨论了模型评估？它们分别评估什么？' },
    { title: '单篇精读', content: firstPaper
      ? `《${firstPaper.metadata.filename}》用了什么研究方法？请给出原文出处。`
      : '这篇论文用了什么研究方法？请给出原文出处。', disabled: !firstPaper },
    { title: '跨篇比较', content: firstPaper && secondPaper
      ? `比较《${firstPaper.metadata.filename}》和《${secondPaper.metadata.filename}》的研究方法和主要发现，并分别标注出处。`
      : '比较两篇论文的研究方法和主要发现，并分别标注出处。', disabled: !secondPaper },
  ];
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [currentFolderPath, setCurrentFolderPath] = useState<string[]>([]); // 面包屑路径
  const [documentView, setDocumentView] = useState<any | null>(null);
  const [documentViewLoading, setDocumentViewLoading] = useState(false);
  const [documentViewError, setDocumentViewError] = useState('');
  const [summaryWidth, setSummaryWidth] = useState(20);
  const [isDirectoryCollapsed, setIsDirectoryCollapsed] = useState(false);
  const summaryDrag = useRef<{ x: number; width: number; containerWidth: number } | null>(null);
  const [pdfNavigation, setPdfNavigation] = useState<PdfNavigation | null>(null);
  const [pdfPageJump, setPdfPageJump] = useState<PdfPageJump | null>(null);
  const [outlineItems, setOutlineItems] = useState<DocumentOutlineItem[]>([]);
  const outlineRequest = useRef(0);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const annotationsRequest = useRef(0);
  const [viewerPanel, setViewerPanel] = useState<'summary' | 'annotations' | 'sections' | 'profile'>('summary');
  const [sectionEvidence, setSectionEvidence] = useState<Source[]>([]);
  const [sectionSelectionId, setSectionSelectionId] = useState(0);
  const selectSectionPassage = useCallback((source: Source) => {
    setSectionEvidence([source]);
    setSectionSelectionId(value => value + 1);
    setPdfPageJump(null);
  }, []);
  const annotationHistory = useRef<AnnotationHistoryEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const handlePdfPreviewError = useCallback(() => setDocumentViewError('无法加载 PDF 原件。'), []);
  const bookmarkDirectory = pdfNavigation?.bookmarks ?? [];
  const generatedDirectory = outlineItems.map(item => ({
    title: item.title, level: item.level, pageIndex: item.page_index,
  }));
  const useBookmarks = bookmarkDirectory.length >= 5;
  const hasOutline = useBookmarks || generatedDirectory.length > 0;
  const pdfDirectory: PdfDirectoryItem[] = useBookmarks
    ? bookmarkDirectory
    : generatedDirectory.length
      ? generatedDirectory
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
  const [isGridView, setIsGridView] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [documentPage, setDocumentPage] = useState(1);
  const [documentPageSize, setDocumentPageSize] = useState(20);
  const [searchQuery, setSearchQuery] = useState('');
  const [isRenameFileModalOpen, setIsRenameFileModalOpen] = useState(false);
  const [renameFileId, setRenameFileId] = useState('');
  const [renameFileName, setRenameFileName] = useState('');
  const [isEditFileModalOpen, setIsEditFileModalOpen] = useState(false);
  const [editFileId, setEditFileId] = useState('');
  const [isMetadataModalOpen, setIsMetadataModalOpen] = useState(false);
  const [metadataDocId, setMetadataDocId] = useState('');
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataEnriching, setMetadataEnriching] = useState(false);
  const [metadataForm, setMetadataForm] = useState({ title: '', authors: '', year: '', venue: '', doi: '' });
  const [isPermissionModalOpen, setIsPermissionModalOpen] = useState(false);
  const [permissionFileId, setPermissionFileId] = useState('');
  const [filePermission, setFilePermission] = useState('private'); // private, shared, public
  const [sortBy, setSortBy] = useState('uploaded_at'); // uploaded_at, filename, size
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc'); // asc, desc
  const [isFolderSelectorOpen, setIsFolderSelectorOpen] = useState(false); // 文件夹选择对话框
  const [filesToUpload, setFilesToUpload] = useState<File[]>([]); // 待上传的文件
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({}); // 上传进度
  const [isDragging, setIsDragging] = useState(false); // 拖拽状态
  const [recentDocuments, setRecentDocuments] = useState<Document[]>([]); // 最近使用的文档
  const [favoriteDocuments, setFavoriteDocuments] = useState<Document[]>([]); // 收藏的文档
  const [filterType, setFilterType] = useState('all'); // 筛选类型：all, recent, favorite
  const [activeFilter, setActiveFilter] = useState('all'); // 当前激活的筛选
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const documentViewRequest = useRef(0);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const followChatRef = useRef(true);
  const chatInFlightRef = useRef(false);
  const docxContainerRef = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    const apply = (list: ModelOption[]) => {
      if (!active) return;
      const options = list.length ? list : fallbackModels;
      setModels(options);
      const configured = options.find(item => item.configured) ?? options[0];
      setSelectedModel(previous => previous && options.some(item => item.id === previous && item.configured)
        ? previous : configured?.id ?? null);
      setModelsLoading(false);
    };
    void getAvailableModels().then(apply).catch(() => apply(fallbackModels));
    return () => { active = false; };
  }, []);

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

  useEffect(() => {
    if (!showChatWelcome) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshIndexCount = async () => {
      try {
        // The management list may be filtered by folder, type or search.
        const library = await getDocuments();
        if (cancelled) return;
        setIndexedDocuments(library.filter(doc => doc.metadata.searchable === true));
        setIndexCountUnavailable(false);
        if (library.some(doc => isIngestionPending(doc.metadata.status))) {
          timer = setTimeout(refreshIndexCount, 1500);
        }
      } catch {
        if (!cancelled) setIndexCountUnavailable(true);
      }
    };
    void refreshIndexCount();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [showChatWelcome]);

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

  const metadataText = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const documentTitle = (doc: Document) => metadataText(doc.metadata.title) || doc.metadata.filename;
  const documentAuthors = (doc: Document) => {
    if (Array.isArray(doc.metadata.authors)) {
      const authors = doc.metadata.authors.map(author => metadataText(author)).filter(Boolean);
      return authors.length ? authors.join('、') : '—';
    }
    return metadataText(doc.metadata.author) || '—';
  };
  const documentYear = (doc: Document) => {
    const year = doc.metadata.year;
    return typeof year === 'string' || typeof year === 'number' ? String(year) : '—';
  };
  const documentVenue = (doc: Document) => (
    metadataText(doc.metadata.venue)
    || metadataText(doc.metadata.journal)
    || metadataText(doc.metadata.source)
    || '—'
  );
  const documentDoi = (doc: Document) => metadataText(doc.metadata.doi);
  const documentFolder = (doc: Document) => {
    const folderId = metadataText(doc.metadata.folder_id);
    if (!folderId) return '默认文件夹';
    return folders.find(folder => folder.id === folderId)?.name || '—';
  };
  const documentTags = (doc: Document) => (
    Array.isArray(doc.metadata.tags)
      ? doc.metadata.tags.map(tag => metadataText(tag)).filter(Boolean)
      : []
  );
  const formatDay = (value: string) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN');
  };
  const ingestionLabels: Record<string, string> = {
    queued: '等待入库', processing: '正在入库', parsed: '可检索',
    failed: '入库失败', no_text_extracted: '未提取到文本', stored_only: '原件已保存',
  };
  const ingestionStyles: Record<string, string> = {
    queued: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    processing: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    parsed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    failed: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    no_text_extracted: 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
    stored_only: 'bg-gray-100 text-gray-600 dark:bg-slate-800 dark:text-slate-300',
  };
  const toggleFavoriteDocument = async (doc: Document) => {
    try {
      await toggleDocumentFavorite(doc.id, !doc.metadata.is_favorite);
      const docs = await getDocuments();
      setDocuments(docs);
      setFavoriteDocuments(docs.filter(item => item.metadata.is_favorite));
    } catch {
      message.error('更新收藏状态失败');
    }
  };

  const refreshDocuments = async () => {
    const docs = await getDocuments();
    setDocuments(docs);
    setRecentDocuments([...docs].sort((a, b) => {
      const left = new Date((a.metadata.last_accessed_at as string) || a.metadata.uploaded_at).getTime();
      const right = new Date((b.metadata.last_accessed_at as string) || b.metadata.uploaded_at).getTime();
      return right - left;
    }).slice(0, 5));
    setFavoriteDocuments(docs.filter(item => item.metadata.is_favorite));
    return docs;
  };

  const runMetadataEnrichment = async (docIds?: string[], force = false) => {
    if (metadataEnriching) return;
    setMetadataEnriching(true);
    try {
      let updated = 0;
      let remaining = 0;
      let rounds = 0;
      do {
        const result = await enrichDocumentMetadata(docIds, force, 10);
        updated += result.updated.length;
        remaining = result.remaining;
        rounds += 1;
      } while (!docIds && !force && remaining > 0 && rounds < 5);
      await refreshDocuments();
      if (updated > 0) {
        message.success(`已补全 ${updated} 篇文献的元数据。${remaining > 0 ? `还有 ${remaining} 篇可继续补全。` : ''}`);
      } else {
        message.info(force ? '没有识别到新的元数据。' : '没有需要补全的文献。');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '补全元数据失败。');
    } finally {
      setMetadataEnriching(false);
    }
  };

  const openMetadataEditor = (doc: Document) => {
    const authors = Array.isArray(doc.metadata.authors)
      ? doc.metadata.authors.map(author => metadataText(author)).filter(Boolean).join('、')
      : metadataText(doc.metadata.author);
    setMetadataDocId(doc.id);
    setMetadataForm({
      title: metadataText(doc.metadata.title),
      authors,
      year: doc.metadata.year === undefined || doc.metadata.year === null ? '' : String(doc.metadata.year),
      venue: metadataText(doc.metadata.venue) || metadataText(doc.metadata.journal) || metadataText(doc.metadata.source),
      doi: metadataText(doc.metadata.doi),
    });
    setIsMetadataModalOpen(true);
  };

  const handleMetadataSubmit = async () => {
    if (!metadataDocId || metadataSaving) return;
    setMetadataSaving(true);
    try {
      const { document: updated } = await updateDocumentMetadata(metadataDocId, {
        title: metadataForm.title.trim() || undefined,
        authors: metadataForm.authors.trim() || undefined,
        year: metadataForm.year.trim() || undefined,
        venue: metadataForm.venue.trim() || undefined,
        doi: metadataForm.doi.trim() || undefined,
      });
      const applyUpdate = (list: Document[]) => list.map(doc => doc.id === updated.id ? updated : doc);
      setDocuments(applyUpdate);
      setRecentDocuments(applyUpdate);
      setFavoriteDocuments(applyUpdate);
      setIsMetadataModalOpen(false);
      message.success('元数据已保存。');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存元数据失败。');
    } finally {
      setMetadataSaving(false);
    }
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
          const deleting = new Set(selectedDocuments);
          await batchOperateDocuments('delete', selectedDocuments);

          // 重新加载文档列表，保持当前的搜索和筛选状态
          await handleSearch();
          setRecentDocuments(previous => previous.filter(item => !deleting.has(item.id)));
          setFavoriteDocuments(previous => previous.filter(item => !deleting.has(item.id)));
          if (selectedDocument && deleting.has(selectedDocument.id)) {
            setIsDrawerOpen(false);
            setSelectedDocument(null);
            setDocumentView(null);
            setAnnotations([]);
          }

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



  const handleDeleteDocument = (doc: Document) => {
    Modal.confirm({
      title: '删除文献',
      content: `确定删除《${documentTitle(doc)}》吗？原文件、索引和批注都会删除，无法恢复。`,
      okText: '删除',
      cancelText: '取消',
      okType: 'danger',
      onOk: async () => {
        try {
          await batchOperateDocuments('delete', [doc.id]);
          setSelectedDocuments(previous => previous.filter(id => id !== doc.id));
          setRecentDocuments(previous => previous.filter(item => item.id !== doc.id));
          setFavoriteDocuments(previous => previous.filter(item => item.id !== doc.id));
          if (selectedDocument?.id === doc.id) {
            setIsDrawerOpen(false);
            setSelectedDocument(null);
            setDocumentView(null);
            setAnnotations([]);
          }
          await handleSearch();
          message.success('文献已删除');
        } catch (error) {
          console.error('Error deleting document:', error);
          message.error(`删除文献失败：${error instanceof Error ? error.message : '未知错误'}`);
          throw error;
        }
      },
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
        undefined,
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
    const request = ++documentViewRequest.current;
    setPdfNavigation(null);
    setPdfPageJump(null);
    setSectionEvidence([]);
    setSelectedDocument(doc);
    setIsDrawerOpen(true);
    setDocumentViewLoading(true);
    setDocumentViewError('');
    const outlineId = ++outlineRequest.current;
    setOutlineItems([]);
    const annotationId = ++annotationsRequest.current;
    setAnnotations([]);
    annotationHistory.current = [];
    setCanUndo(false);
    setViewerPanel('summary');
    if (String(doc.metadata.file_type).toLowerCase() === '.pdf') {
      void getDocumentOutline(doc.id).then(items => {
        if (outlineId === outlineRequest.current) setOutlineItems(items);
      }).catch(() => {
        if (outlineId === outlineRequest.current) setOutlineItems([]);
      });
    }
    // 清空之前的总结状态
    setSummary(null);
    setSummaryError(null);
    void updateDocumentAccess(doc.id).then(getDocuments).then(docs => {
      if (request !== documentViewRequest.current) return;
      setDocuments(docs);

      // 更新最近使用的文档
      const recentDocs = [...docs].sort((a, b) => {
        const dateA = new Date((a.metadata.last_accessed_at as string) || (a.metadata.uploaded_at as string)).getTime();
        const dateB = new Date((b.metadata.last_accessed_at as string) || (b.metadata.uploaded_at as string)).getTime();
        return dateB - dateA;
      }).slice(0, 5);
      setRecentDocuments(recentDocs);
    }).catch(() => {});
    try {
      const view = await getDocumentView(doc.id, false);
      if (request === documentViewRequest.current) {
        setDocumentView(view);
        if (view.view_type === 'pdf' && view.version_id) {
          const versionId = view.version_id;
          void getDocumentAnnotations(doc.id, versionId).then(items => {
            if (annotationId === annotationsRequest.current) setAnnotations(items);
          }).catch(() => {
            if (annotationId === annotationsRequest.current) setAnnotations([]);
          });
        }
      }
    } catch (error) {
      if (request !== documentViewRequest.current) return;
      setDocumentView(null);
      setDocumentViewError(error instanceof Error ? error.message : '加载文档失败');
    } finally {
      if (request === documentViewRequest.current) setDocumentViewLoading(false);
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

  };

  useEffect(() => {
    let active = true;
    async function restoreHistory() {
      try {
        const { threads } = await listChatThreads();
        if (!active) return;
        setChatThreads(threads);
        const latest = threads[0];
        if (!latest) return;
        const { turns } = await getChatThread(latest.id);
        if (active) {
          setThreadId(latest.id);
          setMessages(chatMessages(turns));
        }
      } catch {
        if (active) message.error('无法加载历史对话，请检查后端服务。');
      } finally {
        if (active) setHistoryLoading(false);
      }
    }
    void restoreHistory();
    return () => { active = false; };
  }, []);

  const applyChatThread = (id: string | null, turns: ChatTurn[] = []) => {
    followChatRef.current = true;
    setThreadId(id);
    setMessages(chatMessages(turns));
    setInputValue('');
    setShowCommandHint(false);
    setChatAttachment(null);
    setPendingAttachmentFile(null);
    setShowAttachmentChoice(false);
    setReferenceFile(null);
    setRagEnabled(true);
    setActiveTab('ask');
  };

  const handleRenameChatThread = async () => {
    const title = threadName.trim();
    if (!renamingThread || historyLoading || isLoading || chatInFlightRef.current) return;
    if (!title) { message.warning('请输入会话名称。'); return; }
    setHistoryLoading(true);
    try {
      const updated = await renameChatThread(renamingThread.id, title);
      setChatThreads(previous => previous.map(item => item.id === updated.id ? updated : item));
      setRenamingThread(null);
      message.success('会话已重命名。');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重命名失败。');
    } finally {
      setHistoryLoading(false);
    }
  };

  const confirmDeleteChatThread = (thread: ChatThread) => {
    if (historyLoading || isLoading || chatInFlightRef.current) return;
    Modal.confirm({
      title: '删除会话',
      content: `确定删除“${thread.title}”及其全部聊天记录吗？删除后无法恢复，知识库文献会保留。`,
      okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => {
        if (historyLoading || isLoading || chatInFlightRef.current) return Promise.reject();
        setHistoryLoading(true);
        try {
          await deleteChatThread(thread.id);
          setChatThreads(previous => previous.filter(item => item.id !== thread.id));
          if (thread.id === threadId) applyChatThread(null);
          message.success('会话已删除。');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败。');
          throw error;
        } finally {
          setHistoryLoading(false);
        }
      },
    });
  };

  const switchChatThread = async (id: string | null) => {
    if (historyLoading || isLoading || chatInFlightRef.current) return;
    setHistoryLoading(true);
    try {
      const turns = id ? (await getChatThread(id)).turns : [];
      applyChatThread(id, turns);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '无法打开历史对话。');
    } finally {
      setHistoryLoading(false);
    }
  };

  const prepareChatAttachment = async (file: File, addToLibrary: boolean) => {
    if (chatInFlightRef.current || isLoading || historyLoading) return;
    setShowAttachmentChoice(false);
    setPendingAttachmentFile(null);
    setIsLoading(true);
    try {
      const [parsed, uploaded] = await Promise.allSettled([
        parseFileOnly(file),
        addToLibrary ? uploadDocument(file) : Promise.resolve(null),
      ]);
      const inLibrary = uploaded.status === 'fulfilled' && uploaded.value !== null;
      if (parsed.status === 'fulfilled' && parsed.value.text.trim()) {
        setChatAttachment({ filename: parsed.value.filename, text: parsed.value.text, inLibrary });
        message.success(inLibrary ? '已加入知识库，附件也已就绪。' : '附件已就绪，将用于下一条消息。');
      } else {
        message.warning(inLibrary ? '文件已加入知识库，但未能提取文本作为对话附件。'
          : '未能提取附件文本，请检查文件或使用带文字层的 PDF。');
      }
      if (uploaded.status === 'rejected') {
        const reason = uploaded.reason instanceof Error ? uploaded.reason.message : '请稍后重试。';
        message.error(`加入知识库失败：${reason}`);
      }
      if (inLibrary) {
        void getDocuments().then(setDocuments).catch(() => {});
      }
    } finally {
      setIsLoading(false);
    }
  };

  const sendQuestion = async (text: string) => {
    const question = text.trim();
    if (!question || isLoading || historyLoading || chatInFlightRef.current) return;

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
      const id = threadId ?? (await createChatThread()).id;
      setThreadId(id);
      await chatStream(
        question,
        20,
        ragEnabled,
        chunk => {
          setMessages(previous => previous.map(reply =>
            reply.id === replyId ? { ...reply, content: reply.content + chunk } : reply
          ));
        },
        (sources, _tokenUsage, finalAnswer) => {
          const linkedSources = sources.map(source => source.id === 'attachment' && attachment?.basis
            ? { ...source, attachmentBasis: attachment.basis, sourceUrl: attachment.sourceUrl }
            : source);
          setMessages(previous => previous.map(reply =>
            reply.id === replyId ? {
              ...reply, content: finalAnswer ?? reply.content, complete: true,
              verifyingCitations: false, sources: linkedSources,
            } : reply
          ));
          setChatThreads(previous => {
            const thread = previous.find(item => item.id === id)
              ?? { id, title: question.replace(/\s+/g, ' ').slice(0, 60) };
            return [thread, ...previous.filter(item => item.id !== id)];
          });
        },
        attachment?.text,
        attachment?.filename,
        attachment?.basis,
        id,
        attachment?.sourceUrl,
        () => setMessages(previous => previous.map(reply =>
          reply.id === replyId ? { ...reply, verifyingCitations: true } : reply
        )),
        selectedModel ?? undefined,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : '问答请求失败，请稍后重试。';
      setMessages(previous => previous.map(reply =>
        reply.id === replyId
          ? { ...reply, content: reply.content ? `${reply.content}\n\n${detail}` : detail,
              complete: true, verifyingCitations: false }
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

  // Keep the composer compact again after sending or switching conversations.
  useLayoutEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [activeTab, inputValue]);

  const activePdfVersionId = typeof documentView?.version_id === 'string'
    ? documentView.version_id : undefined;
  const visibleAnnotations = annotations.filter(annotation => annotation.kind !== 'note');

  const pushAnnotationHistory = useCallback((entry: AnnotationHistoryEntry) => {
    annotationHistory.current.push(entry);
    if (annotationHistory.current.length > 50) annotationHistory.current.shift();
    setCanUndo(true);
  }, []);

  const undoAnnotation = useCallback(async () => {
    const entry = annotationHistory.current.pop();
    if (!entry) {
      setCanUndo(false);
      return;
    }
    if (!selectedDocument || !activePdfVersionId) {
      setCanUndo(annotationHistory.current.length > 0);
      return;
    }
    try {
      if (entry.type === 'create') {
        await deleteDocumentAnnotation(selectedDocument.id, entry.id);
        setAnnotations(previous => previous.filter(item => item.id !== entry.id));
      } else if (entry.type === 'delete') {
        const restored = await createDocumentAnnotation(selectedDocument.id, activePdfVersionId, {
          page_index: entry.annotation.page_index,
          kind: entry.annotation.kind,
          color: entry.annotation.color,
          rects: entry.annotation.rects,
          quote: entry.annotation.quote,
          note: entry.annotation.note,
        });
        setAnnotations(previous => [...previous, restored]);
      }
    } catch (error) {
      annotationHistory.current.push(entry);
      message.error(error instanceof Error ? error.message : '撤销失败。');
    } finally {
      setCanUndo(annotationHistory.current.length > 0);
    }
  }, [selectedDocument, activePdfVersionId]);

  const removeAnnotation = useCallback(async (id: string) => {
    if (!selectedDocument) return;
    const target = annotations.find(item => item.id === id);
    try {
      await deleteDocumentAnnotation(selectedDocument.id, id);
      setAnnotations(previous => previous.filter(item => item.id !== id));
      if (target) {
        // A delete supersedes earlier undo entries for the same annotation.
        annotationHistory.current = annotationHistory.current.filter(
          entry => !('id' in entry && entry.id === id),
        );
        pushAnnotationHistory({ type: 'delete', annotation: target });
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除标注失败。');
      throw error;
    }
  }, [annotations, selectedDocument, pushAnnotationHistory]);

  useEffect(() => {
    const handleUndoShortcut = (event: KeyboardEvent) => {
      if (!isDrawerOpen) return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      void undoAnnotation();
    };
    window.addEventListener('keydown', handleUndoShortcut);
    return () => window.removeEventListener('keydown', handleUndoShortcut);
  }, [isDrawerOpen, undoAnnotation]);

  const documentStats = {
    total: documents.length,
    searchable: documents.filter(doc => doc.metadata.searchable || doc.metadata.status === 'parsed').length,
    pending: documents.filter(doc => isIngestionPending(doc.metadata.status)).length,
    failed: documents.filter(doc => doc.metadata.status === 'failed' || doc.metadata.status === 'no_text_extracted').length,
  };
  const listedDocuments = filterType === 'recent' ? recentDocuments
    : filterType === 'favorite' ? favoriteDocuments : documents;
  const filteredDocuments = listedDocuments.filter(doc => (
    statusFilter === 'all' ? true
      : statusFilter === 'pending' ? isIngestionPending(doc.metadata.status)
        : statusFilter === 'failed' ? doc.metadata.status === 'failed' || doc.metadata.status === 'no_text_extracted'
          : doc.metadata.status === statusFilter
  ));
  useEffect(() => {
    setDocumentPage(1);
  }, [filterType, statusFilter, documentPageSize]);
  const totalDocumentPages = Math.max(1, Math.ceil(filteredDocuments.length / documentPageSize));
  const currentDocumentPage = Math.min(documentPage, totalDocumentPages);
  const pagedDocuments = filteredDocuments.slice(
    (currentDocumentPage - 1) * documentPageSize,
    currentDocumentPage * documentPageSize,
  );
  const toggleSelectAllDocuments = () => {
    const ids = pagedDocuments.map(doc => doc.id);
    const allSelected = ids.length > 0 && ids.every(id => selectedDocuments.includes(id));
    setSelectedDocuments(previous => allSelected
      ? previous.filter(id => !ids.includes(id))
      : [...new Set([...previous, ...ids])]);
  };

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
            </div>

            {activeTab === 'ask' && (
              <section aria-label="历史对话" className="space-y-2">
                <div className="flex items-center justify-between px-2">
                  <h2 className="text-xs font-semibold text-gray-500 dark:text-slate-400">历史对话</h2>
                  <button type="button" disabled={isLoading || historyLoading} onClick={() => void switchChatThread(null)}
                    className="rounded px-2 py-1 text-xs font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-50">
                    ＋ 新会话
                  </button>
                </div>
                {chatThreads.map(thread => (
                  <div key={thread.id} className="flex items-center gap-0.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800">
                    <button type="button" title={thread.title}
                      aria-current={thread.id === threadId ? 'true' : undefined}
                      disabled={isLoading || historyLoading}
                      onClick={() => void switchChatThread(thread.id)}
                      className="min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-xs aria-current:bg-brand-100 dark:aria-current:bg-slate-800 disabled:opacity-50">
                      {thread.title}
                    </button>
                    <button type="button" aria-label={`重命名会话 ${thread.title}`} title="重命名会话"
                      disabled={isLoading || historyLoading}
                      className="shrink-0 rounded p-1.5 text-gray-500 hover:text-brand-600 disabled:opacity-50"
                      onClick={() => { setRenamingThread(thread); setThreadName(thread.title); }}>
                      <Icon icon="solar:pen-linear" />
                    </button>
                    <button type="button" aria-label={`删除会话 ${thread.title}`} title="删除会话"
                      disabled={isLoading || historyLoading}
                      className="shrink-0 rounded p-1.5 text-gray-500 hover:text-red-600 disabled:opacity-50"
                      onClick={() => confirmDeleteChatThread(thread)}>
                      <Icon icon="solar:trash-bin-trash-linear" />
                    </button>
                  </div>
                ))}
                <Modal title="重命名会话" open={renamingThread !== null}
                  okText="保存" cancelText="取消" confirmLoading={historyLoading}
                  onOk={() => void handleRenameChatThread()}
                  onCancel={() => { if (!historyLoading) setRenamingThread(null); }}
                  closable={!historyLoading} maskClosable={!historyLoading} keyboard={!historyLoading}
                  destroyOnHidden>
                  <Input autoFocus aria-label="会话名称" placeholder="请输入会话名称"
                    value={threadName} maxLength={100} showCount disabled={historyLoading}
                    onChange={event => setThreadName(event.target.value)}
                    onPressEnter={() => void handleRenameChatThread()} />
                </Modal>
              </section>
            )}

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
                    <h2 className="text-3xl font-bold">你好，我是你的文献助手</h2>
                    <p className="max-w-md text-gray-500" aria-live="polite">
                      {indexCountUnavailable ? '暂时无法读取索引数量。'
                        : indexedDocuments === null ? '正在读取索引状态…'
                        : indexedDocuments.length === 0 ? '已索引 0 篇文献。请先到知识库导入文献。'
                        : `已索引 ${indexedDocuments.length.toLocaleString('zh-CN')} 篇文献。可以按主题找论文、比较研究方法或追查原文。`}
                    </p>
                    <div className="mt-6 grid w-full max-w-lg grid-cols-1 gap-3 text-left sm:grid-cols-2">
                      {recommendedQuestions.map((question) => (
                        <button
                          key={question.title}
                          type="button"
                          disabled={historyLoading || indexCountUnavailable || !indexedDocuments?.length || question.disabled}
                          className="rounded-xl border border-gray-200 p-3 text-left transition-colors enabled:hover:bg-brand-50 disabled:opacity-50 dark:border-slate-800 dark:enabled:hover:bg-brand-900/20"
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
                    <div key={index} className={`mx-auto flex w-full max-w-4xl space-x-4 ${message.role === 'user' ? 'justify-end' : ''}`}>
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
                                <ReactMarkdown remarkPlugins={[remarkGfm, [remarkCitationLinks,
                                  new Set(message.sources?.flatMap(source => source.citation_number === undefined ? [] : [source.citation_number])),
                                  message.complete === false,
                                ]]} components={{
                                  a: ({ href, children }) => {
                                    const number = citationNumberFromHref(href);
                                    if (number === undefined) return <a href={href}>{children}</a>;
                                    const source = message.sources?.find(item => item.citation_number === number);
                                    if (!source) return null;
                                    const location = source.page_index === undefined ? '' : ` · 第 ${source.page_index + 1} 页`;
                                    return <a href={`#evidence-${number}`} className="citation-badge"
                                      aria-label={`查看引用 ${number}`}
                                      title={`${source.filename}${location}`}
                                      onClick={event => {
                                        event.preventDefault();
                                        setReferenceFile({
                                          id: source.id, filename: source.filename, versionId: source.version_id,
                                          selectionId: ++citationSelection.current, sources: [source],
                                        });
                                      }}>{number}</a>;
                                  },
                                }}>
                                  {message.complete === false ? formatStreamingMarkdown(presentAnswer(message.content))
                                    : presentAnswer(message.content) || '可以指定想看的章节、实验或指标，我再帮你查阅。'}
                                </ReactMarkdown>
                              )}
                              {message.verifyingCitations && (
                                <p role="status" className="text-xs text-slate-500 dark:text-slate-400">正在核验原文引用…</p>
                              )}
                            </div>
                          ) : (
                            message.content
                          )}
                        </div>
                        {message.role === 'assistant' && !!message.sources?.length && (
                          <ReferenceSources sources={message.sources} answer={message.content}
                            onSelect={file => setReferenceFile({ ...file, selectionId: ++citationSelection.current })} />
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
                  <div className="mx-auto flex w-full max-w-4xl space-x-4">
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
              <div className={`shrink-0 px-3 pb-3 pt-2 sm:px-5 sm:pb-4 ${referenceFile ? "lg:px-6" : "lg:px-12"}`}>
                <div className="relative mx-auto max-w-4xl">
                  {/* 快捷指令预览 */}
                  <div className={`absolute bottom-full left-0 mb-2 w-64 max-w-full bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-gray-200 dark:border-slate-700 p-2 z-50 ${showCommandHint ? '' : 'hidden'}`} id="command-hint">
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

                  <div className="rounded-[22px] border border-slate-200 bg-white p-2 shadow-sm transition-colors focus-within:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:focus-within:border-slate-500">
                    {chatAttachment && (
                      <div className="mx-2 mb-1 mt-1 flex w-fit max-w-[calc(100%-1rem)] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800">
                        <Icon icon="solar:document-text-linear" className="shrink-0 text-base text-slate-500" aria-hidden="true" />
                        <span className="min-w-0 truncate" title={chatAttachment.filename}>{chatAttachment.filename}</span>
                        {chatAttachment.inLibrary && <span className="hidden shrink-0 text-slate-500 sm:inline dark:text-slate-400">已入库</span>}
                        {chatAttachment.sourceUrl && <a href={chatAttachment.sourceUrl} target="_blank" rel="noreferrer"
                          className="shrink-0 text-brand-600 underline dark:text-brand-400">来源</a>}
                        <button type="button" aria-label="移除附件" onClick={() => setChatAttachment(null)}
                          className="shrink-0 rounded px-1 text-base leading-none text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-white">
                          ×
                        </button>
                      </div>
                    )}
                    <textarea
                      ref={textareaRef}
                      aria-label="输入消息"
                      className="block max-h-32 min-h-11 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-500 dark:text-slate-100 dark:placeholder:text-slate-400"
                      value={inputValue}
                      onChange={handleInputChange}
                      onKeyDown={handleInputKeyDown}
                      placeholder="输入你的问题"
                      rows={1}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1 pt-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <Tooltip title="添加附件" trigger={['hover', 'focus']}>
                          <button type="button" aria-label="添加附件" disabled={isLoading || historyLoading}
                            className="grid size-8 shrink-0 place-items-center rounded-full text-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
                            onClick={() => {
                              const fileInput = document.createElement('input');
                              fileInput.type = 'file';
                              fileInput.accept = '.pdf,.doc,.docx,.txt,.md';
                              fileInput.onchange = () => {
                                const file = fileInput.files?.[0];
                                if (file) {
                                  setPendingAttachmentFile(file);
                                  setShowAttachmentChoice(true);
                                }
                              };
                              fileInput.click();
                            }}>
                            <Icon icon="solar:paperclip-line-duotone" aria-hidden="true" />
                          </button>
                        </Tooltip>
                        <Tooltip title="联网找论文" trigger={['hover', 'focus']}>
                          <button type="button" aria-label="联网找论文" disabled={isLoading}
                            className="grid size-8 shrink-0 place-items-center rounded-full text-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
                            onClick={() => setOnlinePaperSearchOpen(true)}>
                            <Icon icon="solar:global-line-duotone" aria-hidden="true" />
                          </button>
                        </Tooltip>
                      </div>
                      <div className="ml-auto flex min-w-0 items-center gap-1.5">
                        <Select
                          size="small"
                          variant="borderless"
                          value={selectedModel ?? undefined}
                          onChange={value => {
                            const target = models.find(item => item.id === value);
                            if (!target?.configured) {
                              message.warning(`${target?.label ?? '该模型'}尚未配置，请先设置对应的 API 密钥或启动本地服务。`);
                              return;
                            }
                            setSelectedModel(value);
                            try { window.localStorage.setItem('rag-answer-model', value); } catch { /* ignore */ }
                          }}
                          options={models.map(model => ({
                            value: model.id,
                            label: `${model.label}${model.configured ? '' : '（需配置）'}`,
                          }))}
                          placeholder={modelsLoading ? '加载模型…' : '选择模型'}
                          notFoundContent={modelsLoading ? '加载中…' : '暂无模型'}
                          loading={modelsLoading}
                          popupMatchSelectWidth={false}
                          style={{ minWidth: 120, maxWidth: 190 }}
                          title="回答模型；路由与引用核验使用默认模型"
                        />
                        <Tooltip title={ragEnabled ? '关闭知识库检索' : '开启知识库检索'} trigger={['hover', 'focus']}>
                          <button type="button" aria-label="知识库检索" aria-pressed={ragEnabled}
                            className={`flex h-8 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium transition-colors ${ragEnabled
                              ? 'border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700'
                              : 'border-transparent text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}
                            onClick={() => setRagEnabled(value => !value)}>
                            <Icon icon="solar:database-linear" className="text-sm" aria-hidden="true" />
                            <span>RAG</span>
                          </button>
                        </Tooltip>
                        <button type="button" aria-label="发送消息" title="发送消息"
                          className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-900 text-xl font-semibold leading-none text-white transition-colors hover:bg-slate-700 disabled:bg-slate-100 disabled:text-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 dark:disabled:bg-slate-800 dark:disabled:text-slate-500"
                          disabled={isLoading || historyLoading || !inputValue.trim()}
                          onClick={() => void sendQuestion(inputValue)}>
                          <span aria-hidden="true">↑</span>
                        </button>
                      </div>
                    </div>
                  </div>

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
                            onClick={() => void prepareChatAttachment(pendingAttachmentFile, true)}
                          >
                            <Icon icon="solar:database-bold-duotone" className="text-2xl text-brand-600" />
                            <div className="text-left">
                              <p className="text-sm font-semibold text-brand-700">加入知识库</p>
                              <p className="text-xs text-gray-500">保存到知识库，同时作为附件随下一条消息发送</p>
                            </div>
                          </button>
                          <button
                            className="w-full flex items-center space-x-3 p-3 border-2 border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-400 transition-all"
                            onClick={() => void prepareChatAttachment(pendingAttachmentFile, false)}
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
                <div className="flex items-center gap-4">
                  <div className="hidden items-center gap-3 text-xs text-gray-500 md:flex dark:text-slate-400">
                    <span>共 <b className="text-sm text-slate-800 dark:text-slate-100">{documentStats.total}</b> 篇</span>
                    <span>可检索 <b className="text-sm text-emerald-600">{documentStats.searchable}</b></span>
                    {documentStats.pending > 0 && (
                      <span>处理中 <b className="text-sm text-blue-600">{documentStats.pending}</b></span>
                    )}
                    {documentStats.failed > 0 && (
                      <span>失败 <b className="text-sm text-red-600">{documentStats.failed}</b></span>
                    )}
                  </div>
                  <button
                    className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-brand-700"
                    onClick={() => {
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                        fileInputRef.current.click();
                      }
                    }}
                  >
                    <Icon icon="solar:upload-bold" />
                    <span>上传文献</span>
                  </button>
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
                <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start">
                  {/* 文件夹管理 */}
                  <aside className="h-fit rounded-xl border border-gray-200 bg-white p-3 shadow-md md:p-4 lg:sticky lg:top-0 dark:border-slate-700 dark:bg-slate-800">
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
                  </aside>

                  {/* 文件管理 */}
                  <div className="bg-white dark:bg-slate-800 rounded-xl shadow-md border border-gray-200 dark:border-slate-700 p-3 md:p-4">
                    <PaperDiscovery folderId={selectedFolder || undefined}
                      onOpen={async id => {
                        const available = await getDocuments();
                        const doc = available.find(item => item.id === id);
                        if (!doc) throw new Error('文献已移出当前知识库，请重新查找');
                        await openDocumentInViewer(doc);
                      }}
                      onPreview={source => {
                        setReferenceFile({ id: source.id, filename: source.filename,
                          versionId: source.version_id, sources: [source], selectionId: ++citationSelection.current });
                        setActiveTab('ask');
                      }} />
                    <div className="mb-3 flex flex-col gap-2">
                      <h4 className="flex items-center space-x-2 text-sm font-bold">
                        <Icon icon="solar:file-text-bold-duotone" className="text-brand-600" />
                        <span>文献</span>
                        <span className="text-xs font-normal text-gray-400">{filteredDocuments.length} 篇</span>
                      </h4>
                      <div className="flex flex-wrap items-center gap-2">
                        {/* 搜索框 */}
                        <div className="relative w-full sm:w-56">
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
                        {/* 入库状态筛选 */}
                        <select
                          value={statusFilter}
                          onChange={(event) => setStatusFilter(event.target.value)}
                          className="px-2 py-1 bg-gray-100 dark:bg-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                        >
                          <option value="all">全部状态</option>
                          <option value="parsed">可检索</option>
                          <option value="pending">处理中</option>
                          <option value="failed">失败/无文本</option>
                        </select>
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
                            <option value="uploaded_at">上传时间</option>
                            <option value="year">出版年份</option>
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
                        {/* 自动补全元数据 */}
                        <button
                          type="button"
                          onClick={() => void runMetadataEnrichment(selectedDocuments.length > 0 ? selectedDocuments : undefined)}
                          disabled={metadataEnriching}
                          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-brand-400 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-brand-500"
                          title="从 PDF、Crossref、OpenAlex 补全作者、年份、来源和 DOI"
                        >
                          <Icon icon={metadataEnriching ? 'solar:refresh-bold' : 'solar:magic-stick-3-bold'} className={metadataEnriching ? 'animate-spin' : ''} />
                          <span className="hidden sm:inline">{metadataEnriching ? '补全中…' : '补全元数据'}</span>
                        </button>
                        {/* 视图切换 */}
                        <div className="flex items-center rounded-lg bg-gray-100 p-0.5 dark:bg-slate-800">
                          <button
                            type="button"
                            onClick={() => setIsGridView(false)}
                            title="表格视图"
                            className={`rounded-md p-1.5 transition-colors ${!isGridView ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-700' : 'text-gray-500 hover:text-gray-700 dark:text-slate-400'}`}
                          >
                            <Icon icon="solar:list-bold" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsGridView(true)}
                            title="卡片视图"
                            className={`rounded-md p-1.5 transition-colors ${isGridView ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-700' : 'text-gray-500 hover:text-gray-700 dark:text-slate-400'}`}
                          >
                            <Icon icon="solar:widget-4-bold" />
                          </button>
                        </div>
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
                      className={`mt-3 mb-3 rounded-xl border-2 border-dashed px-4 py-4 transition-all ${isDragging ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-gray-300 hover:border-brand-400 dark:border-slate-700'}`}
                      onDragEnter={handleDragEnter}
                      onDragLeave={handleDragLeave}
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                    >
                      <div className="flex flex-col items-center justify-center gap-1 text-center sm:flex-row sm:gap-3">
                        <Icon icon="solar:upload-cloud-bold" className="text-2xl text-gray-400" />
                        <p className="text-sm text-gray-600 dark:text-slate-300">拖拽文件到此处上传</p>
                        <p className="text-xs text-gray-400">支持 .txt / .md / .pdf / .doc / .docx，单文件最大 20MB</p>
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

                    {/* 文献列表 */}
                    <div className="mt-4">
                      {filteredDocuments.length === 0 ? (
                        <div className="py-10 text-center">
                          <Icon icon={filterType === 'recent' ? 'solar:clock-bold' : filterType === 'favorite' ? 'solar:heart-bold' : 'solar:file-search-bold'} className="mx-auto mb-3 text-4xl text-gray-400" />
                          <p className="text-gray-500">
                            {filterType === 'recent' ? '最近没有使用过文件' :
                              filterType === 'favorite' ? '还没有收藏任何文献' :
                                statusFilter !== 'all' ? '没有符合当前筛选条件的文献' :
                                  '该文件夹中没有文献'}
                          </p>
                        </div>
                      ) : isGridView ? (
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                          {pagedDocuments.map(doc => (
                            <div
                              key={doc.id}
                              className={`cursor-pointer rounded-xl border border-gray-200 bg-gray-50 p-4 transition-all hover:shadow-md dark:border-slate-700 dark:bg-slate-800 ${selectedDocuments.includes(doc.id) ? 'ring-2 ring-brand-500' : ''}`}
                              onClick={() => openDocumentInViewer(doc)}
                            >
                              <div className="flex items-start gap-3">
                                <input
                                  type="checkbox"
                                  className="mt-1 h-4 w-4 cursor-pointer accent-blue-600"
                                  checked={selectedDocuments.includes(doc.id)}
                                  onClick={event => event.stopPropagation()}
                                  onChange={() => toggleDocumentSelection(doc.id)}
                                  aria-label={`选择文献 ${doc.metadata.filename}`}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <h5 className="truncate text-sm font-medium">{documentTitle(doc)}</h5>
                                      <p className="truncate text-xs text-gray-400">{doc.metadata.filename}</p>
                                    </div>
                                    <div className="flex items-center gap-0.5">
                                      <button
                                        className="rounded-full p-1 transition-colors hover:bg-gray-200 dark:hover:bg-slate-700"
                                        onClick={event => { event.stopPropagation(); void toggleFavoriteDocument(doc); }}
                                        title={doc.metadata.is_favorite ? '取消收藏' : '收藏'}
                                      >
                                        <Icon
                                          icon={doc.metadata.is_favorite ? 'solar:heart-bold' : 'solar:heart-linear'}
                                          className={doc.metadata.is_favorite ? 'text-red-500' : 'text-gray-400 dark:text-slate-500'}
                                        />
                                      </button>
                                      <button
                                        className="rounded-full p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                                        onClick={event => { event.stopPropagation(); handleDeleteDocument(doc); }}
                                        title="删除文献"
                                      >
                                        <Icon icon="solar:trash-bin-trash-bold" />
                                      </button>
                                    </div>
                                  </div>
                                  <div className="mt-2 space-y-1 text-xs text-gray-500 dark:text-slate-400">
                                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                                      <span className="truncate">{documentAuthors(doc)}</span>
                                      {documentYear(doc) !== '—' && <span>· {documentYear(doc)}</span>}
                                      {documentVenue(doc) !== '—' && <span className="truncate">· {documentVenue(doc)}</span>}
                                    </div>
                                    <div>{formatFileSize(doc.metadata.size)} · {(doc.metadata.file_type as string) || ''} · {formatDay(doc.metadata.uploaded_at)}</div>
                                    <IngestionStatus
                                      metadata={doc.metadata}
                                      onRetry={() => retryIngestion(doc.id)}
                                      onReplace={() => showReplaceDialog(doc.id)}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-slate-700">
                          <table className="w-full min-w-[800px] table-fixed border-collapse text-left text-sm">
                            <colgroup>
                              <col style={{ width: '34px' }} />
                              <col />
                              <col style={{ width: '80px' }} />
                              <col style={{ width: '56px' }} />
                              <col style={{ width: '92px' }} />
                              <col style={{ width: '84px' }} />
                              <col style={{ width: '80px' }} />
                              <col style={{ width: '88px' }} />
                              <col style={{ width: '116px' }} />
                            </colgroup>
                            <thead className="bg-gray-50 text-xs text-gray-500 dark:bg-slate-900/60 dark:text-slate-400">
                              <tr>
                                <th className="w-10 px-3 py-2.5">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 cursor-pointer accent-blue-600"
                                    checked={pagedDocuments.length > 0 && pagedDocuments.every(doc => selectedDocuments.includes(doc.id))}
                                    onChange={toggleSelectAllDocuments}
                                    aria-label="全选当前页文献"
                                  />
                                </th>
                                <th className="px-3 py-2.5 font-medium">文献</th>
                                <th className="px-3 py-2.5 font-medium">作者</th>
                                <th className="w-20 px-3 py-2.5 font-medium">年份</th>
                                <th className="px-3 py-2.5 font-medium">来源</th>
                                <th className="px-3 py-2.5 font-medium">专题</th>
                                <th className="px-3 py-2.5 font-medium">状态</th>
                                <th className="px-3 py-2.5 font-medium">上传时间</th>
                                <th className="px-3 py-2.5 text-right font-medium">操作</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                              {pagedDocuments.map(doc => {
                                const status = doc.metadata.status || '';
                                const tags = documentTags(doc);
                                const doi = documentDoi(doc);
                                const errorMessage = typeof doc.metadata.error_message === 'string' ? doc.metadata.error_message : undefined;
                                return (
                                  <tr
                                    key={doc.id}
                                    className={`cursor-pointer transition-colors hover:bg-brand-50/50 dark:hover:bg-slate-800/60 ${selectedDocuments.includes(doc.id) ? 'bg-brand-50 dark:bg-brand-900/20' : ''}`}
                                    onClick={() => openDocumentInViewer(doc)}
                                  >
                                    <td className="px-3 py-3" onClick={event => event.stopPropagation()}>
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 cursor-pointer accent-blue-600"
                                        checked={selectedDocuments.includes(doc.id)}
                                        onChange={() => toggleDocumentSelection(doc.id)}
                                        aria-label={`选择文献 ${doc.metadata.filename}`}
                                      />
                                    </td>
                                    <td className="px-3 py-3">
                                      <div className="max-w-[320px]">
                                        <p className="truncate font-medium text-slate-800 dark:text-slate-100" title={documentTitle(doc)}>{documentTitle(doc)}</p>
                                        <p className="truncate text-xs text-gray-400">{doc.metadata.filename}</p>
                                        {tags.length > 0 && (
                                          <div className="mt-1 flex flex-wrap gap-1">
                                            {tags.slice(0, 3).map(tag => (
                                              <span key={tag} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-slate-700 dark:text-slate-300">{tag}</span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                    <td className="max-w-[140px] truncate px-3 py-3 text-gray-600 dark:text-slate-300" title={documentAuthors(doc)}>{documentAuthors(doc)}</td>
                                    <td className="px-3 py-3 text-gray-600 dark:text-slate-300">{documentYear(doc)}</td>
                                    <td className="px-3 py-3">
                                      <div className="max-w-[180px]">
                                        <p className="truncate text-gray-600 dark:text-slate-300" title={documentVenue(doc)}>{documentVenue(doc)}</p>
                                        {doi && (
                                          <a
                                            href={`https://doi.org/${doi}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            onClick={event => event.stopPropagation()}
                                            className="block truncate text-[11px] text-gray-400 hover:text-brand-600"
                                            title={doi}
                                          >
                                            {doi}
                                          </a>
                                        )}
                                      </div>
                                    </td>
                                    <td className="truncate px-3 py-3 text-gray-600 dark:text-slate-300" title={documentFolder(doc)}>{documentFolder(doc)}</td>
                                    <td className="px-3 py-3">
                                      <span
                                        className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${ingestionStyles[status] || 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300'}`}
                                        title={errorMessage || ''}
                                      >
                                        {ingestionLabels[status] || status || '未知'}
                                      </span>
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-3 text-gray-500 dark:text-slate-400">{formatDay(doc.metadata.uploaded_at)}</td>
                                    <td className="px-3 py-3" onClick={event => event.stopPropagation()}>
                                      <div className="flex items-center justify-end gap-1">
                                        <button
                                          type="button"
                                          title={doc.metadata.is_favorite ? '取消收藏' : '收藏'}
                                          onClick={() => void toggleFavoriteDocument(doc)}
                                          className={`rounded p-1.5 transition-colors hover:bg-gray-100 dark:hover:bg-slate-700 ${doc.metadata.is_favorite ? 'text-red-500' : 'text-gray-500 hover:text-brand-600'}`}
                                        >
                                          <Icon icon={doc.metadata.is_favorite ? 'solar:heart-bold' : 'solar:heart-linear'} />
                                        </button>
                                        <button
                                          type="button"
                                          title="删除文献"
                                          onClick={() => handleDeleteDocument(doc)}
                                          className="rounded p-1.5 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                                        >
                                          <Icon icon="solar:trash-bin-trash-bold" />
                                        </button>
                                        <Dropdown
                                          trigger={['click']}
                                          menu={{
                                            items: [
                                              { key: 'metadata', label: '编辑元数据' },
                                              { key: 'enrich', label: '重新识别元数据' },
                                              ...(status === 'failed' || status === 'no_text_extracted'
                                                ? [{ key: 'retry', label: '重试入库' }] : []),
                                              { key: 'replace', label: '替换文件' },
                                            ],
                                            onClick: ({ key, domEvent }) => {
                                              domEvent?.stopPropagation();
                                              if (key === 'metadata') openMetadataEditor(doc);
                                              else if (key === 'enrich') void runMetadataEnrichment([doc.id], true);
                                              else if (key === 'retry') void retryIngestion(doc.id);
                                              else if (key === 'replace') showReplaceDialog(doc.id);
                                            },
                                          }}
                                        >
                                          <button
                                            type="button"
                                            title="更多操作"
                                            className="rounded p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-brand-600 dark:hover:bg-slate-700"
                                          >
                                            <Icon icon="solar:menu-dots-bold" />
                                          </button>
                                        </Dropdown>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* 分页 */}
                      <div className="mt-3 flex flex-col gap-2 border-t border-gray-100 pt-3 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:text-slate-400">
                        <span>
                          共 {filteredDocuments.length} 篇 · 第 {currentDocumentPage}/{totalDocumentPages} 页
                          {selectedDocuments.length > 0 ? ` · 已选 ${selectedDocuments.length} 篇` : ''}
                        </span>
                        <div className="flex items-center gap-2">
                          <select
                            value={documentPageSize}
                            onChange={event => { setDocumentPageSize(Number(event.target.value)); setDocumentPage(1); }}
                            className="rounded-lg bg-gray-100 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 dark:bg-slate-800"
                          >
                            <option value={10}>10 条/页</option>
                            <option value={20}>20 条/页</option>
                            <option value={50}>50 条/页</option>
                          </select>
                          <button
                            type="button"
                            disabled={currentDocumentPage <= 1}
                            onClick={() => setDocumentPage(currentDocumentPage - 1)}
                            className="rounded-lg bg-gray-100 px-2.5 py-1 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-800 dark:hover:bg-slate-700"
                          >
                            上一页
                          </button>
                          <button
                            type="button"
                            disabled={currentDocumentPage >= totalDocumentPages}
                            onClick={() => setDocumentPage(currentDocumentPage + 1)}
                            className="rounded-lg bg-gray-100 px-2.5 py-1 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-800 dark:hover:bg-slate-700"
                          >
                            下一页
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
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
                className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                onClick={() => void undoAnnotation()}
                disabled={!canUndo}
                title="撤销上一次标注操作 (Ctrl+Z)"
              >
                <Icon icon="solar:undo-left-bold" />
                <span className="hidden sm:inline">撤销</span>
              </button>
              <button
                className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                onClick={() => setIsDirectoryCollapsed(value => !value)}
                title={isDirectoryCollapsed ? '展开文档目录' : '收起文档目录'}
              >
                <Icon icon={isDirectoryCollapsed ? 'solar:alt-arrow-right-bold' : 'solar:alt-arrow-left-bold'} />
                <span className="hidden sm:inline">{isDirectoryCollapsed ? '展开目录' : '收起目录'}</span>
              </button>
              <button
                className="px-3 py-1.5 bg-brand-600 text-white rounded-lg text-xs font-bold flex items-center space-x-1 transition-all hover:shadow-md hover:bg-brand-700"
                onClick={() => {
                  setViewerPanel('summary');
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
            {!isDirectoryCollapsed && (
              <div className="w-64 border-r border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900 overflow-y-auto">
                <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-800">
                  <h5 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">文档目录</h5>
                  <button
                    className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    onClick={() => setIsDirectoryCollapsed(true)}
                    title="收起文档目录"
                  >
                    <Icon icon="solar:alt-arrow-left-bold" />
                  </button>
                </div>
              <div className="p-2">
                {documentView?.view_type === 'pdf' ? (
                  pdfNavigation ? (
                    <nav className="space-y-1" aria-label={hasOutline ? 'PDF 章节目录' : 'PDF 页码导航'}>
                      {!hasOutline && <p className="px-3 py-2 text-xs text-gray-500">未识别到章节标题，按页码浏览。</p>}
                      {pdfDirectory.map((item, index) => (
                        <button key={index} type="button"
                          className="w-full break-words rounded-lg px-3 py-2 text-left text-sm leading-5 line-clamp-2 hover:bg-gray-200 dark:hover:bg-slate-800"
                          style={{ paddingLeft: Math.min(item.level, 5) * 12 + 12 }}
                          title={`${item.title} · 跳到第 ${item.pageIndex + 1} 页`}
                          onClick={() => setPdfPageJump({
                            pageIndex: item.pageIndex,
                            title: item.title,
                            destination: 'destination' in item ? item.destination : undefined,
                          })}>
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
            )}

            {isDirectoryCollapsed && (
              <div className="flex w-9 shrink-0 flex-col items-center border-r border-gray-200 bg-gray-50 py-3 dark:border-slate-800 dark:bg-slate-900">
                <button
                  className="rounded p-1.5 text-gray-500 transition-colors hover:bg-gray-200 hover:text-brand-600 dark:hover:bg-slate-800"
                  onClick={() => setIsDirectoryCollapsed(false)}
                  title="展开文档目录"
                >
                  <Icon icon="solar:alt-arrow-right-bold" />
                </button>
                <span className="mt-3 text-[10px] tracking-[0.3em] text-gray-400 [writing-mode:vertical-rl]">目录</span>
              </div>
            )}

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
                          <PdfReferencePreview key={selectedDocument.id}
                            url={getDocumentFileUrl(selectedDocument.id, activePdfVersionId)}
                            sources={viewerPanel === 'sections' || viewerPanel === 'profile' ? sectionEvidence : noPdfSources}
                            selectionId={sectionSelectionId} onError={handlePdfPreviewError}
                            onNavigation={setPdfNavigation} pageJump={pdfPageJump}
                            annotations={visibleAnnotations}
                            onCreateAnnotation={activePdfVersionId ? async draft => {
                              if (!activePdfVersionId) return;
                              const versionId = activePdfVersionId;
                              try {
                                const created = await createDocumentAnnotation(selectedDocument.id, versionId, draft);
                                setAnnotations(previous => [...previous, created]);
                                pushAnnotationHistory({ type: 'create', id: created.id });
                              } catch (error) {
                                message.error(error instanceof Error ? error.message : '保存标注失败。');
                                throw error;
                              }
                            } : undefined} />
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
              <div className="border-b border-gray-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-1">
                  {documentView?.view_type === 'pdf' && activePdfVersionId && (
                    <button type="button" onClick={() => setViewerPanel('profile')}
                      className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${viewerPanel === 'profile'
                        ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                        : 'text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}>
                      文献卡片
                    </button>
                  )}
                  {documentView?.view_type === 'pdf' && activePdfVersionId && (
                    <button type="button" onClick={() => setViewerPanel('sections')}
                      className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${viewerPanel === 'sections'
                        ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                        : 'text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}>
                      章节原文
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setViewerPanel('summary')}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${viewerPanel === 'summary'
                      ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                      : 'text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}
                  >
                    智能总结
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewerPanel('annotations')}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${viewerPanel === 'annotations'
                      ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                      : 'text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}
                  >
                    标注{visibleAnnotations.length > 0 ? ` (${visibleAnnotations.length})` : ''}
                  </button>
                </div>
                {pdfNavigation && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">PDF 原文 · 共 {pdfNavigation.totalPages} 页</p>}
              </div>
              <div className="p-4">
                {viewerPanel === 'profile' && activePdfVersionId ? (
                  <PaperProfile key={selectedDocument.id + activePdfVersionId}
                    documentId={selectedDocument.id} versionId={activePdfVersionId}
                    onSelectPassage={selectSectionPassage} />
                ) : viewerPanel === 'sections' && activePdfVersionId ? (
                  <SectionReader key={selectedDocument.id + activePdfVersionId}
                    documentId={selectedDocument.id} versionId={activePdfVersionId}
                    onSelectPassage={selectSectionPassage} />
                ) : viewerPanel === 'annotations' ? (
                  visibleAnnotations.length === 0 ? (
                    <p className="text-sm text-gray-500">还没有标注。选中文字后使用高亮或下划线。</p>
                  ) : (
                    <div className="space-y-2">
                      {visibleAnnotations.map(annotation => (
                        <div key={annotation.id} data-annotation-id={annotation.id} className="rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-slate-700 dark:bg-slate-800">
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => setPdfPageJump({ pageIndex: annotation.page_index })}
                              className="font-medium text-brand-600 hover:underline"
                            >
                              {annotation.kind === 'highlight' ? '高亮' : '下划线'} · 第 {annotation.page_index + 1} 页
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeAnnotation(annotation.id)}
                              title="删除标注"
                              className="rounded p-1 text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                            >
                              <Icon icon="solar:trash-bin-trash-bold" />
                            </button>
                          </div>
                          {annotation.quote && (
                            <p className="mt-1 line-clamp-3 text-gray-500 dark:text-slate-400" title={annotation.quote}>“{annotation.quote}”</p>
                          )}
                          {annotation.note && (
                            <p className="mt-1 whitespace-pre-wrap text-gray-700 dark:text-slate-300">{annotation.note}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                ) : summaryLoading ? (
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

      {/* 编辑文献元数据对话框 */}
      <Modal
        title="编辑文献元数据"
        open={isMetadataModalOpen}
        onOk={() => void handleMetadataSubmit()}
        confirmLoading={metadataSaving}
        onCancel={() => setIsMetadataModalOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">标题</span>
            <Input
              value={metadataForm.title}
              onChange={event => setMetadataForm(form => ({ ...form, title: event.target.value }))}
              placeholder="文献标题"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">作者</span>
            <Input
              value={metadataForm.authors}
              onChange={event => setMetadataForm(form => ({ ...form, authors: event.target.value }))}
              placeholder="张三、李四"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">出版年份</span>
              <Input
                value={metadataForm.year}
                inputMode="numeric"
                onChange={event => setMetadataForm(form => ({ ...form, year: event.target.value }))}
                placeholder="2024"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">期刊 / 会议</span>
              <Input
                value={metadataForm.venue}
                onChange={event => setMetadataForm(form => ({ ...form, venue: event.target.value }))}
                placeholder="Nature"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">DOI</span>
            <Input
              value={metadataForm.doi}
              onChange={event => setMetadataForm(form => ({ ...form, doi: event.target.value }))}
              placeholder="10.1000/xxxxx"
            />
          </label>
        </div>
        <p className="mt-3 text-xs text-gray-400">作者可用顿号、逗号或分号分隔。保存后标记为手动编辑，自动补全不会覆盖这些字段。</p>
      </Modal>


    </div>
  );
}

export default App;
