import { useEffect, useRef, useState } from 'react';
import { getDocumentSections, readDocumentSection } from '../services/api';
import type { DocumentStructure, SectionReading, Source } from '../services/api';

interface Props {
  documentId: string;
  versionId: string;
  onSelectPassage: (source: Source) => void;
}

export default function SectionReader({ documentId, versionId, onSelectPassage }: Props) {
  const [structure, setStructure] = useState<DocumentStructure | null>(null);
  const [selected, setSelected] = useState('');
  const [reading, setReading] = useState<SectionReading | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStructure(null);
    setSelected('');
    setReading(null);
    setLoading(true);
    setError('');
    void getDocumentSections(documentId, versionId, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setStructure(data);
      setSelected(data.sections[0]?.id ?? '');
      if (!data.sections.length) setLoading(false);
    }).catch(reason => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : '读取章节失败');
      setLoading(false);
    });
    return () => controller.abort();
  }, [documentId, versionId, reload]);

  useEffect(() => {
    if (!selected || !structure?.generation) return;
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    setReading(null);
    setLoading(true);
    setError('');
    void readDocumentSection(documentId, selected, versionId, structure.generation, 0, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setReading(data);
      if (data.evidence[0]) onSelectPassage(data.evidence[0]);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取章节正文失败');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [documentId, versionId, selected, structure?.generation, onSelectPassage]);

  async function loadMore() {
    if (!reading || reading.next_offset === null || loading) return;
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    setLoading(true);
    setError('');
    try {
      const data = await readDocumentSection(
        documentId, reading.section_id, versionId, reading.generation,
        reading.next_offset, controller.signal,
      );
      if (!controller.signal.aborted) {
        setReading(previous => previous ? { ...data, evidence: [...previous.evidence, ...data.evidence] } : data);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取章节正文失败');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => () => activeRequest.current?.abort(), []);

  return (
    <section className="space-y-4" aria-label="章节原文">
      {structure && structure.sections.length > 0 && (
        <label className="block text-sm text-gray-700 dark:text-gray-200">
          章节
          <select value={selected} onChange={event => setSelected(event.target.value)}
            className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
            {structure.sections.map(section => (
              <option key={section.id} value={section.id}>
                {'　'.repeat(Math.min(4, Math.max(0, section.level - 1)))}{section.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-red-600 dark:text-red-400">{error}</p>
          <button type="button" className="text-brand-600 underline" onClick={() => setReload(value => value + 1)}>重新加载章节</button>
        </div>
      )}
      {structure && !structure.sections.length && !error && !loading && (
        <p className="text-sm text-gray-500">这篇文献还没有可读取的章节正文，请等待入库完成。</p>
      )}
      {reading?.evidence.map(source => (
        <button key={source.chunk_id} type="button" onClick={() => onSelectPassage(source)}
          disabled={source.page_index === undefined}
          title={source.page_index === undefined ? '此段缺少 PDF 页码定位' : '在 PDF 中定位此段原文'}
          className="block w-full rounded-lg border border-gray-200 bg-white p-3 text-left transition-colors hover:border-brand-400 focus-visible:outline-brand-500 disabled:cursor-default dark:border-slate-700 dark:bg-slate-800">
          {source.page_index !== undefined && <span className="mb-2 block text-xs text-gray-500">第 {source.page_index + 1} 页 · 定位原文</span>}
          <span className="block whitespace-pre-wrap break-words text-sm leading-6 text-gray-700 dark:text-gray-200">{source.excerpt}</span>
        </button>
      ))}
      {loading && <p role="status" className="text-sm text-gray-500">正在读取章节正文…</p>}
      {reading?.next_offset !== null && reading && (
        <button type="button" onClick={() => void loadMore()} disabled={loading}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-slate-600">
          继续阅读本章
        </button>
      )}
    </section>
  );
}
