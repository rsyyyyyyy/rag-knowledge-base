import { useState } from 'react';

const labels: Record<string, string> = {
  queued: '等待入库',
  processing: '正在入库',
  parsed: '可检索',
  failed: '入库失败',
  no_text_extracted: '未提取到文本',
  stored_only: '原文件已保存',
};

export function isIngestionPending(status?: string) {
  return status === 'queued' || status === 'processing';
}

interface Props {
  metadata: { status?: string; searchable?: boolean; error_message?: string | null };
  onRetry: () => Promise<void>;
  onReplace: () => void;
}

export default function IngestionStatus({ metadata, onRetry, onReplace }: Props) {
  const [retrying, setRetrying] = useState(false);
  const status = metadata.status ?? '';
  const pending = isIngestionPending(status);
  const canRetry = status === 'failed' || status === 'no_text_extracted';
  return (
    <div className="mt-2 space-y-1" onClick={event => event.stopPropagation()}>
      <p role="status" className={canRetry ? 'text-red-700 dark:text-red-300' : ''}>
        {labels[status]}
        {metadata.searchable && status !== 'parsed' && ' · 旧版本可检索'}
      </p>
      {metadata.error_message && <p className="break-words">{metadata.error_message}</p>}
      {status && !pending && (
        <div className="flex flex-wrap gap-3">
          {(canRetry || status === 'parsed') && (
            <button
              type="button"
              className="text-brand-600 underline disabled:opacity-50"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try { await onRetry(); }
                finally { setRetrying(false); }
              }}
            >
              {canRetry ? '重试入库' : '重建索引'}
            </button>
          )}
          <button type="button" className="text-brand-600 underline" onClick={onReplace}>
            替换文件
          </button>
        </div>
      )}
    </div>
  );
}
