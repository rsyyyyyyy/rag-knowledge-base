import { Icon } from '@iconify/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getDocumentFileUrl, getDocumentView, type Source } from '../services/api';

const PdfReferencePreview = lazy(() => import('./PdfReferencePreview'));

export interface ReferenceFile {
  versionId?: string;
  selectionId?: number;
  id: string;
  filename: string;
  sources: Source[];
}

interface TextRange {
  start: number;
  end: number;
}

function locateEvidence(text: string, sources: Source[]) {
  const ranges: TextRange[] = [];
  const unmatched: Source[] = [];

  for (const source of sources) {
    const excerpt = source.excerpt.trim();
    if (!excerpt) continue;

    // Indexing can collapse paragraph breaks. Match equivalent whitespace in the original.
    const pattern = excerpt
      .split(/\s+/)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    const matches = [...text.matchAll(new RegExp(pattern, 'g'))];
    if (!matches.length) unmatched.push(source);

    for (const match of matches) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  const merged: TextRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return { ranges: merged, unmatched };
}

function AttachmentPreview({ sources }: { sources: Source[] }) {
  return <>
    {sources.map((source, index) => (
      <article key={index} className="mb-4 space-y-2 text-sm">
        <p className="text-xs text-gray-500 dark:text-slate-400">
          {source.attachmentBasis === 'abstract' ? '论文摘要'
            : source.attachmentBasis === 'pdf' ? '本轮提供给模型的 PDF 提取文本' : '本轮提供给模型的附件文本'}
        </p>
        {source.sourceUrl && (
          <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-block text-brand-600 underline">
            打开论文来源
          </a>
        )}
        <p className="whitespace-pre-wrap break-words leading-relaxed">{source.excerpt || '暂无可显示的附件文本。'}</p>
      </article>
    ))}
  </>;
}

function ReferencePreview({ file }: { file: ReferenceFile }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(!file.versionId);
  const [error, setError] = useState('');
  const firstHighlight = useRef<HTMLElement>(null);
  const { ranges, unmatched } = useMemo(() => locateEvidence(text, file.sources), [text, file.sources]);

  useEffect(() => {
    if (file.versionId) return;

    let active = true;
    getDocumentView(file.id).then(view => {
      if (!active) return;
      if (view.content) setText(view.content);
      else setError('原文件没有可用于定位的文本。');
    }).catch(() => {
      if (active) setError('原文件暂时无法预览。');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [file.id, file.versionId]);

  useEffect(() => {
    if (!loading && ranges.length) {
      firstHighlight.current?.scrollIntoView({ block: 'center' });
    }
  }, [loading, ranges]);

  if (loading) return <p role="status">正在加载原文…</p>;

  const highlightStyle = 'bg-yellow-200 text-slate-950';
  return (
    <>
      <a
        className="mb-4 inline-block text-brand-600 underline"
        href={getDocumentFileUrl(file.id, file.versionId)}
        target="_blank"
        rel="noopener noreferrer"
      >
        打开原文件
      </a>
      {!!text && (
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {ranges.map((range, index) => (
            <span key={range.start}>
              {text.slice(index ? ranges[index - 1].end : 0, range.start)}
              <mark ref={index === 0 ? firstHighlight : undefined} className={highlightStyle}>
                {text.slice(range.start, range.end)}
              </mark>
            </span>
          ))}
          {text.slice(ranges[ranges.length - 1]?.end ?? 0)}
        </div>
      )}
      {!!unmatched.length && (
        <div className="mt-4 space-y-2 border-t border-gray-200 pt-4">
          <p className="text-sm">{error || '部分片段未在当前原文中定位。'}以下是检索时保存的片段。</p>
          {unmatched.map((source, index) => (
            <p key={source.chunk_id ?? index} className="whitespace-pre-wrap break-words text-sm">
              <mark className={highlightStyle}>{source.excerpt}</mark>
            </p>
          ))}
        </div>
      )}
    </>
  );
}

function DocumentPreview({ file }: { file: ReferenceFile }) {
  const [pdfFailed, setPdfFailed] = useState(false);
  const handlePdfError = useCallback(() => setPdfFailed(true), []);
  if (file.id === 'attachment') return <AttachmentPreview sources={file.sources} />;
  if (file.versionId && !pdfFailed) {
    return (
      <Suspense fallback={<p role="status">正在加载 PDF 预览…</p>}>
        <PdfReferencePreview url={getDocumentFileUrl(file.id, file.versionId)} sources={file.sources} onError={handlePdfError} />
      </Suspense>
    );
  }
  return (
    <>
      {pdfFailed && <p className="mb-3 text-sm">该版本原页暂时无法预览。以下为检索时保存的片段。</p>}
      <ReferencePreview file={file} />
    </>
  );
}

export function ReferencePanel({ file, onClose }: { file: ReferenceFile; onClose: () => void }) {
  const [width, setWidth] = useState(42);
  const drag = useRef<{ x: number; width: number; parentWidth: number } | null>(null);
  const clamp = (value: number) => Math.max(30, Math.min(68, value));
  return (
    <>
    <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label="调整原文预览宽度"
      aria-valuemin={30} aria-valuemax={68} aria-valuenow={Math.round(width)}
      className="order-last hidden w-2 shrink-0 cursor-col-resize touch-none select-none bg-gray-200 hover:bg-brand-500 focus-visible:bg-brand-500 dark:bg-slate-800 md:block"
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        const handle = event.currentTarget;
        drag.current = { x: event.clientX, width, parentWidth: handle.parentElement!.clientWidth };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        setWidth(clamp(start.width + (start.x - event.clientX) / start.parentWidth * 100));
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        setWidth(value => clamp(value + (event.key === 'ArrowLeft' ? 4 : -4)));
      }}
    />
    <aside
      aria-label="原文预览"
      style={{ '--reference-width': width + '%' } as CSSProperties}
      className="order-first flex h-[34dvh] min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-b border-gray-200 bg-gray-50 dark:border-slate-800 dark:bg-slate-900 md:order-last md:h-auto md:w-[var(--reference-width)] md:border-b-0 md:border-l"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-slate-800">
        <div className="min-w-0">
          <p className="text-xs text-gray-500 dark:text-slate-400">原文预览</p>
          <h2 className="truncate text-sm font-semibold" title={file.filename}>{file.filename}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭原文预览"
          className="shrink-0 rounded-lg p-2 text-slate-600 hover:bg-gray-200 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Icon icon="solar:close-circle-linear" className="text-xl" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <DocumentPreview key={JSON.stringify([file.id, file.versionId, file.selectionId, file.sources.map(source => source.chunk_id)])} file={file} />
      </div>
    </aside>
    </>
  );
}

export default function ReferenceSources({
  sources,
  answer,
  onSelect,
}: {
  sources: Source[];
  answer: string;
  onSelect: (file: ReferenceFile) => void;
}) {
  const citedNumbers = new Set(Array.from(answer.matchAll(/\[\d+\]\(#evidence-(\d+)\)/g), match => Number(match[1])));
  const files = new Map<string, ReferenceFile>();
  for (const source of sources) {
    const key = source.version_id ? source.id + ':' + source.version_id : source.id;
    const file = files.get(key);
    if (file) file.sources.push(source);
    else files.set(key, {
      id: source.id, filename: source.filename, versionId: source.version_id, sources: [source],
    });
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-500 dark:text-slate-400">参考原文</p>
      {Array.from(files, ([key, file]) => (
        <div key={key} className="space-y-1">
        <button
          type="button"
          onClick={() => onSelect(file)}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs hover:bg-brand-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
        >
          <span className="break-all font-medium">{file.filename}</span>
          <span className="shrink-0 text-gray-500 dark:text-slate-400">{file.sources.length} 个片段</span>
        </button>
        <div className="flex flex-wrap gap-1.5" aria-label="原文证据编号">
          {file.sources.map(source => source.citation_number !== undefined && (
            <button key={source.citation_number} type="button"
              className="rounded border border-gray-300 px-2 py-1 text-xs hover:border-brand-500 dark:border-slate-700"
              onClick={() => onSelect({ ...file, sources: [source] })}>
              [{source.citation_number}] {source.page_index === undefined ? '' : `第 ${source.page_index + 1} 页 · `}
              {citedNumbers.has(source.citation_number) ? '正文已引用' : '可查看片段'}
            </button>
          ))}
        </div>
        </div>
      ))}
    </div>
  );
}
