import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Camera, Check, Crop, FileText, ImagePlus, Loader2, ScanLine, Smartphone, Trash2, X } from 'lucide-react';
import { Dropzone } from './Dropzone';
import { CornerEditor, fullCorners, type Corners } from './CornerEditor';
import { Badge, Button, cn } from '../ui';
import { useImport } from '../../state/importStore';
import { isTouchDevice } from '../../lib/wakeLock';
import { titleFromFileName } from '../../lib/songs';
import type { Gray, SheetReaderSupport } from '../../lib/omr';

/** Most pages read in one go from this screen (the reader takes up to 20; this keeps waits sensible). */
export const MAX_READ_PAGES = 10;
/** PDF pages shown as thumbnails to pick from. */
export const THUMB_PAGES = 30;
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

/** "about 2 min" for a number of seconds */
function aboutTime(sec: number): string {
  if (sec < 50) return `about ${Math.max(10, Math.round(sec / 10) * 10)} seconds`;
  const m = Math.round(sec / 60);
  return m <= 1 ? 'about a minute' : `about ${m} minutes`;
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
  thumbs: (string | null)[];
  selected: number[];
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
 * printed piano music read by the sheet-music reader (beta). PDFs: pick the pages. Photos: one page
 * per photo, each checked on the corner screen.
 */
export function SheetMusicTab({ busy, onScoreFile, onStarted }: { busy: boolean; onScoreFile: (f: File) => void; onStarted: () => void }) {
  const [touch] = useState(isTouchDevice);
  const [support, setSupport] = useState<SheetReaderSupport | null>(null);
  const [pdf, setPdf] = useState<PdfState | null>(null);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [opening, setOpening] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const importSheet = useImport((s) => s.importSheet);
  const cameraInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  /** where retaken / added photos go in the page order */
  const insertAt = useRef<number | null>(null);
  /** bumps when the user starts over: late results of an earlier PDF or photo are dropped */
  const session = useRef(0);

  useEffect(() => {
    let alive = true;
    loadOmr()
      .then((m) => alive && setSupport(m.sheetReaderSupport('photo')))
      .catch(() => alive && setSupport({ available: false, recommended: false, reason: 'The sheet-music reader could not be loaded. Check your connection and reload the page.', downloadMB: 0, memoryMB: 0, estSecondsPerPage: 0, threads: 1, phone: false }));
    return () => {
      alive = false;
      session.current++;
    };
  }, []);

  const canRead = !!support?.available;
  const mode: 'pick' | 'pdf' | 'photo' = pdf ? 'pdf' : photos.length || opening ? 'photo' : 'pick';

  const reset = () => {
    session.current++;
    setPdf(null);
    setPhotos([]);
    setEditing(null);
    setOpening(0);
    setError(null);
    insertAt.current = null;
  };

  const openPdf = async (file: File) => {
    reset();
    const my = session.current;
    setPdf({ file, count: null, thumbs: [], selected: [] });
    try {
      const omr = await loadOmr();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const count = await omr.pdfPageCount(bytes);
      if (session.current !== my) return;
      const shown = Math.min(count, THUMB_PAGES);
      setPdf({ file, count, thumbs: Array(shown).fill(null), selected: Array.from({ length: Math.min(count, MAX_READ_PAGES) }, (_, i) => i + 1) });
      // thumbnails, a few pages at a time so the first ones show quickly
      for (let p = 1; p <= shown; p += 6) {
        const batch = Array.from({ length: Math.min(6, shown - p + 1) }, (_, i) => p + i);
        const imgs = await omr.renderPdfPages(bytes, { pages: batch, width: 220 });
        if (session.current !== my) return;
        const urls = imgs.map((g) => grayUrl(omr, g, 220, 'image/png'));
        setPdf((cur) => (cur && cur.file === file ? { ...cur, thumbs: cur.thumbs.map((t, i) => (i + 1 >= p && i + 1 < p + batch.length ? urls[i + 1 - p] : t)) } : cur));
      }
    } catch (err) {
      if (session.current !== my) return;
      setPdf(null);
      setError((err as Error).message || 'This PDF could not be opened.');
    }
  };

  const addPhotos = async (files: File[]) => {
    setError(null);
    if (pdf) reset();
    const my = session.current;
    const at = insertAt.current;
    insertAt.current = null;
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
              ? `“${file.name}” is a HEIC photo, which this browser can’t open. Use Safari, or save the photo as JPEG first.`
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
      next.splice(at ?? next.length, 0, ...added);
      return next;
    });
    setEditing(added[0].id);
  };

  const onFiles = (files: File[]) => {
    if (busy) return;
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

  const takePhoto = (index: number | null = null) => {
    insertAt.current = index;
    (touch ? cameraInput : photoInput).current?.click();
  };

  const editingItem = photos.find((p) => p.id === editing) ?? null;
  const setCorners = (id: number, corners: Corners) => setPhotos((cur) => cur.map((p) => (p.id === id ? { ...p, corners } : p)));
  const confirm = (id: number) => {
    const next = photos.map((p) => (p.id === id ? { ...p, confirmed: true } : p));
    setPhotos(next);
    setEditing(next.find((p) => !p.confirmed)?.id ?? null);
  };
  const retake = (id: number) => {
    const i = photos.findIndex((p) => p.id === id);
    setPhotos((cur) => cur.filter((p) => p.id !== id));
    setEditing(null);
    takePhoto(i < 0 ? null : i);
  };
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
    const p = importSheet({ kind: 'pdf', file, fileName: file.name, pages: [...selected].sort((a, b) => a - b) });
    onStarted();
    reset();
    await p;
  };
  const readPhotos = async () => {
    if (!photos.length || busy) return;
    const omr = await loadOmr();
    const list = photos.map((p) => ({ blob: p.file as Blob, name: p.file.name, image: p.image, quad: omr.orderQuad(p.corners) }));
    const p = importSheet({ kind: 'photo', photos: list, fileName: photos[0].file.name, title: photoTitle(photos[0].file.name) });
    onStarted();
    reset();
    await p;
  };

  const nPages = mode === 'pdf' ? (pdf?.selected.length ?? 0) : photos.length;
  const estimate = support && nPages ? aboutTime(nPages * support.estSecondsPerPage) : null;
  const busyNote = busy ? 'Another import is still running — wait for it to finish (progress is shown above).' : null;

  return (
    <div className="flex flex-col gap-4">
      {/* hidden pickers: photos from the camera (phones) or from files */}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (e.target.files?.length && void addPhotos([...e.target.files]), (e.target.value = ''))} />
      <input ref={photoInput} type="file" accept="image/*,.heic,.heif" multiple className="hidden" onChange={(e) => (e.target.files?.length && void addPhotos([...e.target.files]), (e.target.value = ''))} />

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

      <BetaNote support={support} />

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
                  : `${pdf.count} pages — tap the pages to read (${pdf.selected.length} chosen).${pdf.count > MAX_READ_PAGES ? ` Up to ${MAX_READ_PAGES} pages at a time.` : ''}`}
              </p>
              {pdf.count > 1 && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setPdf({ ...pdf, selected: Array.from({ length: Math.min(pdf.count!, MAX_READ_PAGES) }, (_, i) => i + 1) })}>
                    {pdf.count > MAX_READ_PAGES ? `First ${MAX_READ_PAGES} pages` : 'All pages'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPdf({ ...pdf, selected: [] })}>
                    None
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {pdf.thumbs.map((url, i) => {
                  const page = i + 1;
                  const on = pdf.selected.includes(page);
                  const full = !on && pdf.selected.length >= MAX_READ_PAGES;
                  return (
                    <button
                      key={page}
                      type="button"
                      aria-pressed={on}
                      aria-label={`Page ${page}`}
                      disabled={full || pdf.count === 1}
                      title={full ? `Up to ${MAX_READ_PAGES} pages at a time` : undefined}
                      onClick={() => setPdf({ ...pdf, selected: on ? pdf.selected.filter((p) => p !== page) : [...pdf.selected, page].sort((a, b) => a - b) })}
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
              {pdf.count > THUMB_PAGES && <p className="text-[12px] text-ink-400">Only the first {THUMB_PAGES} pages are shown. For a later part, save those pages as their own PDF.</p>}
            </>
          )}
          <ReadBar
            label={pdf.selected.length === 1 ? 'Read 1 page' : `Read ${pdf.selected.length} pages`}
            disabled={busy || !pdf.count || !pdf.selected.length}
            onRead={() => void readPdf()}
            estimate={estimate}
            pages={pdf.selected.length}
            support={support}
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
              {photos.length < MAX_READ_PAGES ? (
                <div className="flex flex-wrap gap-2">
                  {touch && (
                    <Button icon={<Camera size={15} />} onClick={() => takePhoto()}>
                      Photo of the next page
                    </Button>
                  )}
                  <Button variant={touch ? 'ghost' : 'secondary'} icon={<ImagePlus size={15} />} onClick={() => ((insertAt.current = null), photoInput.current?.click())}>
                    {touch ? 'Choose from photos' : 'Add the next page'}
                  </Button>
                </div>
              ) : (
                <p className="text-[12px] text-ink-400">Up to {MAX_READ_PAGES} pages at a time.</p>
              )}
              {photos.length > 0 && (
                <ReadBar
                  label={photos.length === 1 ? 'Read 1 page' : `Read ${photos.length} pages`}
                  disabled={busy || !photos.length || opening > 0}
                  onRead={() => void readPhotos()}
                  estimate={estimate}
                  pages={photos.length}
                  support={support}
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
          <p className="text-[12px] text-ink-400">From other notation apps, save or export as MusicXML — it is exact, unlike reading a PDF.</p>
        </>
      )}
    </div>
  );
}

