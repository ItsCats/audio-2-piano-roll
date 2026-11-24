import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, Camera, Check, Crop, FileText, ImagePlus, Loader2, ScanLine, Smartphone, Trash2, X } from 'lucide-react';
import { Dropzone } from './Dropzone';
import { CornerEditor, fullCorners, type Corners } from './CornerEditor';
import { Badge, Button, cn } from '../ui';
import { useImport } from '../../state/importStore';
import { isTouchDevice } from '../../lib/wakeLock';
import { titleFromFileName } from '../../lib/songs';
import type { Gray, PdfDocument, SheetReaderSupport } from '../../lib/omr';
// small: sizes and estimates only (the accurate reader's code loads when it reads)
import { homrReaderSupport, type ReaderSupport } from '../../lib/omr/homr/support';
import { readerFacts, readerTime, readerMayBeTooHeavy, sheetReaderChoice, SHEET_READER_INFO, type SheetReaderId } from '../../lib/omr/readers';
import { pageDeviceInfo } from '../../lib/transcription/backendChoice';
import type { TempoUnit } from '../../lib/music/types';
import type { ImportTempo } from '../../lib/score';
import type { PageTempo } from '../../lib/score/pageTempo';
import { TEMPO_UNITS, UNIT_LABEL, UNIT_NAME, tempoNumber } from '../../lib/sheet/tempoUnits';

/** Most pages read in one go from this screen (the reader takes up to 20; this keeps waits sensible). */
export const MAX_READ_PAGES = 10;
/** On phones: about 50 s per page, and the tab may be ended for memory; a few pages at a time. */
export const MAX_PHONE_PAGES = 3;
/** PDF pages shown as thumbnails at first, and added by each "Show more pages". */
export const THUMB_PAGES = 30;

/** Most pages per read on this device. */
export const maxPagesFor = (support: Pick<SheetReaderSupport, 'phone'> | null): number => (support?.phone ? MAX_PHONE_PAGES : MAX_READ_PAGES);

/** Photos chosen with room for `room` more pages: the ones kept, and a plain note when some were left out. */
export function capPhotos<T>(files: T[], room: number, max: number): { keep: T[]; note: string | null } {
  const keep = files.slice(0, Math.max(0, room));
  if (keep.length === files.length) return { keep, note: null };
  return {
    keep,
    note: keep.length
      ? `Only the first ${keep.length === 1 ? 'photo was' : `${keep.length} photos were`} added: up to ${max} pages can be read at a time.`
      : `Up to ${max} pages can be read at a time. Read these first, or remove a page to add another.`,
  };
}
/** Longest side of a photo's preview on the corner screen, px. */
const PREVIEW_SIDE = 1400;

type Omr = typeof import('../../lib/omr');
let omrModule: Promise<Omr> | null = null;
/** the reader's code loads only when this tab is used */
const loadOmr = (): Promise<Omr> =>
  (omrModule ??= import('../../lib/omr').catch((err) => {
    omrModule = null;
    throw err;
  }));

export const isPdfFile = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
export const isImageFile = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(f.name);
const isHeic = (f: File) => /\.hei[cf]$/i.test(f.name) || /hei[cf]/i.test(f.type);

