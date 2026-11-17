import { useEffect, useRef, useState } from 'react';
import { discoverPapers } from '../services/api';
import type { PaperSearchResult, Source } from '../services/api';

const labels: Record<string, string> = {
  body_lexical: '正文关键词', body_vector: '正文语义',
  profile_lexical: '阅读要点关键词', profile_vector: '阅读要点语义',
};

export default function PaperDiscovery({ folderId, onOpen, onPreview }: {
  folderId?: string;
  onOpen: (id: string) => Promise<void>;
  onPreview: (source: Source) => void;
}) {
  const [query, setQuery] = useState('');
  const [wholeLibrary, setWholeLibrary] = useState(false);
  const [result, setResult] = useState<PaperSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setResult(null); setBusy(false); setError('');
    return () => request.current?.abort();
  }, [folderId, wholeLibrary]);

  async function search() {
    if (!query.trim()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await discoverPapers(query.trim(), wholeLibrary ? undefined : folderId, controller.signal);
      if (!controller.signal.aborted) setResult(response);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '查找文献失败');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <details className="mb-4 rounded-xl border border-gray-200 p-3 dark:border-slate-700">
    <summary className="cursor-pointer text-sm font-semibold text-gray-800 dark:text-gray-100">按内容找文献</summary>
    <form onSubmit={event => { event.preventDefault(); void search(); }} className="mt-3 space-y-3">
      <p className="text-xs leading-5 text-gray-500">记得方法、研究对象或大概内容即可。候选结合正文和已生成的阅读要点，需核对原文。</p>
      <div className="flex gap-2">
        <input aria-label="文献内容线索" value={query} onChange={event => setQuery(event.target.value)} maxLength={4000}
          placeholder="例如：多个评审角色先独立打分，再讨论分歧"
          className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-sm dark:border-slate-600" />
        <button type="submit" disabled={busy || !query.trim()} className="rounded-lg bg-brand-600 px-3 text-sm text-white disabled:opacity-50">
          {busy ? '查找中…' : '查找'}
        </button>
      </div>
      {folderId && <label className="flex items-center gap-2 text-xs text-gray-500">
        <input type="checkbox" checked={wholeLibrary} onChange={event => setWholeLibrary(event.target.checked)} />搜索整个知识库
      </label>}
    </form>
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    {result && <div className="mt-4 space-y-4" aria-label="文献发现结果">
      {result.warnings.map(warning => <p key={warning} className="text-xs text-amber-700">{warning}</p>)}
      {!result.papers.length && <p className="text-sm text-gray-500">本轮未找到符合这些线索的候选，可换个研究对象或补充细节。</p>}
      {result.papers.map(paper => <article key={paper.document_id} className="space-y-2 border-t border-gray-200 pt-3 dark:border-slate-700">
        <button type="button" onClick={() => { void onOpen(paper.document_id).catch(reason => setError(reason instanceof Error ? reason.message : '打开文献失败')); }}
          className="text-left text-sm font-semibold text-brand-700 dark:text-brand-300">{paper.title}</button>
        <p className="text-xs text-gray-500">召回线索：{Object.keys(paper.rank_signals).map(key => labels[key] ?? key).join(' · ')}</p>
        {paper.relevance && <p className="text-xs text-gray-500">{paper.relevance === 'direct' ? '已找到支持主要线索的内容' : '部分线索相关，需进一步确认'}</p>}
        {paper.matched_notes.slice(0, 2).map(note => <div key={note.id} className="space-y-1 text-sm leading-6">
          <p>{note.text}</p>
          <details className="text-xs text-gray-500"><summary className="cursor-pointer">核对支持原句</summary>
            {note.evidence.map(source => <div key={source.span_id ?? source.chunk_id} className="mt-2 space-y-1">
              <p className="whitespace-pre-wrap break-words">{source.excerpt}</p>
              <button type="button" className="font-medium text-brand-700 dark:text-brand-300" onClick={() => onPreview(source)}>
                {source.page_index === undefined ? '查看原文' : `查看第 ${source.page_index + 1} 页`}
              </button>
            </div>)}
          </details>
        </div>)}
        {!paper.matched_notes.length && paper.body_previews.slice(0, 1).map(item => <div key={item.source.chunk_id} className="space-y-1">
          <p className="text-xs leading-5 text-gray-500">{item.text}…</p>
          <button type="button" onClick={() => onPreview(item.source)} className="text-xs font-medium text-brand-700 dark:text-brand-300">核对正文候选</button>
        </div>)}
      </article>)}
    </div>}
  </details>;
}
