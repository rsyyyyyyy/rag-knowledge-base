import {
  getDocument, GlobalWorkerOptions, TextLayer,
  type PDFPageProxy, type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  AnnotationDraft, AnnotationKind, PdfAnnotation, Source,
} from '../services/api';

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
  selectionId?: number;
  annotations?: PdfAnnotation[];
  onCreateAnnotation?: (draft: AnnotationDraft) => Promise<void>;
}

type PageRect = NonNullable<Source['rects']>[number];
const emptyRects: PageRect[] = [];

interface AnnotationSelection {
  pageIndex: number;
  rects: [number, number, number, number][];
  quote: string;
}

function selectionRects(range: Range, pageRect: DOMRect): [number, number, number, number][] {
  const rects: [number, number, number, number][] = [];
  for (const clientRect of Array.from(range.getClientRects())) {
    if (clientRect.width < 1 || clientRect.height < 1) continue;
    const centerX = clientRect.left + clientRect.width / 2;
    const centerY = clientRect.top + clientRect.height / 2;
    if (centerX < pageRect.left || centerX > pageRect.right
      || centerY < pageRect.top || centerY > pageRect.bottom) continue;
    const x0 = Math.max(0, (clientRect.left - pageRect.left) / pageRect.width);
    const y0 = Math.max(0, (clientRect.top - pageRect.top) / pageRect.height);
    const x1 = Math.min(1, (clientRect.right - pageRect.left) / pageRect.width);
    const y1 = Math.min(1, (clientRect.bottom - pageRect.top) / pageRect.height);
    if (x1 - x0 < 0.002 || y1 - y0 < 0.002) continue;
    rects.push([x0, y0, x1, y1]);
  }
  return rects;
}

