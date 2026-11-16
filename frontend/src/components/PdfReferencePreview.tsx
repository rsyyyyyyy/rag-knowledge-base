import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';
import type { Source } from '../services/api';

GlobalWorkerOptions.workerSrc = workerUrl;

const assetRoot = '../../node_modules/pdfjs-dist/';
const cMaps = import.meta.glob<string>('../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
  query: '?url&no-inline', import: 'default',
});
const standardFonts = import.meta.glob<string>('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', {
  query: '?url&no-inline', import: 'default',
});

async function readPdfAsset(url: (() => Promise<string>) | undefined, name: string) {
  if (!url) throw new Error('PDF asset unavailable: ' + name);
  const response = await fetch(await url());
  if (!response.ok) throw new Error('PDF asset could not be read: ' + name);
  return new Uint8Array(await response.arrayBuffer());
}

class CMapReader {
  async fetch({ name }: { name: string }) {
    const data = await readPdfAsset(cMaps[assetRoot + 'cmaps/' + name + '.bcmap'], name);
    return { cMapData: data, isCompressed: true };
  }
}

class StandardFontReader {
  fetch({ filename }: { filename: string }) {
    return readPdfAsset(standardFonts[assetRoot + 'standard_fonts/' + filename], filename);
  }
}

interface PdfReferencePreviewProps {
  url: string;
  sources: Source[];
  onError: () => void;
}

export default function PdfReferencePreview({ url, sources, onError }: PdfReferencePreviewProps) {
  const evidencePages = [...new Set(sources.flatMap(source => source.page_index ?? []))].sort((a, b) => a - b);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [pageIndex, setPageIndex] = useState(evidencePages[0] ?? 0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [availableWidth, setAvailableWidth] = useState(0);
  const [ready, setReady] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const rects = sources
    .filter(source => source.page_index === pageIndex)
    .flatMap(source => source.rects ?? []);

  useEffect(() => {
    const task = getDocument({
      url,
      useWorkerFetch: false,
      CMapReaderFactory: CMapReader,
      StandardFontDataFactory: StandardFontReader,
    });
    let active = true;
    task.promise.then(document => {
      if (active) setPdf(document);
    }).catch(() => {
      if (active) onError();
    });
    return () => {
      active = false;
      void task.destroy().catch(() => {});
    };
  }, [url, onError]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setAvailableWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || availableWidth <= 0) return;
    let active = true;
    let cancelRender: (() => void) | undefined;
    setReady(false);
    const canvasHost = surface.current;
    if (!canvasHost) return;
    canvasHost.replaceChildren();

    async function renderPage(document: PDFDocumentProxy, host: HTMLDivElement) {
      const page = await document.getPage(pageIndex + 1);
      if (!active) return;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: availableWidth / natural.width });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      canvas.setAttribute('aria-label', 'PDF 第 ' + (pageIndex + 1) + ' 页');

      const task = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      cancelRender = () => task.cancel();
      await task.promise;
      if (!active) return;
      setSize({ width: viewport.width, height: viewport.height });
      host.replaceChildren(canvas);
      setReady(true);
    }

    void renderPage(pdf, canvasHost).catch(() => {
      if (active) onError();
    });
    return () => {
      active = false;
      cancelRender?.();
    };
  }, [pdf, pageIndex, availableWidth, onError]);

  return (
    <div ref={container} className="min-w-0 space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pageIndex === 0} onClick={() => setPageIndex(pageIndex - 1)} className="disabled:opacity-40">
          上一页
        </button>
        <span>{pageIndex + 1} / {pdf?.numPages ?? '…'}</span>
        <button type="button" disabled={!pdf || pageIndex + 1 >= pdf.numPages} onClick={() => setPageIndex(pageIndex + 1)} className="disabled:opacity-40">
          下一页
        </button>
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">打开原文件</a>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="引用页码">
        {evidencePages.map(index => (
          <button
            key={index}
            type="button"
            aria-pressed={index === pageIndex}
            onClick={() => setPageIndex(index)}
            className="rounded border border-gray-300 px-2 py-1 aria-pressed:border-yellow-500 aria-pressed:bg-yellow-100 aria-pressed:text-slate-950"
          >
            第 {index + 1} 页
          </button>
        ))}
      </div>
      {!ready && <p role="status">正在渲染 PDF…</p>}
      <div className="relative" style={{ width: size.width || undefined, height: ready ? size.height : 0 }}>
        <div ref={surface} className={ready ? '' : 'invisible'} />
        {ready && (
          <div className="pointer-events-none absolute inset-0" aria-label="原文证据高亮">
            {rects.map(([left, top, right, bottom], index) => (
              <div
                key={index}
                className="absolute bg-yellow-300/55"
                style={{
                  left: left * size.width,
                  top: top * size.height,
                  width: (right - left) * size.width,
                  height: (bottom - top) * size.height,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