/** A gray image as a JPEG / PNG data URL (previews and thumbnails). */
function grayUrl(omr: Omr, img: Gray, maxSide: number, type = 'image/jpeg'): string {
  const g = omr.shrink(img, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = g.w;
  canvas.height = g.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const data = ctx.createImageData(g.w, g.h);
  for (let i = 0, j = 0; i < g.d.length; i++, j += 4) {
    data.data[j] = data.data[j + 1] = data.data[j + 2] = g.d[i];
    data.data[j + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  const url = canvas.toDataURL(type, 0.85);
  canvas.width = canvas.height = 0;
  return url;
}

/** Song title for photos: the file name, unless it is a camera's own name (IMG_1234). */
function photoTitle(name: string): string {
  const t = titleFromFileName(name);
  return /^(img|image|photo|pxl|dsc|dcim|scan|cam|whatsapp)[\s_-]*\d/i.test(t) || /^\d+$/.test(t) || t === 'Untitled' ? 'Sheet music (photo)' : t;
}

interface PdfState {
  file: File;
  /** null: still opening */
  count: number | null;
  /** thumbnails of the first pages (null: still drawing) */
  thumbs: (string | null)[];
  selected: number[];
  /** a page was tapped while the most pages were already chosen */
  full?: boolean;
}

interface PhotoItem {
  id: number;
  file: File;
  image: Gray;
  preview: string;
  corners: Corners;
  /** corners the reader suggested (null: none found) */
  auto: Corners | null;
  /** "Looks good" pressed */
  confirmed: boolean;
}

let photoSeq = 1;

/**
 * The "MIDI / Sheet music" tab: sheet-music files and MIDI as before, plus PDFs and photos of
 * printed piano music read by a sheet-music reader (Accurate or Quick). PDFs: pick the pages. Photos: one page
 * per photo, each checked on the corner screen.
 */
export function SheetMusicTab({ busy, onScoreFile, onStarted }: { busy: boolean; onScoreFile: (f: File) => void; onStarted: () => void }) {
  const [touch] = useState(isTouchDevice);
  const [support, setSupport] = useState<SheetReaderSupport | null>(null);
  const [accurate] = useState<ReaderSupport>(() => homrReaderSupport());
  const [device] = useState(pageDeviceInfo);
  const readerPref = useImport((s) => s.prefs.sheetReader);
  const setReaderPref = useImport((s) => s.setSheetReaderPref);
  // the remembered pick, else accurate on computers and quick on phones / low-memory devices
  const reader: SheetReaderId = sheetReaderChoice(readerPref, device, { accurate: accurate.available, quick: support ? support.available : undefined });
  const [pdf, setPdf] = useState<PdfState | null>(null);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [opening, setOpening] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tempo, setTempo] = useState<TempoEntry>(NO_TEMPO);
  const importSheet = useImport((s) => s.importSheet);
  const cameraInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  /** where the next chosen photos go: a page to replace (Retake; kept until a photo arrives) or the end */
  const target = useRef<{ replaceId: number } | null>(null);
  /** bumps when the user starts over: late results of an earlier PDF or photo are dropped */
  const session = useRef(0);
  /** the PDF open for the page picker (one copy, closed when it is no longer shown) */
  const pdfDoc = useRef<PdfDocument | null>(null);
  const photosNow = useRef<PhotoItem[]>(photos);
  photosNow.current = photos;

  const closePdf = () => {
    const d = pdfDoc.current;
    pdfDoc.current = null;
    void d?.close();
  };

  useEffect(() => {
    let alive = true;
    loadOmr()
      .then((m) => alive && setSupport(m.sheetReaderSupport('photo')))
      .catch(() => alive && setSupport({ available: false, recommended: false, reason: 'The sheet-music reader could not be loaded. Check your connection and reload the page.', downloadMB: 0, memoryMB: 0, estSecondsPerPage: 0, threads: 1, phone: false }));
    return () => {
      alive = false;
      session.current++;
      closePdf();
    };
  }, []);

  // pages are prepared with the quick reader's module (PDF.js, photos), so it is needed for both readers
  const canRead = !!support?.available && (reader === 'quick' || accurate.available);
  const chosen: Pick<SheetReaderSupport, 'estSecondsPerPage' | 'phone'> | null = reader === 'accurate' ? accurate : support;
  const maxPages = maxPagesFor(support);
  const mode: 'pick' | 'pdf' | 'photo' = pdf ? 'pdf' : photos.length || opening ? 'photo' : 'pick';

  const reset = () => {
    session.current++;
    closePdf();
    setPdf(null);
    setPhotos([]);
    setEditing(null);
    setOpening(0);
    setError(null);
    setTempo(NO_TEMPO);
    target.current = null;
  };

  /** draws thumbnails from..to (1-based) one page at a time, so the first ones show quickly */
  const drawThumbs = async (omr: Omr, doc: PdfDocument, file: File, from: number, to: number, my: number) => {
    for (let p = from; p <= to; p++) {
      if (session.current !== my || pdfDoc.current !== doc) return;
      let url: string;
      try {
        url = grayUrl(omr, await doc.render(p, 220), 220, 'image/png');
      } catch {
        if (session.current !== my || pdfDoc.current !== doc) return;
        url = '';
      }
      if (session.current !== my) return;
      setPdf((cur) => (cur && cur.file === file ? { ...cur, thumbs: cur.thumbs.map((t, i) => (i + 1 === p ? url : t)) } : cur));
    }
  };

  const openPdf = async (file: File) => {
    reset();
    const my = session.current;
    setPdf({ file, count: null, thumbs: [], selected: [] });
    try {
      const omr = await loadOmr();
      const doc = await omr.openPdf(new Uint8Array(await file.arrayBuffer()));
      if (session.current !== my) {
        void doc.close();
        return;
      }
      pdfDoc.current = doc;
      // the tempo printed on the first page, when the PDF has its text (typeset, not scanned)
      void doc
        .tempo(1)
        .then((found) => {
          if (found && session.current === my) setTempo((cur) => (cur.edited ? cur : { value: tempoNumber(found.bpm), unit: found.unit, found, edited: false }));
        })
        .catch(() => undefined);
      const count = doc.numPages;
      const shown = Math.min(count, THUMB_PAGES);
      setPdf({ file, count, thumbs: Array(shown).fill(null), selected: Array.from({ length: Math.min(count, maxPages) }, (_, i) => i + 1) });
      await drawThumbs(omr, doc, file, 1, shown, my);
    } catch (err) {
      if (session.current !== my) return;
      closePdf();
      setPdf(null);
      setError((err as Error).message || 'This PDF could not be opened.');
    }
  };

  const showMorePages = async () => {
    const doc = pdfDoc.current;
    if (!pdf?.count || !doc) return;
    const from = pdf.thumbs.length + 1;
    const to = Math.min(pdf.count, pdf.thumbs.length + THUMB_PAGES);
    setPdf({ ...pdf, thumbs: [...pdf.thumbs, ...Array<string | null>(to - from + 1).fill(null)] });
    await drawThumbs(await loadOmr(), doc, pdf.file, from, to, session.current);
  };

  const addPhotos = async (all: File[]) => {
    setError(null);
    if (pdf) reset();
    const my = session.current;
    const replaceId = target.current?.replaceId ?? null;
    target.current = null;
    const replacing = replaceId !== null && photosNow.current.some((p) => p.id === replaceId);
    // only as many photos as can be read at once
    const { keep: files, note } = capPhotos(all, maxPages - photosNow.current.length + (replacing ? 1 : 0), maxPages);
    if (note) setError(note);
    if (!files.length) return;
    setOpening((n) => n + files.length);
    const added: PhotoItem[] = [];
    try {
      const omr = await loadOmr();
      for (const file of files) {
        try {
          const { image, quad } = await omr.loadPhoto(file);
          if (session.current !== my) return;
          const auto = quad ? quad.map((c) => [c[0], c[1]] as [number, number]) : null;
          added.push({ id: photoSeq++, file, image, preview: grayUrl(omr, image, PREVIEW_SIDE), corners: auto ?? fullCorners(image.w, image.h), auto, confirmed: false });
        } catch {
          if (session.current !== my) return;
          setError(
            isHeic(file)
              ? `“${file.name}” is in HEIC format, which this browser can’t open. Choose it again from the Photos app, or save it as JPEG.`
              : `“${file.name}” could not be opened as a photo. Please use a JPEG or PNG picture.`,
          );
        } finally {
          if (session.current === my) setOpening((n) => Math.max(0, n - 1));
        }
      }
    } catch (err) {
      if (session.current === my) {
        setOpening(0);
        setError((err as Error).message);
      }
      return;
    }
    if (session.current !== my || !added.length) return;
    setPhotos((cur) => {
      const next = [...cur];
      // Retake: the new photo takes the old one's place (the old one stays until a new one arrives)
      const at = replaceId === null ? -1 : next.findIndex((p) => p.id === replaceId);
      if (at >= 0) next.splice(at, 1, ...added);
      else next.push(...added);
      return next;
    });
    setEditing(added[0].id);
  };

  const onFiles = (files: File[]) => {
    if (busy) {
      setError('Another song is still being worked on. Wait for it to finish (it’s shown above).');
      return;
    }
    setError(null);
    const pdfs = files.filter(isPdfFile);
    const images = files.filter((f) => !isPdfFile(f) && isImageFile(f));
    const others = files.filter((f) => !isPdfFile(f) && !isImageFile(f));
    if ((pdfs.length || images.length) && !canRead) {
      setError(support?.reason ?? 'The sheet-music reader is still loading. Try again in a moment.');
      return;
    }
    if (pdfs.length) {
      if (pdfs.length > 1 || images.length || others.length) setError('Please choose one PDF at a time.');
      void openPdf(pdfs[0]);
    } else if (images.length) {
      if (others.length) setError('Only the photos were added. Import other files one at a time.');
      void addPhotos(images);
    } else if (others[0]) {
      if (others.length > 1) setError('Please choose one file at a time.');
      onScoreFile(others[0]);
    }
  };

  const takePhoto = (replaceId: number | null = null) => {
    target.current = replaceId === null ? null : { replaceId };
    (touch ? cameraInput : photoInput).current?.click();
  };

  const editingItem = photos.find((p) => p.id === editing) ?? null;
  const setCorners = (id: number, corners: Corners) => setPhotos((cur) => cur.map((p) => (p.id === id ? { ...p, corners } : p)));
  const confirm = (id: number) => {
    const next = photos.map((p) => (p.id === id ? { ...p, confirmed: true } : p));
    setPhotos(next);
    setEditing(next.find((p) => !p.confirmed)?.id ?? null);
  };
  // the photo stays (with its corners and place) until a new one actually arrives: cancelling the
  // camera or picker changes nothing
  const retake = (id: number) => takePhoto(id);
  const remove = (id: number) => setPhotos((cur) => cur.filter((p) => p.id !== id));
  const move = (i: number, d: -1 | 1) =>
    setPhotos((cur) => {
      const next = [...cur];
      const j = i + d;
      if (j < 0 || j >= next.length) return cur;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const readPdf = async () => {
    if (!pdf || !pdf.selected.length || busy) return;
    const { file, selected } = pdf;
    const p = importSheet({ kind: 'pdf', file, fileName: file.name, pages: [...selected].sort((a, b) => a - b).slice(0, maxPages) }, { reader, ...withTempo(tempo) });
    onStarted();
    reset();
    await p;
  };
  const readPhotos = async () => {
    if (!photos.length || photos.length > maxPages || busy) return;
    const omr = await loadOmr();
    const list = photos.map((p) => ({ blob: p.file as Blob, name: p.file.name, image: p.image, quad: omr.orderQuad(p.corners) }));
    const p = importSheet({ kind: 'photo', photos: list, fileName: photos[0].file.name, title: photoTitle(photos[0].file.name) }, { reader, ...withTempo(tempo) });
    onStarted();
    reset();
    await p;
  };

  const nPages = mode === 'pdf' ? (pdf?.selected.length ?? 0) : photos.length;
  const estimate = chosen && nPages ? readerTime(reader, nPages * chosen.estSecondsPerPage) : null;
  const busyNote = busy ? 'Another song is still being worked on. Wait for it to finish (it’s shown above).' : null;

  return (
    <div className="flex flex-col gap-4">

      {mode === 'pick' && (
        <>
          <Dropzone onFiles={onFiles} multiple accept="">
            <p className="text-[15px] font-medium text-ink-50">Drop a MIDI or sheet-music file, a PDF or photos</p>
            <p className="text-[12.5px] text-ink-300">MIDI · MusicXML · MuseScore · PDF · JPEG / PNG photos</p>
          </Dropzone>
          {touch && (
            <Button size="lg" icon={<Camera size={18} />} disabled={busy || !canRead} onClick={() => takePhoto()} className="w-full sm:w-auto sm:self-start">
              Take a photo of sheet music
            </Button>
          )}
        </>
      )}

      <ReaderNote support={support} accurate={accurate} reader={reader} onReader={setReaderPref} disabled={busy} />

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad">
          <X size={15} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {mode === 'pdf' && pdf && (
        <div className="flex flex-col gap-3" data-testid="pdf-pages">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-2 text-[14px] font-medium text-ink-50">
              <FileText size={16} className="shrink-0 text-accent-400" />
              <span className="truncate">{pdf.file.name}</span>
            </p>
            <Button size="sm" variant="ghost" onClick={reset}>
              Choose another file
            </Button>
          </div>
          {pdf.count === null ? (
            <p className="flex items-center gap-2 text-[13px] text-ink-300">
              <Loader2 size={15} className="animate-spin" /> Opening the PDF…
            </p>
          ) : (
            <>
              <p className="text-[12.5px] text-ink-300">
                {pdf.count === 1
                  ? 'One page.'
                  : `${pdf.count} pages. Tap the ones to read (${pdf.selected.length} picked).${pdf.count > maxPages ? ` Up to ${maxPages} pages at a time${support?.phone ? ' on a phone' : ''}.` : ''}`}
              </p>
              {pdf.count > 1 && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setPdf({ ...pdf, full: false, selected: Array.from({ length: Math.min(pdf.count!, maxPages) }, (_, i) => i + 1) })}>
                    {pdf.count > maxPages ? `First ${maxPages} pages` : 'All pages'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPdf({ ...pdf, full: false, selected: [] })}>
                    None
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {pdf.thumbs.map((url, i) => {
                  const page = i + 1;
                  const on = pdf.selected.includes(page);
                  const full = !on && pdf.selected.length >= maxPages;
                  return (
                    <button
                      key={page}
                      type="button"
                      aria-pressed={on}
                      aria-label={`Page ${page}`}
                      aria-disabled={full || undefined}
                      disabled={pdf.count === 1}
                      title={full ? `Up to ${maxPages} pages at a time` : undefined}
                      // a page tapped while the most are chosen says why instead of doing nothing (touch has no tooltips)
                      onClick={() =>
                        full
                          ? setPdf({ ...pdf, full: true })
                          : setPdf({ ...pdf, full: false, selected: on ? pdf.selected.filter((p) => p !== page) : [...pdf.selected, page].sort((a, b) => a - b) })
                      }
                      className={cn(
                        'focus-ring relative overflow-hidden rounded-lg border-2 bg-white transition-opacity disabled:cursor-default',
                        on ? 'border-accent-500' : 'border-ink-700 opacity-40 grayscale hover:opacity-70',
                        full && 'opacity-35',
                      )}
                    >
                      {url ? <img src={url} alt="" className="block aspect-[0.71] w-full object-contain" /> : <div className="flex aspect-[0.71] w-full items-center justify-center bg-ink-800"><Loader2 size={16} className="animate-spin text-ink-400" /></div>}
                      <span className={cn('absolute right-1 bottom-1 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold', on ? 'bg-accent-500 text-white' : 'bg-black/60 text-ink-100')}>
                        {on ? <Check size={13} /> : page}
                      </span>
                      {on && <span className="absolute top-1 left-1 rounded bg-black/60 px-1 text-[10.5px] text-ink-50">{page}</span>}
                    </button>
                  );
                })}
              </div>
              {pdf.full && (
                <p role="status" className="text-[12.5px] text-warn">
                  Up to {maxPages} pages can be read at a time{support?.phone ? ' on a phone' : ''}. Tap a chosen page to remove it first, then choose another.
                </p>
              )}
              {pdf.count > pdf.thumbs.length && (
                <Button size="sm" variant="secondary" className="self-start" onClick={() => void showMorePages()}>
                  Show more pages ({pdf.thumbs.length + 1}–{Math.min(pdf.count, pdf.thumbs.length + THUMB_PAGES)} of {pdf.count})
                </Button>
              )}
            </>
          )}
          <TempoField tempo={tempo} onChange={setTempo} disabled={busy} />
          <ReadBar
            label={pdf.selected.length === 1 ? 'Read 1 page' : `Read ${pdf.selected.length} pages`}
            disabled={busy || !pdf.count || !pdf.selected.length || !tempoOk(tempo)}
            onRead={() => void readPdf()}
            estimate={estimate}
            pages={pdf.selected.length}
            support={chosen}
            note={busyNote}
          />
        </div>
      )}

      {mode === 'photo' && (
        <div className="flex flex-col gap-3" data-testid="photo-pages">
          {editingItem ? (
            <CornerEditor
              key={editingItem.id}
              preview={editingItem.preview}
              width={editingItem.image.w}
              height={editingItem.image.h}
              corners={editingItem.corners}
              onChange={(c) => setCorners(editingItem.id, c)}
              onDone={() => confirm(editingItem.id)}
              onRetake={() => retake(editingItem.id)}
              retakeLabel={touch ? 'Retake' : 'Choose another photo'}
              onReset={() => setCorners(editingItem.id, fullCorners(editingItem.image.w, editingItem.image.h))}
              label={photos.length > 1 ? `Page ${photos.findIndex((p) => p.id === editingItem.id) + 1}: adjust the corners` : undefined}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[14px] font-medium text-ink-50">{photos.length === 1 ? '1 page' : `${photos.length} pages`}, in this order</p>
                <Button size="sm" variant="ghost" onClick={reset}>
                  Start over
                </Button>
              </div>
              <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {photos.map((p, i) => (
                  <li key={p.id} className="flex flex-col gap-1.5 rounded-xl border border-ink-700 bg-ink-900/60 p-2">
                    <div className="relative overflow-hidden rounded-lg bg-black/40">
                      <img src={p.preview} alt={`Page ${i + 1}`} className="block aspect-[0.75] w-full object-contain" />
                      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${p.image.w} ${p.image.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
                        <polygon points={p.corners.map((c) => c.join(',')).join(' ')} fill="none" stroke="#8aa2ff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      </svg>
                      <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 text-[11px] font-semibold text-ink-50">Page {i + 1}</span>
                    </div>
                    <div className="flex items-center justify-between gap-0.5">
                      <button type="button" className="focus-ring flex h-9 items-center gap-1 rounded-md px-1.5 text-[12px] text-accent-300 hover:bg-ink-800" onClick={() => setEditing(p.id)}>
                        <Crop size={14} /> Corners
                      </button>
                      <span className="flex">
                        <button type="button" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)} className="focus-ring flex h-9 w-8 items-center justify-center rounded-md text-ink-200 hover:bg-ink-800 disabled:opacity-30">
                          <ArrowLeft size={15} />
                        </button>
                        <button type="button" aria-label="Move later" disabled={i === photos.length - 1} onClick={() => move(i, 1)} className="focus-ring flex h-9 w-8 items-center justify-center rounded-md text-ink-200 hover:bg-ink-800 disabled:opacity-30">
                          <ArrowRight size={15} />
                        </button>
                        <button type="button" aria-label="Remove" onClick={() => remove(p.id)} className="focus-ring flex h-9 w-8 items-center justify-center rounded-md text-ink-200 hover:bg-ink-800 hover:text-bad">
                          <Trash2 size={15} />
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
                {opening > 0 && (
                  <li className="flex aspect-[0.75] items-center justify-center rounded-xl border border-dashed border-ink-700 text-[12.5px] text-ink-300">
                    <Loader2 size={15} className="mr-2 animate-spin" /> Opening…
                  </li>
                )}
              </ol>
              {photos.length < maxPages ? (
                <div className="flex flex-wrap gap-2">
                  {touch && (
                    <Button icon={<Camera size={15} />} onClick={() => takePhoto()}>
                      Photo of the next page
                    </Button>
                  )}
                  <Button variant={touch ? 'ghost' : 'secondary'} icon={<ImagePlus size={15} />} onClick={() => ((target.current = null), photoInput.current?.click())}>
                    {touch ? 'Choose from photos' : 'Add the next page'}
                  </Button>
                </div>
              ) : (
                <p className="text-[12px] text-ink-400">
                  Up to {maxPages} pages at a time{support?.phone ? ' on a phone' : ''}.{photos.length > maxPages ? ' Remove a page to read these.' : ''}
                </p>
              )}
              {photos.length > 0 && <TempoField tempo={tempo} onChange={setTempo} disabled={busy} />}
              {photos.length > 0 && (
                <ReadBar
                  label={photos.length === 1 ? 'Read 1 page' : `Read ${photos.length} pages`}
                  disabled={busy || !photos.length || photos.length > maxPages || opening > 0 || !tempoOk(tempo)}
                  onRead={() => void readPhotos()}
                  estimate={estimate}
                  pages={photos.length}
                  support={chosen}
                  note={busyNote}
                />
              )}
            </>
          )}
          {!editingItem && !photos.length && opening > 0 && (
            <p className="flex items-center gap-2 text-[13px] text-ink-300">
              <Loader2 size={15} className="animate-spin" /> Opening the photo…
            </p>
          )}
        </div>
      )}

      {mode === 'pick' && (
        <>
          <p className="text-[12.5px] text-ink-300">
            Notes from MIDI and sheet-music files are used exactly as written, and repeats are played in order. Hard is the piece as written; Easy and
            Medium are made simpler for you.
          </p>
          <p className="text-[12px] text-ink-400">Using another notation app? Export MusicXML from it. That’s exact, a PDF is only read as a guess.</p>
        </>
      )}

      {/* hidden pickers (after the drop zone's own file input): photos from the camera (phones) or from files */}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (e.target.files?.length && void addPhotos([...e.target.files]), (e.target.value = ''))} />
      {/* accept="image/*" only: listing .heic makes iPhones hand over HEIC files instead of converting them to JPEG */}
      <input ref={photoInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (e.target.files?.length && void addPhotos([...e.target.files]), (e.target.value = ''))} />
    </div>
  );
}

/**
 * The two readers to choose from (default: accurate on computers, quick on phones; the pick is
 * remembered), what each is good at, and this device's advice.
 */
function ReaderNote({
  support,
  accurate,
  reader,
  onReader,
  disabled,
}: {
  support: SheetReaderSupport | null;
  accurate: ReaderSupport;
  reader: SheetReaderId;
  onReader: (r: SheetReaderId) => void;
  disabled: boolean;
}) {
  const heavy = readerMayBeTooHeavy('accurate');
  const chosen = reader === 'accurate' ? accurate : support;
  const options: { id: SheetReaderId; facts: string; sub?: string; available: boolean }[] = [
    { id: 'accurate', facts: readerFacts('accurate', accurate), available: accurate.available },
    {
      id: 'quick',
      facts: readerFacts('quick', { downloadMB: support?.downloadMB ?? 24, estSecondsPerPage: support?.estSecondsPerPage ?? 30 }),
      sub: 'Smaller download, less accurate',
      available: support ? support.available : true,
    },
  ];
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3" data-testid="sheet-reader-choice">
      <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink-50">
        <ScanLine size={15} className="text-accent-400" /> PDFs and photos of sheet music
      </p>
      <p className="text-[12.5px] text-ink-200">Works best with clear printed music. Check the notes afterwards.</p>
      <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
        <legend className="sr-only">Sheet-music reader</legend>
        {options.map((o) => {
          const on = reader === o.id;
          const info = SHEET_READER_INFO[o.id];
          return (
            <label
              key={o.id}
              data-testid={`reader-${o.id}`}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-400',
                on ? 'border-accent-500 bg-accent-500/10' : 'border-ink-700 hover:border-ink-500',
                !o.available && 'cursor-not-allowed opacity-50',
              )}
            >
              <input type="radio" name="sheet-reader" value={o.id} checked={on} disabled={!o.available} onChange={() => onReader(o.id)} className="mt-1 accent-accent-500" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-ink-50">
                  {info.name}
                  {o.id === 'accurate' && !heavy && <Badge tone="accent">Recommended</Badge>}
                  {info.beta && <Badge tone="warn">Beta</Badge>}
                  {o.sub && <span className="text-[12px] font-normal text-ink-300">({o.sub})</span>}
                </span>
                <span className="text-[12px] text-ink-300">{o.facts}{accurate.phone ? ' on a phone' : ''}</span>
                {o.id === 'accurate' && heavy && (
                  <span className="flex gap-1.5 text-[12px] text-warn" data-testid="reader-heavy">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" /> May be too heavy for this phone; if the page reloads, use the Quick reader.
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
      {chosen && !chosen.available && <p className="text-[12px] text-bad">{chosen.reason}</p>}
      {/* low-memory computers: the quick reader's own advice (on phones the lines above already give the time) */}
      {reader === 'quick' && support?.available && !support.recommended && support.reason && !support.phone && (
        <p className="flex gap-1.5 text-[12px] text-ink-300">
          <Smartphone size={13} className="mt-0.5 shrink-0 text-accent-400" /> {support.reason}
        </p>
      )}
      {heavy && (
        <p className="flex gap-1.5 text-[12px] text-ink-300">
          <Smartphone size={13} className="mt-0.5 shrink-0 text-accent-400" /> Close other apps and tabs first. A computer is much faster.
        </p>
      )}
      <p className="text-[12px] text-ink-400">
        The reader is downloaded once, the first time, and runs on your device. The Accurate reader is based on{' '}
        <Link to="/credits#models" className="text-accent-400 hover:text-accent-300">
          homr (AGPL-3.0)
        </Link>
        .{' '}
        <Link to="/accuracy#sheet-reader" className="text-accent-400 hover:text-accent-300">
          How accurate is it?
        </Link>
      </p>
    </div>
  );
}

function ReadBar({
  label,
  disabled,
  onRead,
  estimate,
  pages,
  support,
  note,
}: {
  label: string;
  disabled: boolean;
  onRead: () => void;
  estimate: string | null;
  pages: number;
  support: Pick<SheetReaderSupport, 'phone'> | null;
  note: string | null;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-ink-700 pt-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" icon={<ScanLine size={17} />} disabled={disabled} onClick={onRead}>
          {label}
        </Button>
        {estimate && <span className="text-[12.5px] text-ink-300">Takes {estimate}{support?.phone ? ' on a phone' : ''}.</span>}
      </div>
      {support?.phone && pages > 1 && <p className="text-[12px] text-ink-300">Keep this page open while it reads; the screen stays on.</p>}
      {note && <p className="text-[11.5px] text-ink-400">{note}</p>}
    </div>
  );
}

/** The optional tempo on the read screen: typed, or found in the PDF's text (the readers read no tempo). */
interface TempoEntry {
  value: string;
  /** null: the beat of the time signature (a dotted quarter in 6/8, a half in 2/2), worked out once the page is read */
  unit: TempoUnit | null;
  /** found on the first page (pageTempo.ts) */
  found: PageTempo | null;
  /** changed by the user (a found tempo is then theirs) */
  edited: boolean;
}

const NO_TEMPO: TempoEntry = { value: '', unit: 'q', found: null, edited: false };

const tempoValue = (t: TempoEntry): number => parseFloat(t.value.replace(',', '.'));
/** Empty, or a usable number. */
const tempoOk = (t: TempoEntry): boolean => !t.value.trim() || (tempoValue(t) >= 20 && tempoValue(t) <= 400);

/** The tempo to import with (none: the page's or the default, set later in the Studio). */
function withTempo(t: TempoEntry): { tempo?: ImportTempo } {
  const n = tempoValue(t);
  if (!t.value.trim() || !(n >= 20 && n <= 400)) return {};
  if (t.found && !t.edited) return { tempo: { bpm: t.found.bpm, unit: t.found.unit, from: 'page', text: t.found.text, ...(t.found.guess ? { guess: true } : {}) } };
  return { tempo: { bpm: Math.round(n * 10) / 10, unit: t.unit, from: 'set' } };
}

/** The select's value for "the beat of the time signature". */
const METER_BEAT = 'meter';

function TempoField({ tempo, onChange, disabled }: { tempo: TempoEntry; onChange: (t: TempoEntry) => void; disabled: boolean }) {
  const bad = !tempoOk(tempo);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-ink-700 bg-ink-900/60 p-3" data-testid="import-tempo">
      <label htmlFor="import-tempo-input" className="text-[13px] font-medium text-ink-100">
        Tempo <span className="font-normal text-ink-400">(optional)</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={tempo.unit ?? METER_BEAT}
          disabled={disabled}
          onChange={(e) => onChange({ ...tempo, unit: e.target.value === METER_BEAT ? null : (e.target.value as TempoUnit), edited: true })}
          aria-label="Beat"
          data-testid="import-tempo-unit"
          className="focus-ring h-9 max-w-full rounded-[10px] border border-ink-600 bg-ink-800 px-2 text-[13px] text-ink-50"
        >
          <option value={METER_BEAT}>Beat of the time signature</option>
          {TEMPO_UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABEL[u]} {UNIT_NAME[u]}
            </option>
          ))}
        </select>
        <span className="text-ink-300">=</span>
        <input
          id="import-tempo-input"
          value={tempo.value}
          disabled={disabled}
          onChange={(e) => onChange({ ...tempo, value: e.target.value, edited: true })}
          inputMode="decimal"
          placeholder="120"
          aria-invalid={bad}
          data-testid="import-tempo-input"
          className={cn(
            'focus-ring h-9 w-24 rounded-[10px] border bg-ink-800 px-2.5 text-center font-mono text-[13px] text-ink-50',
            bad ? 'border-warn' : 'border-ink-600',
          )}
        />
        <span className="text-[12px] text-ink-300">per minute</span>
      </div>
      <p className="text-[11.5px] leading-snug text-ink-400" data-testid="import-tempo-note">
        {bad
          ? 'Enter a number between 20 and 400, or leave it empty.'
          : tempo.found && !tempo.edited
            ? `Found on the page: “${tempo.found.text}”${tempo.found.unit ? '' : ' (the note before the “=” wasn’t readable, so the number counts the main beat of the time signature)'}${tempo.found.guess ? ', a guess from the tempo word' : ''}. Change it if your page says otherwise.`
            : 'The reader reads the notes, not the tempo. Type the number next to the note at the top of your page (like ♩ = 72), or leave it empty to start at ♩ = 120. You can change it later in the Studio (Notes tab, Tempo).'}
      </p>
    </div>
  );
}
