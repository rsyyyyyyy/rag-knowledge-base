import { useState } from 'react';
import { Button, Input, Modal, message } from 'antd';
import { downloadOnlinePaper, parseFileOnly, searchOnlinePapers, uploadDocument, type OnlinePaper } from '../services/api';

export interface OnlinePaperAttachment {
  filename: string;
  text: string;
  basis: 'pdf' | 'abstract';
  sourceUrl: string;
}

export default function OnlinePaperSearch({ open, onClose, onAttach, onImport }: {
  open: boolean;
  onClose: () => void;
  onAttach: (attachment: OnlinePaperAttachment) => void;
  onImport: () => void;
}) {
  const [query, setQuery] = useState('');
  const [papers, setPapers] = useState<OnlinePaper[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function search() {
    if (busy || query.trim().length < 2) return;
    setError('');
    setPapers(null);
    setBusy(true);
    try {
      setPapers(await searchOnlinePapers(query.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : '检索失败。');
    } finally {
      setBusy(false);
    }
  }

  function attach(paper: OnlinePaper, text: string, basis: OnlinePaperAttachment['basis']) {
    onAttach({ filename: paper.title, text, basis, sourceUrl: paper.source_url });
    onClose();
  }

  async function select(paper: OnlinePaper, save: boolean) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const file = await downloadOnlinePaper(paper);
      if (save) {
        const result = await uploadDocument(file);
        message.success(result.duplicate ? '这篇论文已在知识库中。' : '已提交到知识库，正在等待索引。');
        onImport();
        onClose();
      } else {
        const parsed = await parseFileOnly(file);
        if (!parsed.text.trim()) throw new Error('PDF 未提取到可读文字。');
        attach(paper, parsed.text, 'pdf');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : '无法读取开放 PDF。';
      if (!save && paper.abstract) {
        message.info(`${detail} 这次将仅使用摘要。`);
        attach(paper, paper.abstract, 'abstract');
      } else {
        setError(detail);
      }
    } finally {
      setBusy(false);
    }
  }

  return <Modal title="联网找论文" open={open} onCancel={busy ? undefined : onClose}
    closable={!busy} maskClosable={!busy} keyboard={!busy} footer={null} width={720}>
    <Input.Search aria-label="论文标题、DOI 或主题" placeholder="输入论文标题、DOI 或主题"
      value={query} onChange={event => setQuery(event.target.value)} onSearch={() => void search()}
      enterButton="搜索" loading={busy} disabled={busy} maxLength={500} />
    {error && <p role="alert" className="my-2 text-sm text-red-600">{error}</p>}
    {papers?.length === 0 && <p className="my-3 text-sm">没有找到论文，试试完整标题或 DOI。</p>}
    <div className="mt-3 max-h-[55vh] space-y-3 overflow-y-auto">
      {papers?.map(paper => <article key={paper.id} className="space-y-2 rounded-lg border border-gray-200 p-3">
        <a href={paper.source_url} target="_blank" rel="noreferrer" className="font-medium text-brand-700">
          {paper.title}
        </a>
        <p className="text-xs text-gray-500">
          {[paper.year, paper.authors.join('、')].filter(Boolean).join(' · ')}
        </p>
        {paper.abstract && <details className="text-xs"><summary className="cursor-pointer">查看摘要</summary>
          <p className="mt-1 whitespace-pre-wrap">{paper.abstract}</p>
        </details>}
        <div className="flex flex-wrap items-center gap-2">
          {paper.can_download && <>
            <Button size="small" disabled={busy} onClick={() => void select(paper, false)}>临时阅读全文</Button>
            <Button size="small" disabled={busy} onClick={() => void select(paper, true)}>加入知识库</Button>
          </>}
          {paper.abstract && <Button size="small" disabled={busy}
            onClick={() => attach(paper, paper.abstract, 'abstract')}>仅用摘要提问</Button>}
          {paper.pdf_url && <a href={paper.pdf_url} target="_blank" rel="noreferrer"
            className="text-xs text-brand-700 underline">开放 PDF</a>}
        </div>
      </article>)}
    </div>
  </Modal>;
}
