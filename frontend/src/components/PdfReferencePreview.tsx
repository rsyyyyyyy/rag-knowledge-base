import { getDocument, GlobalWorkerOptions, type PDFPageProxy, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

export interface PdfPageJump {
  pageIndex: number;
  title?: string;
  destination?: { x?: number; y?: number };
}

interface PdfBookmark extends PdfPageJump {
  title: string;
  level: number;
}

export interface PdfNavigation {
  totalPages: number;
  bookmarks: PdfBookmark[];
}

async function readBookmarks(pdf: PDFDocumentProxy): Promise<PdfBookmark[]> {
  const bookmarks: PdfBookmark[] = [];
  type Outline = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>;
  async function visit(items: Outline, level: number) {
    for (const item of items ?? []) {
      try {
        const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        const target = destination?.[0];
        const pageIndex = typeof target === 'number' ? target
          : target && typeof target === 'object' ? await pdf.getPageIndex(target) : -1;
        if (Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pdf.numPages && item.title.trim()) {
          const kind = destination?.[1]?.name;
          const x = kind === 'XYZ' || kind === 'FitR' ? destination?.[2]
            : kind === 'FitV' || kind === 'FitBV' ? destination?.[2] : undefined;
          const y = kind === 'XYZ' ? destination?.[3] : kind === 'FitR' ? destination?.[5]
            : kind === 'FitH' || kind === 'FitBH' ? destination?.[2] : undefined;
          bookmarks.push({ title: item.title, pageIndex, level, destination: {
            x: typeof x === 'number' && Number.isFinite(x) ? x : undefined,
            y: typeof y === 'number' && Number.isFinite(y) ? y : undefined,
          } });
        }
      } catch {
        // Some PDFs contain unresolved internal destinations.
      }
      await visit(item.items, level + 1);
    }
  }
  await visit(await pdf.getOutline(), 0);
  return bookmarks;
}

interface PdfReferencePreviewProps {
  url: string;
  sources: Source[];
  onError: () => void;
  onNavigation?: (navigation: PdfNavigation) => void;
  pageJump?: PdfPageJump | null;
}

type PageRect = NonNullable<Source['rects']>[number];
const emptyRects: PageRect[] = [];

function PdfPage({ page, scroller, width, rects }: {
  page: PDFPageProxy;
  scroller: HTMLDivElement | null;
  width: number;
  rects: PageRect[];
}) {
  const frame = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [failed, setFailed] = useState(false);
  const natural = page.getViewport({ scale: 1 });

  useEffect(() => {
    const element = frame.current;
    if (!element || !scroller) return;
    const observer = new IntersectionObserver(([entry]) => setNearViewport(entry.isIntersecting), {
      root: scroller,
      rootMargin: '350px 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    const host = surface.current;
    if (!host) return;
    if (!nearViewport) {
      host.replaceChildren();
      return;
    }
    const viewport = page.getViewport({ scale: width / natural.width });
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.className = 'block h-full w-full';
    canvas.setAttribute('aria-hidden', 'true');

    let active = true;
    // Avoid starting a new canvas render for each pointer event during drag or wheel zoom.
    let render: ReturnType<PDFPageProxy['render']> | undefined;
    const timer = window.setTimeout(() => {
      render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      void render.promise.then(() => {
        if (!active) return;
        host.replaceChildren(canvas);
        setFailed(false);
      }).catch(() => {
        if (active) setFailed(true);
      });
    }, 80);
    return () => {
      active = false;
      window.clearTimeout(timer);
      render?.cancel();
    };
  }, [nearViewport, natural.width, page, width]);

  return (
    <div ref={frame} data-pdf-page={page.pageNumber} aria-label={`PDF 第 ${page.pageNumber} 页`}
      role="group" className="relative mx-auto bg-white shadow-sm"
      style={{ width, aspectRatio: natural.width / natural.height }}>
      <div ref={surface} className="absolute inset-0" />
      {failed && <p role="status" className="p-3 text-slate-900">这一页暂时无法渲染。</p>}
      {rects.length > 0 && (
        <div className="pointer-events-none absolute inset-0" aria-label="原文证据高亮">
          {rects.map(([left, top, right, bottom], index) => (
            <div key={index} className="absolute bg-yellow-300/55" style={{
              left: `${left * 100}%`, top: `${top * 100}%`,
              width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%`,
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PdfReferencePreview({ url, sources, onError, onNavigation, pageJump }: PdfReferencePreviewProps) {
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const anchor = useRef<{ page: HTMLElement; x: number; y: number; clientX: number; clientY: number } | null>(null);
  const initialJump = useRef(false);
  const highlights = new Map<number, PageRect[]>();
  for (const source of sources) {
    const index = source.page_index;
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= pages.length) continue;
    const rects = highlights.get(index) ?? [];
    rects.push(...(source.rects ?? []));
    highlights.set(index, rects);
  }
  const evidence = sources.flatMap((source, index) => {
    const pageIndex = source.page_index;
    return pageIndex !== undefined && highlights.has(pageIndex) ? [{
      index, pageIndex, top: source.rects?.[0]?.[1] ?? 0,
    }] : [];
  }).sort((a, b) => a.pageIndex - b.pageIndex || a.top - b.top);
  const firstEvidencePage = evidence[0]?.pageIndex;
  const firstEvidenceTop = evidence[0]?.top ?? 0;
  const canRead = pages.length > 0 && availableWidth > 0;

  useEffect(() => {
    let active = true;
    const task = getDocument({
      url,
      useWorkerFetch: false,
      CMapReaderFactory: CMapReader,
      StandardFontDataFactory: StandardFontReader,
    });
    void task.promise.then(async pdf => {
      if (onNavigation && active) {
        void readBookmarks(pdf).catch(() => []).then(bookmarks => {
          if (active) onNavigation({ totalPages: pdf.numPages, bookmarks });
        });
      }
      const allPages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
      if (active) setPages(allPages);
    }).catch(() => { if (active) onError(); });
    return () => {
      active = false;
      void task.destroy().catch(() => {});
    };
  }, [url, onError, onNavigation]);

  useLayoutEffect(() => {
    if (!scroller) return;
    const measure = () => setAvailableWidth(Math.max(0, scroller.clientWidth - 16));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  useLayoutEffect(() => {
    if (!scroller || !canRead || initialJump.current) return;
    initialJump.current = true;
    if (firstEvidencePage === undefined) return;
    jumpToEvidence(scroller, firstEvidencePage, firstEvidenceTop);
  }, [scroller, canRead, firstEvidencePage, firstEvidenceTop]);

  useEffect(() => {
    if (!scroller || !canRead || !pageJump) return;
    const page = pages[pageJump.pageIndex];
    if (!page) return;
    if (!pageJump.title) {
      jumpToEvidence(scroller, pageJump.pageIndex, 0);
      return;
    }
    let active = true;
    const viewport = page.getViewport({ scale: 1 });
    const { x, y } = pageJump.destination ?? {};
    const hasDestinationY = page.rotate % 180 === 0 ? y !== undefined : x !== undefined;
    const destinationY = hasDestinationY
      ? viewport.convertToViewportPoint(x ?? page.view[0], y ?? page.view[3])[1] / viewport.height
      : undefined;
    void findHeading(page, pageJump.title, destinationY).catch(() => undefined).then(headingY => {
      if (!active) return;
      const top = headingY ?? destinationY;
      if (top === undefined) {
        jumpToEvidence(scroller, pageJump.pageIndex, 0);
      } else {
        scrollToPdfPosition(scroller, pageJump.pageIndex, Math.max(0, Math.min(1, top)), scroller.clientHeight / 2);
      }
    });
    return () => { active = false; };
  }, [canRead, pageJump, pages, scroller]);

  useEffect(() => {
    if (!scroller) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      const page = (event.target as HTMLElement).closest<HTMLElement>('[data-pdf-page]');
      if (page) {
        const rect = page.getBoundingClientRect();
        anchor.current = {
          page, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height,
          clientX: event.clientX, clientY: event.clientY,
        };
      } else {
        anchor.current = null;
      }
      setZoom(previous => Math.min(3, Math.max(0.5, previous * (event.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    scroller.addEventListener('wheel', handleWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', handleWheel);
  }, [scroller]);

  useLayoutEffect(() => {
    const point = anchor.current;
    anchor.current = null;
    if (!scroller || !point) return;
    const rect = point.page.getBoundingClientRect();
    scroller.scrollLeft += rect.left + point.x * rect.width - point.clientX;
    scroller.scrollTop += rect.top + point.y * rect.height - point.clientY;
  }, [scroller, zoom]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 text-sm">
      <div className="shrink-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span>{pages.length ? `全文 · ${pages.length} 页` : 'PDF 全文'}</span>
          <button type="button" aria-label="缩小 PDF" className="rounded border px-2"
            disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value / 1.1))}>−</button>
          <button type="button" className="rounded border px-2" title="恢复适合宽度"
            onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label="放大 PDF" className="rounded border px-2"
            disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value * 1.1))}>+</button>
          <span className="text-xs text-gray-500 dark:text-slate-400">Ctrl + 滚轮缩放</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">打开原文件</a>
        </div>
        {evidence.length > 0 && (
          <div className="flex max-h-24 flex-wrap items-center gap-2 overflow-auto" aria-label="引用片段">
            <span className="text-xs text-gray-500 dark:text-slate-400">跳转到命中片段：</span>
            {evidence.map(({ index, pageIndex, top }) => (
              <button key={index} type="button" onClick={() => jumpToEvidence(scroller, pageIndex, top)}
                className="rounded border border-yellow-500 px-2 py-1 hover:bg-yellow-100 hover:text-slate-950">
                第 {pageIndex + 1} 页 · 片段 {index + 1}
              </button>
            ))}
          </div>
        )}
      </div>
      <div ref={setScroller} tabIndex={0} aria-label="PDF 全文页面"
        className="min-h-0 flex-1 overflow-auto overscroll-contain rounded bg-slate-200 dark:bg-slate-800">
        {!canRead && <p role="status" className="p-3">正在加载 PDF 全文…</p>}
        {canRead && <div className="space-y-2 p-2" style={{ width: Math.max(availableWidth, availableWidth * zoom) + 16 }}>
          {pages.map((page, index) => (
            <PdfPage key={page.pageNumber} page={page} scroller={scroller}
              width={availableWidth * zoom} rects={highlights.get(index) ?? emptyRects} />
          ))}
        </div>}
      </div>
    </div>
  );
}

function normalizeHeading(title: string) {
  return title.normalize('NFKC').toLowerCase().trim()
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/u, '')
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

async function findHeading(page: PDFPageProxy, title: string, destinationY?: number) {
  const normalizedTitle = normalizeHeading(title);
  if (!normalizedTitle) return undefined;
  const viewport = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  const lines: { text: string; y: number; height: number }[] = [];
  let line: (typeof lines)[number] | undefined;
  for (const item of items) {
    if (!('str' in item)) continue;
    if (item.str.trim()) {
      const [, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      if (!line || Math.abs(line.y - y) > Math.max(2, item.height * 0.35)) {
        line = { text: '', y, height: item.height };
        lines.push(line);
      }
      line.text += (line.text ? ' ' : '') + item.str;
      line.height = Math.max(line.height, item.height);
    }
    if (item.hasEOL) line = undefined;
  }
  const matches = lines.filter(candidate => normalizeHeading(candidate.text) === normalizedTitle);
  const position = (candidate: (typeof lines)[number]) => (candidate.y - candidate.height / 2) / viewport.height;
  matches.sort((a, b) => destinationY === undefined ? b.height - a.height
    : Math.abs(position(a) - destinationY) - Math.abs(position(b) - destinationY));
  return matches[0] ? position(matches[0]) : undefined;
}

function jumpToEvidence(scroller: HTMLDivElement | null, pageIndex: number, top: number) {
  scrollToPdfPosition(scroller, pageIndex, top, 8);
}

function scrollToPdfPosition(scroller: HTMLDivElement | null, pageIndex: number, top: number, offset: number) {
  const element = scroller?.querySelector(`[data-pdf-page="${pageIndex + 1}"]`);
  if (!element || !scroller) return;
  const rect = element.getBoundingClientRect();
  scroller.scrollTop += rect.top + rect.height * top - scroller.getBoundingClientRect().top - offset;
}
