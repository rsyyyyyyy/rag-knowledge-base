import { useEffect, useRef, useState } from 'react';
import { generateDocumentProfile, getDocumentProfile } from '../services/api';
import type { ProfileFacet, ProfileNote, ProfileResponse, Source } from '../services/api';

const fields: [ProfileFacet, string][] = [
  ['research_question', '研究问题'], ['methodology', '核心方法'],
  ['findings', '主要发现'], ['conditions', '适用条件'], ['limitations', '局限'],
];

function Note({ note, onSelect }: { note: ProfileNote; onSelect: (source: Source) => void }) {
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap text-sm leading-6 text-gray-700 dark:text-gray-200">{note.text}</p>
      <details className="text-xs text-gray-500 dark:text-gray-400">
        <summary className="cursor-pointer">查看原句</summary>
        {note.evidence.map(source => (
          <div key={source.span_id ?? source.chunk_id} className="mt-2 space-y-2 border-l-2 border-brand-400 pl-3">
            <p className="whitespace-pre-wrap break-words leading-5">{source.excerpt}</p>
            {source.page_index !== undefined && (
              <button type="button" onClick={() => onSelect(source)}
                className="rounded-full bg-brand-600 px-3 py-1 font-medium text-white hover:bg-brand-700">
                第 {source.page_index + 1} 页 · 原文高亮
              </button>
            )}
          </div>
        ))}
      </details>
    </div>
  );
}

export default function PaperProfile({
  documentId, versionId, onSelectPassage,
}: { documentId: string; versionId: string; onSelectPassage: (source: Source) => void }) {
  const [response, setResponse] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [selectedSection, setSelectedSection] = useState('');
  const submitRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const data = await getDocumentProfile(documentId, versionId, controller.signal);
        if (controller.signal.aborted) return;
        setResponse(data);
        setError('');
        if (data.state === 'queued' || data.state === 'processing') timer = setTimeout(() => void poll(), 2000);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取文献卡片失败');
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [documentId, versionId, revision]);

  useEffect(() => () => submitRequest.current?.abort(), []);

  async function generate() {
    const controller = new AbortController();
    submitRequest.current?.abort();
    submitRequest.current = controller;
    setSubmitting(true);
    setError('');
    try {
      const data = await generateDocumentProfile(documentId, versionId, Boolean(response?.artifact), controller.signal);
      if (controller.signal.aborted) return;
      setResponse(data);
      setRevision(value => value + 1);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '生成文献卡片失败');
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  const busy = submitting || response?.state === 'queued' || response?.state === 'processing';
  const artifact = response?.artifact;
  const notes = new Map(artifact?.notes.map(note => [note.id, note]) ?? []);
  const section = artifact?.sections.find(item => item.id === selectedSection)
    ?? artifact?.sections.find(item => item.note_ids.length > 0) ?? artifact?.sections[0];
  const progress = response?.progress;
  const progressValue = progress?.total ? Math.min(100, progress.completed / progress.total * 100) : 0;
  return (
    <section className="space-y-5" aria-label="文献卡片与章节摘要">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">文献卡片</h3>
        <button type="button" onClick={() => void generate()} disabled={busy || response?.state === 'not_ready'}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? '生成中' : artifact ? '重新生成' : response?.state === 'failed' ? '重试' : '生成'}
        </button>
      </div>
      {(error || response?.error) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error || response?.error}</p>}
      {error && <button type="button" onClick={() => setRevision(value => value + 1)} className="text-xs text-brand-600">刷新状态</button>}
      {busy && (
        <div role="status" className="space-y-2 text-sm text-gray-500">
          <p>{response?.state === 'queued' ? '等待后台生成…'
            : progress?.stage === 'organizing' ? '正在整理文献卡片…' : '正在生成章节摘要…'}</p>
          <div role="progressbar" aria-label="摘要生成进度" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(progressValue)} className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-slate-700">
            <div className="h-full bg-brand-600 transition-all" style={{ width: progressValue + '%' }} />
          </div>
        </div>
      )}
      {!response && !error && <p className="text-sm text-gray-500">正在读取文献卡片…</p>}
      {response?.state === 'not_ready' && <p className="text-sm text-gray-500">请等待文献解析完成。</p>}
      {response && !artifact && !busy && response.state !== 'not_ready' && (
        <p className="text-sm leading-6 text-gray-500">生成后可查看研究问题、方法、发现、条件和局限，并从原句回到 PDF。</p>
      )}
      {artifact && (
        <>
          {artifact.partial && <p className="text-xs leading-5 text-amber-700 dark:text-amber-400">部分内容尚未取得可定位的原句，以下展示已保留的要点。</p>}
          {fields.map(([key, label]) => (
            <div key={key} className="space-y-3">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label}</h4>
              {artifact.fields[key].length ? artifact.fields[key].map(id => {
                const note = notes.get(id);
                return note ? <Note key={id} note={note} onSelect={onSelectPassage} /> : null;
              }) : <p className="text-xs text-gray-500">本轮未提取到带出处的内容。</p>}
            </div>
          ))}
          <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">章节摘要</h3>
            <select aria-label="摘要章节" value={section?.id ?? ''} onChange={event => setSelectedSection(event.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
              {artifact.sections.map(item => <option key={item.id} value={item.id}>
                {'　'.repeat(Math.min(4, Math.max(0, item.level - 1)))}{item.title}
              </option>)}
            </select>
            {section?.note_ids.map(id => {
              const note = notes.get(id);
              return note ? <Note key={id} note={note} onSelect={onSelectPassage} /> : null;
            })}
            {!section?.note_ids.length && <p className="text-xs text-gray-500">本节暂未提取到带出处的摘要，可在“章节原文”中继续阅读。</p>}
          </div>
        </>
      )}
    </section>
  );
}
