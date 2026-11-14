import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, Circle, ArrowRight, Info, RotateCcw, Download, Smartphone, Gamepad2, Save } from 'lucide-react';
import { Button, ProgressBar, cn } from '../ui';
import { STAGE_LABELS, stageLabel, type FailedImport, type ImportJob, type ImportStage } from '../../state/importStore';
import { formatTime } from '../../lib/music/theory';
import { isTouchDevice } from '../../lib/wakeLock';
import { saveBlobAs } from '../../lib/saveBlob';
import { offerGame } from '../../lib/games/offer';

/** Timeline: the planned stages, with any unplanned stage that actually happened slotted in where it happened. */
export function timeline(job: ImportJob): ImportStage[] {
  const order = [...job.plan];
  job.history.forEach((st, i) => {
    if (st === 'done' || st === 'error' || order.includes(st)) return;
    // right after the stage that preceded it
    const prev = i > 0 ? order.indexOf(job.history[i - 1]) : -1;
    order.splice(prev + 1, 0, st);
  });
  return order;
}

export function formatEta(sec: number): string {
  if (sec < 15) return 'a few seconds left';
  if (sec < 60) return `about ${Math.round(sec / 5) * 5} s left`;
  const m = Math.round(sec / 60);
  return m <= 1 ? 'about 1 min left' : `about ${m} min left`;
}

/** "reading: 1 min left" → "Reading: 1 min left" (the sheet reader's plain progress line) */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The step the speed measurement covers ("separation", "pitch detection 1 of 2"): the ETA is for
 * this step only, so it says which one (more steps follow, see the checklist below the bar).
 */
export function etaStep(job: Pick<ImportJob, 'stage' | 'detail' | 'transcriber' | 'sheet'>): string {
  const part = job.detail?.match(/\((\d+) of (\d+)\)/);
  if (job.sheet) return job.stage === 'analyzing' ? 'reading' : job.stage === 'loading-model' ? 'download' : stageLabel(job, job.stage).toLowerCase();
  switch (job.stage) {
    case 'separating':
      return 'separation';
    case 'loading-model':
      return job.transcriber === 'piano-specialist' ? 'loading the piano model' : STAGE_LABELS[job.stage].toLowerCase();
    case 'piano-model':
      return 'piano model';
    case 'analyzing':
      if (job.transcriber === 'piano-specialist') return 'piano model';
      return part ? `pitch detection ${part[1]} of ${part[2]}` : 'pitch detection';
    case 'downloading':
      return 'download';
    case 'uploading':
      return 'upload';
    default:
      return STAGE_LABELS[job.stage].toLowerCase();
  }
}

/** time remaining in the current step, extrapolated from its measured speed (null until measured) */
export function etaText(job: ImportJob): string | null {
  const r = job.rate;
  if (!r || r.etaSec === undefined || r.at === undefined) return null;
  const left = r.etaSec - (Date.now() - r.at) / 1000;
  return `${etaStep(job)}: ${left > 0 ? formatEta(left) : 'finishing…'}`;
}

/**
 * An import's progress card: the bar, the time left, the checklist, warnings and, at the end, what to
 * do next. "Analyze again" jobs (job.reanalyze) show the same card with their own words.
 */