function PdfPage({
  page, pageNumber, ratio, requestPage, scroller, width, rects,
  annotations, annotationMode, onSelect,
}: {
  page?: PDFPageProxy;
  pageNumber: number;
  ratio: number;
  requestPage: (pageNumber: number) => Promise<PDFPageProxy>;
  scroller: HTMLDivElement | null;
  width: number;
  rects: PageRect[];
  annotations: PdfAnnotation[];
  annotationMode: AnnotationKind | null;
  onSelect?: (selection: AnnotationSelection) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [failed, setFailed] = useState(false);
  const natural = page?.getViewport({ scale: 1 });
  const naturalWidth = natural?.width;

  const finishTextSelection = () => {
    if (!annotationMode || !onSelect || !frame.current) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const pageRect = frame.current.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return;
    const rects = selectionRects(selection.getRangeAt(0), pageRect);
    if (!rects.length) return;
    const quote = selection.toString().trim().replace(/\s+/g, ' ').slice(0, 2000);
    selection.removeAllRanges();
    onSelect({ pageIndex: pageNumber - 1, rects, quote });
  };

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
    if (!nearViewport || page) return;
    let active = true;
    void requestPage(pageNumber).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [nearViewport, page, pageNumber, requestPage]);

  useEffect(() => {
    const host = surface.current;
    if (!host) return;
    if (!nearViewport || !page || !naturalWidth) {
      host.replaceChildren();
      textLayer.current?.replaceChildren();
      return;
    }
    const viewport = page.getViewport({ scale: width / naturalWidth });
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.className = 'block h-full w-full';
    canvas.setAttribute('aria-hidden', 'true');

    let active = true;
    // Avoid starting a new canvas render for each pointer event during drag or wheel zoom.
    let render: ReturnType<PDFPageProxy['render']> | undefined;
    let textTask: TextLayer | undefined;
    const layer = textLayer.current;
    const timer = window.setTimeout(() => {
      render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      void render.promise.then(() => {
        if (!active) return;
        host.replaceChildren(canvas);
        setFailed(false);
      }).catch(() => {
        if (active) setFailed(true);
      });
      if (layer) {
        layer.replaceChildren();
        layer.style.setProperty('--total-scale-factor', String(viewport.scale));
        layer.style.setProperty('--scale-round-x', '1px');
        layer.style.setProperty('--scale-round-y', '1px');
        void page.getTextContent().then(content => {
          if (!active || !layer) return;
          textTask = new TextLayer({ textContentSource: content, container: layer, viewport });
          return textTask.render();
        }).catch(() => {});
      }
    }, 80);
    return () => {
      active = false;
      window.clearTimeout(timer);
      render?.cancel();
      textTask?.cancel();
    };
  }, [nearViewport, naturalWidth, page, width]);

  return (
    <div ref={frame} data-pdf-page={pageNumber} aria-label={`PDF 第 ${pageNumber} 页`}
      role="group" className="relative mx-auto bg-white shadow-sm"
      style={{ width, aspectRatio: natural ? natural.width / natural.height : ratio }}
      onMouseUp={finishTextSelection}>
      <div ref={surface} className="absolute inset-0" />
      <div ref={textLayer} className="textLayer" />
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
      {annotations.map(annotation => (
        <Fragment key={annotation.id}>
          {annotation.rects.map((rect, index) => {
            const [x0, y0, x1, y1] = rect;
            const box = {
              left: `${x0 * 100}%`, top: `${y0 * 100}%`,
              width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%`,
            };
            const style = annotation.kind === 'underline'
              ? { ...box, borderBottom: `3px solid ${annotation.color}` }
              : { ...box, backgroundColor: annotation.color, opacity: 0.35 };
            return (
              <div
                key={index}
                data-annotation-id={annotation.id}
                className={`pointer-events-none absolute ${annotation.kind === 'underline' ? '' : 'rounded-sm'}`}
                style={style}
              />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

export default function PdfReferencePreview({
  url, sources, onError, onNavigation, pageJump, selectionId,
  annotations = [], onCreateAnnotation,
}: PdfReferencePreviewProps) {
  const [annotationMode, setAnnotationMode] = useState<AnnotationKind | null>(null);
  const [preview, setPreview] = useState<{ pdf: PDFDocumentProxy; initialPage: PDFPageProxy } | null>(null);
  const [pages, setPages] = useState(new Map<number, PDFPageProxy>());
  const preferredPage = useRef(Math.min(...sources.map(source => (source.page_index ?? Infinity) + 1)));
  const totalPages = preview?.pdf.numPages ?? 0;
  const requestPage = useCallback(async (pageNumber: number) => {
    if (!preview) throw new Error('PDF is not ready');
    const page = await preview.pdf.getPage(pageNumber);
    setPages(current => current.has(pageNumber) ? current : new Map(current).set(pageNumber, page));
    return page;
  }, [preview]);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [zoom, setZoom] = useState(1);
  const anchor = useRef<{ page: HTMLElement; x: number; y: number; clientX: number; clientY: number } | null>(null);
  const highlights = new Map<number, PageRect[]>();
  for (const source of sources) {
    const index = source.page_index;
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= totalPages) continue;
    const rects = highlights.get(index) ?? [];
    rects.push(...(source.rects ?? []));
    highlights.set(index, rects);
  }
  const annotationsByPage = new Map<number, PdfAnnotation[]>();
  for (const annotation of annotations) {
    if (annotation.kind === 'note') continue;
    const current = annotationsByPage.get(annotation.page_index) ?? [];
    current.push(annotation);
    annotationsByPage.set(annotation.page_index, current);
  }
  const createFromSelection = async (kind: AnnotationKind, { pageIndex, rects, quote }: AnnotationSelection) => {
    if (!onCreateAnnotation) return;
    try {
      await onCreateAnnotation({
        page_index: pageIndex,
        kind,
        color: kind === 'highlight' ? '#facc15' : '#2563eb',
        rects,
        quote,
        note: '',
      });
    } catch {
      // The parent shows the error message.
    }
  };
  const handleSelection = (selection: AnnotationSelection) => {
    if (!annotationMode) return;
    void createFromSelection(annotationMode, selection);
  };
  const applyCurrentSelection = (kind: AnnotationKind) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const node = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const page = node?.closest<HTMLElement>('[data-pdf-page]');
    if (!page) return;
    const pageRect = page.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return;
    const rects = selectionRects(range, pageRect);
    if (!rects.length) return;
    const quote = selection.toString().trim().replace(/\s+/g, ' ').slice(0, 2000);
    const pageIndex = Number(page.dataset.pdfPage) - 1;
    selection.removeAllRanges();
    void createFromSelection(kind, { pageIndex, rects, quote });
  };
  const evidence = sources.flatMap((source, index) => {
    const pageIndex = source.page_index;
    const rects = source.rects ?? [];
    const top = rects.length ? Math.min(...rects.map(rect => rect[1])) : 0;
    const bottom = rects.length ? Math.max(...rects.map(rect => rect[3])) : 1;
    const centerX = rects.length
      ? (Math.min(...rects.map(rect => rect[0])) + Math.max(...rects.map(rect => rect[2]))) / 2
      : 0.5;
    return pageIndex !== undefined && highlights.has(pageIndex) ? [{
      index, pageIndex, top, centerY: (top + bottom) / 2, centerX,
      number: source.citation_number,
      precision: !source.rects?.length ? '仅页码' : source.citation_precision === 'fragment' ? '片段高亮' : '原文高亮',
    }] : [];
  }).sort((a, b) => a.pageIndex - b.pageIndex || a.top - b.top);
  const firstEvidencePage = evidence[0]?.pageIndex;
  const firstEvidenceCenterY = evidence[0]?.centerY ?? 0.5;
  const firstEvidenceCenterX = evidence[0]?.centerX ?? 0.5;
  const canRead = preview !== null && availableWidth > 0;
  const initialViewport = preview?.initialPage.getViewport({ scale: 1 });
  const initialRatio = initialViewport ? initialViewport.width / initialViewport.height : 1;
  const firstEvidencePageReady = firstEvidencePage !== undefined && pages.has(firstEvidencePage + 1);

  useEffect(() => {
    let active = true;
    const task = getDocument({
      url,
      useWorkerFetch: false,
      CMapReaderFactory: CMapReader,
      StandardFontDataFactory: StandardFontReader,
    });
    void task.promise.then(async pdf => {
      if (!active) return;
      const wanted = preferredPage.current;
      const initialPage = await pdf.getPage(Number.isInteger(wanted) && wanted > 0 && wanted <= pdf.numPages ? wanted : 1);
      if (!active) return;
      setPages(new Map([[initialPage.pageNumber, initialPage]]));
      setPreview({ pdf, initialPage });
      if (onNavigation) {
        onNavigation({ totalPages: pdf.numPages, bookmarks: [] });
        void readBookmarks(pdf).catch(() => []).then(bookmarks => {
          if (active) onNavigation({ totalPages: pdf.numPages, bookmarks });
        });
      }
    }).catch(() => { if (active) onError(); });
    return () => {
      active = false;
      void task.destroy().catch(() => {});
    };
  }, [url, onError, onNavigation]);

  useLayoutEffect(() => {
    if (!scroller) return;
    const measure = () => {
      setAvailableWidth(Math.max(0, scroller.clientWidth - 16));
      setViewportHeight(scroller.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  useLayoutEffect(() => {
    if (!scroller || !canRead || firstEvidencePage === undefined) return;
    jumpToEvidence(scroller, firstEvidencePage, firstEvidenceCenterY, firstEvidenceCenterX);
  }, [scroller, canRead, selectionId, viewportHeight, firstEvidencePage, firstEvidencePageReady, firstEvidenceCenterY, firstEvidenceCenterX]);

  useEffect(() => {
    if (!scroller || !canRead || !pageJump) return;
    if (pageJump.pageIndex < 0 || pageJump.pageIndex >= totalPages) return;
    if (!pageJump.title) {
      scrollToPdfPosition(scroller, pageJump.pageIndex, 0, 8);
      return;
    }
    let active = true;
    const title = pageJump.title;
    // Bring the target into view while its page dimensions and heading load.
    scrollToPdfPosition(scroller, pageJump.pageIndex, 0, 8);
    void requestPage(pageJump.pageIndex + 1).then(async page => {
      const viewport = page.getViewport({ scale: 1 });
      const { x, y } = pageJump.destination ?? {};
      const hasDestinationY = page.rotate % 180 === 0 ? y !== undefined : x !== undefined;
      const destinationY = hasDestinationY
        ? viewport.convertToViewportPoint(x ?? page.view[0], y ?? page.view[3])[1] / viewport.height
        : undefined;
      return await findHeading(page, title, destinationY).catch(() => undefined) ?? destinationY;
    }).catch(() => undefined).then(top => {
      if (!active) return;
      if (top === undefined) {
        scrollToPdfPosition(scroller, pageJump.pageIndex, 0, 8);
      } else {
        scrollToPdfPosition(scroller, pageJump.pageIndex, Math.max(0, Math.min(1, top)), scroller.clientHeight / 2);
      }
    });
    return () => { active = false; };
  }, [canRead, pageJump, totalPages, requestPage, scroller]);

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
          <span>{totalPages ? `全文 · ${totalPages} 页` : 'PDF 全文'}</span>
          <button type="button" aria-label="缩小 PDF" className="rounded border px-2"
            disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value / 1.1))}>−</button>
          <button type="button" className="rounded border px-2" title="恢复适合宽度"
            onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label="放大 PDF" className="rounded border px-2"
            disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value * 1.1))}>+</button>
          <span className="text-xs text-gray-500 dark:text-slate-400">Ctrl + 滚轮缩放</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">打开原文件</a>
          {onCreateAnnotation && (
            <>
              <span className="mx-1 h-4 w-px bg-gray-300 dark:bg-slate-600" />
              <span className="text-xs text-gray-500 dark:text-slate-400">标注：</span>
              {(['highlight', 'underline'] as const).map(kind => (
                <button
                  key={kind}
                  type="button"
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    annotationMode === kind
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-gray-300 hover:bg-gray-100 dark:border-slate-600 dark:hover:bg-slate-700'
                  }`}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => {
                    const next = annotationMode === kind ? null : kind;
                    setAnnotationMode(next);
                    if (next) applyCurrentSelection(next);
                  }}
                >
                  {kind === 'highlight' ? '高亮' : '下划线'}
                </button>
              ))}
              {annotationMode && <span className="text-xs text-gray-500 dark:text-slate-400">用鼠标选中文字即可标注</span>}
            </>
          )}
        </div>
        {evidence.length > 0 && (
          <div className="flex max-h-24 flex-wrap items-center gap-2 overflow-auto" aria-label="引用片段">
            <span className="text-xs text-gray-500 dark:text-slate-400">跳转到命中片段：</span>
            {evidence.map(({ index, pageIndex, centerY, centerX, number, precision }) => (
              <button key={index} type="button" onClick={() => jumpToEvidence(scroller, pageIndex, centerY, centerX)}
                className="rounded border border-yellow-500 px-2 py-1 hover:bg-yellow-100 hover:text-slate-950">
                {number === undefined ? `片段 ${index + 1}` : `[${number}]`} · 第 {pageIndex + 1} 页 · {precision}
              </button>
            ))}
          </div>
        )}
      </div>
      <div ref={setScroller} tabIndex={0} aria-label="PDF 全文页面"
        className="min-h-0 flex-1 overflow-auto overscroll-contain rounded bg-slate-200 dark:bg-slate-800">
        {!canRead && <p role="status" className="p-3">正在加载 PDF 全文…</p>}
        {canRead && <div className="space-y-2 p-2" style={{
          width: Math.max(availableWidth, availableWidth * zoom) + 16,
          // Leave room to center evidence near the first and last page edges.
          paddingBlock: evidence.length ? Math.max(8, viewportHeight / 2) : undefined,
        }}>
          {Array.from({ length: totalPages }, (_, index) => (
            <PdfPage key={index + 1} page={pages.get(index + 1)} pageNumber={index + 1}
              ratio={initialRatio} requestPage={requestPage} scroller={scroller}
              width={availableWidth * zoom} rects={highlights.get(index) ?? emptyRects}
              annotations={annotationsByPage.get(index) ?? []}
              annotationMode={annotationMode}
              onSelect={onCreateAnnotation ? handleSelection : undefined} />
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

function jumpToEvidence(scroller: HTMLDivElement | null, pageIndex: number, y: number, x: number) {
  if (!scroller) return;
  scrollToPdfPosition(scroller, pageIndex, y, scroller.clientHeight / 2, x);
}

function scrollToPdfPosition(scroller: HTMLDivElement, pageIndex: number, top: number, offset: number, x?: number) {
  const element = scroller.querySelector(`[data-pdf-page="${pageIndex + 1}"]`);
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  scroller.scrollTop += rect.top + rect.height * top - viewport.top - offset;
  if (x !== undefined) {
    scroller.scrollLeft += rect.left + rect.width * x - viewport.left - scroller.clientWidth / 2;
  }
}