/** The Beta label, what the reader is good at, and this device's advice (phones: time and memory). */
function BetaNote({ support }: { support: SheetReaderSupport | null }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-ink-700 bg-ink-900/60 p-3">
      <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink-50">
        <ScanLine size={15} className="text-accent-400" /> PDFs and photos of sheet music
        <Badge tone="warn">Beta</Badge>
      </p>
      <p className="text-[12.5px] text-ink-200">Works best with clear printed piano music. Check the notes afterwards.</p>
      {support && !support.available && <p className="text-[12px] text-bad">{support.reason}</p>}
      {support?.available && !support.recommended && support.reason && (
        <p className="flex gap-1.5 text-[12px] text-ink-300">
          <Smartphone size={13} className="mt-0.5 shrink-0 text-accent-400" /> {support.reason}
        </p>
      )}
      <p className="text-[12px] text-ink-400">
        The reader ({support?.downloadMB ?? 24} MB) is downloaded once, the first time, and runs on your device.{' '}
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
  support: SheetReaderSupport | null;
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
      {support?.phone && pages > 3 && <p className="text-[12px] text-ink-300">On a phone, reading a few pages at a time is safer. Keep this page open; the screen stays on.</p>}
      {note && <p className="text-[11.5px] text-ink-400">{note}</p>}
    </div>
  );
}