export function JobProgress({
  job,
  failed,
  onCancel,
  onDismiss,
  onOpen,
  onPlayGame,
  pianoModelSelected = false,
  scrollIntoView = true,
  className,
}: {
  job: ImportJob;
  /** the failed job's retry options (only used when it is this job's) */
  failed: FailedImport | null;
  onCancel: () => void;
  /** "Dismiss" / "Import another" (absent: no such button) */
  onDismiss?: () => void;
  /** "Open in Studio" for a finished job (absent: no such button) */
  onOpen?: (songId: string) => void;
  onPlayGame?: () => void;
  /** a failed high-accuracy run: "Try with the normal model" is offered while the high-accuracy one is still selected */
  pianoModelSelected?: boolean;
  /** bring a new job's card into view (on a phone the button that started it is far below) */
  scrollIntoView?: boolean;
  className?: string;
}) {
  const [touch] = useState(isTouchDevice);
  const [, force] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const jobId = job.id;
  useEffect(() => {
    if (scrollIntoView) card.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [jobId, scrollIntoView]);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const order = timeline(job);
  const failedStage = job.stage === 'error' ? job.history[job.history.length - 2] : null;
  const current = failedStage ?? job.stage;
  const activeIdx = order.indexOf(current);
  const eta = etaText(job);
  const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
  const done = job.stage === 'done';
  const err = job.stage === 'error';
  const failedHere = err && failed?.jobId === job.id ? failed : null;
  const re = job.reanalyze;
  const reFailure = re?.failure;
  const heading = re ? (done ? `“${job.title}” was analyzed again` : err ? `Analyzing “${job.title}” again failed` : `Analyzing “${job.title}” again`) : job.title;
  const status = done
    ? re
      ? 'New notes are ready'
      : job.kind === 'score' || job.kind === 'midi'
        ? 'Ready'
        : 'Transcription complete'
    : err
      ? re
        ? 'Analyze again failed'
        : 'Import failed'
      : job.detail
        ? `${job.detail}${job.sheet && job.stage !== 'saving' ? '…' : ''}`
        : stageLabel(job, job.stage);
  // (a failure that says it itself, or that the song is gone, has no "Your song wasn't changed." line)
  const unchangedLine = !!re && err && reFailure !== 'deleted' && reFailure !== 'quota' && reFailure !== 'quota-again';
  const saveWithoutOld = failedHere?.saveWithoutOld;
  // an "Analyze again" writing its new notes can't be stopped any more (importStore cancel)
  const cancellable = !done && !err && !(re && job.stage === 'saving');
  // the progress line in plain words (sheet music, "Analyze again"), or the import's compact one
  const plain = !!job.sheet || !!re;
  return (
    <div ref={card} data-import-card tabIndex={-1} className={cn('panel animate-fade-in scroll-mt-4 p-5 outline-none', className)} aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* (an "Analyze again" heading wraps: on a phone the song's name would be cut off) */}
          <p className={cn('text-[15px] font-semibold text-ink-50', re ? 'break-words' : 'truncate')}>{heading}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-300">
            {status} · {formatTime(elapsed)}
          </p>
        </div>
        {cancellable && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {!done && !err && (
        <div className="mt-4">
          <ProgressBar value={job.progress} />
          {touch && job.kind !== 'midi' && job.kind !== 'demo' && (job.kind !== 'score' || job.sheet) && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-300">
              <Smartphone size={13} className="shrink-0 text-accent-400" /> {job.sheet ? 'Keep this page open while it reads the music.' : 'Keep this page open while it’s analyzing.'}
            </p>
          )}
          {job.progress !== null && (
            <p className={cn('mt-1.5 flex justify-between gap-3 text-ink-300', plain ? 'text-[12px]' : 'font-mono text-[11px]')}>
              <span>
                {job.sheet
                  ? sentence(eta ?? (job.stage === 'analyzing' && job.progress < 0.99 ? 'Working out the time left…' : ''))
                  : re
                    ? sentence(eta ?? ((job.stage === 'separating' || job.stage === 'analyzing' || job.stage === 'piano-model') && job.progress < 0.99 ? `${etaStep(job)}: working out the time left…` : ''))
                    : (eta ?? ((job.stage === 'separating' || job.stage === 'analyzing' || job.stage === 'piano-model') && job.progress < 0.99 ? `${etaStep(job)}: measuring speed…` : ''))}
              </span>
              <span>{Math.round(job.progress * 100)}%</span>
            </p>
          )}
          {onPlayGame && offerGame(job, Date.now()) && (
            <Button size="sm" className="mt-3" onClick={onPlayGame} icon={<Gamepad2 size={15} />}>
              Play a game while you wait
            </Button>
          )}
        </div>
      )}
      <ol className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {order.map((st, i) => {
          const state = done ? 'done' : st === current ? (err ? 'failed' : 'active') : i < activeIdx || job.history.includes(st) ? 'done' : 'todo';
          return (
            <li key={st} className="flex items-center gap-2 text-[12.5px]">
              {state === 'done' ? (
                <CheckCircle2 size={14} className="text-ok" />
              ) : state === 'active' ? (
                <Loader2 size={14} className="animate-spin text-accent-400" />
              ) : state === 'failed' ? (
                <XCircle size={14} className="text-bad" />
              ) : (
                <Circle size={14} className="text-ink-500" />
              )}
              <span className={state === 'todo' ? 'text-ink-400' : 'text-ink-100'}>{stageLabel(job, st)}</span>
            </li>
          );
        })}
      </ol>
      {err && (
        <div className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">
          {unchangedLine && <p className="font-medium text-ink-50">Your song wasn’t changed.</p>}
          {job.errorTitle && <p className="font-medium text-ink-50">{job.errorTitle}</p>}
          <p>{job.error}</p>
        </div>
      )}
      {done && job.sheet && (
        <p className="mt-4 flex gap-2 text-[12.5px] text-ink-200">
          <Info size={14} className="mt-0.5 shrink-0 text-warn" /> Read from sheet music{job.sheetReader === 'accurate' ? '' : ' (Beta)'} — check the notes against your page.
        </p>
      )}
      {job.warnings.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1">
          {job.warnings.map((w) => (
            <li key={w} className="flex gap-2 text-[12.5px] text-warn">
              <Info size={14} className="mt-0.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      {(done || err) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {done && job.songId && onOpen && (
            <Button variant="primary" onClick={() => onOpen(job.songId!)} icon={<ArrowRight size={16} />}>
              {re ? 'Open in Studio' : 'Open in Piano Studio'}
            </Button>
          )}
          {err && saveWithoutOld && (
            <>
              <Button variant="primary" onClick={() => void saveWithoutOld()} icon={<Save size={15} />}>
                Save without the old notes
              </Button>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </>
          )}
          {err && failedHere && !saveWithoutOld && (
            <Button variant="primary" onClick={() => void failedHere.retry()} icon={<RotateCcw size={15} />}>
              Try again
            </Button>
          )}
          {err && failedHere?.retryQuick && (
            <Button onClick={() => void failedHere.retryQuick!()} icon={<RotateCcw size={15} />}>
              Use the Quick reader
            </Button>
          )}
          {err && failedHere?.retryFast && !saveWithoutOld && pianoModelSelected && (
            <Button onClick={() => void failedHere.retryFast!()} icon={<RotateCcw size={15} />}>
              Try with the normal model
            </Button>
          )}
          {err && failedHere?.recording && !re && (
            <Button onClick={() => saveBlobAs(failedHere.recording!.blob, failedHere.recording!.fileName)} icon={<Download size={15} />}>
              Download recording
            </Button>
          )}
          {onDismiss && !saveWithoutOld && (
            <Button variant="ghost" onClick={onDismiss}>
              {err ? 'Dismiss' : re ? 'Close' : 'Import another'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
