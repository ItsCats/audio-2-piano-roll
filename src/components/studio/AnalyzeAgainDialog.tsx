import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Loader2, Undo2, Wand2 } from 'lucide-react';
import { Button, Modal } from '../ui';
import { useStudio } from '../../state/studioStore';
import { useSettings } from '../../state/settingsStore';
import { importBusy, useImport, type PresetId, type ReanalyzeOptions } from '../../state/importStore';
import { DetectionOptions } from '../import/DetectionOptions';
import { SeparationOption, useSeparationChoice } from '../import/SeparationOption';
import { usePianoBlendChoice, usePianoModelChoice } from '../import/PianoModelOption';
import { JobProgress } from '../import/JobProgress';
import { useStoredOriginal } from '../../hooks/useStoredOriginal';
import { reanalyzeSupport, type ReanalyzeSupport } from '../../lib/reanalyze';
import { analysisLabel, presetOfInfo, sameAsLast } from '../../lib/transcription/analysisSummary';
import { lossText, lostWork } from '../../lib/songs';
import { ensurePianoSamples, getPlayer, releasePianoSamplesIfLight } from '../../state/playback';
import { swapSongVersions } from '../../state/songVersions';
import { toast } from '../../state/toastStore';
import type { Song } from '../../lib/music/types';

const BUSY_HINT = 'Another import is running. Wait for it to finish.';

/** Screen D: why there is nothing to analyze again, and how to get the recording in again. */
function NothingToAnalyze({ song, support, onClose }: { song: Song; support: Extract<ReanalyzeSupport, { ok: false }>; onClose: () => void }) {
  const navigate = useNavigate();
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const midi = song.source.kind === 'midi' || song.transcription.method === 'midi-file';
  let text: string;
  let button: { label: string; to: string } | null = null;
  let copyLine = false;
  if (support.kind === 'demo') {
    text = 'The demo’s notes are exact, so there’s no recording to analyze.';
  } else if (support.kind === 'exact') {
    text = midi
      ? 'This song’s notes came straight from the MIDI file, so they’re already exact. There’s no recording to analyze.'
      : 'This song’s notes came from the sheet music, so there’s no recording to analyze.';
    button = { label: 'Import a recording', to: '/import' };
  } else {
    text =
      support.kind === 'not-saved'
        ? 'The original recording isn’t saved with this song. Songs opened from a project file, and songs whose recording didn’t fit in this browser’s storage, don’t keep it.'
        : 'This browser no longer has this song’s recording (its stored data may have been cleared).';
    copyLine = true;
    const to = support.reimport ?? '/import';
    button = { label: to === '/import' ? 'Import the recording again' : 'Record it again', to };
  }
  return (
    <div className="flex flex-col gap-3 p-5 text-[13px] leading-relaxed text-ink-200" data-testid="analyze-nothing">
      <p className="flex gap-2">
        <Info size={16} className="mt-0.5 shrink-0 text-accent-400" />
        <span>{text}</span>
      </p>
      {copyLine && <p className="text-ink-300">This makes a new copy of the song; this one stays in your library.</p>}
      {button && (
        <div>
          <Button variant="primary" onClick={() => go(button.to)} icon={<ArrowRight size={15} />}>
            {button.label}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Screen A: the options, as on the Import page, for this song's recording. */
function Options({ song, onRun, busy }: { song: Song; onRun: (o: ReanalyzeOptions) => void; busy: boolean }) {
  const custom = useSettings((s) => s.customDetection);
  const global = useSettings((s) => s.detectionPreset) as PresetId;
  const [preset, setPreset] = useState<PresetId>(() => presetOfInfo(song.transcription, custom) ?? global);
  const seconds = song.duration;
  const sep = useSeparationChoice(preset, seconds);
  const model = usePianoModelChoice(false, { preset });
  const blend = usePianoBlendChoice({ preset, seconds });
  const pianoModel = model.transcriber === 'piano-specialist';
  const hasUndo = useStudio((s) => s.past.length > 0);
  // (built exactly as the Import page builds an import's options)
  const choice: ReanalyzeOptions = { presetId: preset, separate: sep.checked, transcriber: model.transcriber, pianoBlend: blend.offered && blend.checked };
  const last = analysisLabel(song.transcription, custom);
  const same = sameAsLast(song.transcription, choice, custom);
  const loss = useMemo(() => lossText(lostWork(song), hasUndo), [song, hasUndo]);
  return (
    <>
      <div className="flex flex-col gap-4 p-5">
        <p className="text-[13px] leading-relaxed text-ink-200">Listen to this song’s recording again with different settings. The song keeps its name, title card, video and look.</p>
        <DetectionOptions value={preset} onChange={setPreset} seconds={seconds} />
        <SeparationOption pianoModel={pianoModel} preset={preset} seconds={seconds} />
        <div className="flex flex-col gap-1 text-[12.5px]">
          {last && <p className="text-ink-200" data-testid="analyze-last">Last time: {last}</p>}
          {same && <p className="text-ink-400">These are the same settings as last time, so the notes will probably come out the same.</p>}
        </div>
        <div className="flex gap-2 rounded-lg border border-warn/25 bg-warn/10 p-3 text-[12.5px] leading-relaxed text-ink-100" data-testid="analyze-loss">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
          <p>{loss}</p>
        </div>
      </div>
      <footer className="sticky bottom-0 flex flex-col items-stretch gap-2 border-t border-ink-700 bg-ink-850 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
        {busy && <p className="text-[11.5px] text-ink-400 sm:mr-auto">{BUSY_HINT}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => useStudio.getState().setAnalyzeOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => onRun(choice)} icon={<Wand2 size={15} />}>
            Analyze again
          </Button>
        </div>
      </footer>
    </>
  );
}

/**
 * "Analyze again": the song's stored recording analyzed once more with the options picked here (the
 * Import page's), replacing the notes on every level while the song itself stays. Options, progress
 * (the import's card; it can't be closed, only cancelled), the result with a way back, or why there is
 * nothing to analyze.
 */
export function AnalyzeAgainDialog() {
  const song = useStudio((s) => s.song);
  const analyzeOpen = useStudio((s) => s.analyzeOpen);
  const setAnalyzeOpen = useStudio((s) => s.setAnalyzeOpen);
  const job = useImport((s) => s.job);
  const failed = useImport((s) => s.failed);
  const pianoModelSelected = useImport((s) => s.prefs.pianoModel === true);
  const mine = song && job?.reanalyze?.songId === song.id ? job : null;
  const running = !!mine && importBusy(mine);
  const open = !!song && (analyzeOpen || running);
  /** the job shown in this dialog (one started here, or running when it opened) */
  const [shown, setShown] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const stored = useStoredOriginal(song?.id, song?.hasAudio, open);
  useEffect(() => {
    if (open && running && mine && shown !== mine.id) {
      setShown(mine.id);
      setStarting(false);
    }
  }, [open, running, mine, shown]);
  useEffect(() => {
    if (!open) {
      setShown(null);
      setStarting(false);
    }
  }, [open]);
  // the Studio loads its piano samples when it opens: again once the analysis is over (released for it on phones)
  const ended = mine && mine.id === shown && (mine.stage === 'done' || mine.stage === 'error');
  useEffect(() => {
    if (ended) ensurePianoSamples();
  }, [ended]);
  if (!song || !open) return null;
  const busyOther = importBusy(job) && !mine;
  // (a run started from the error card's Try again shows at once)
  const current = mine && (mine.id === shown || running) ? mine : null;
  const close = () => {
    if (running) return;
    // a finished job of this dialog: its card is done with (the sidebar pill too)
    if (current && !importBusy(current)) useImport.getState().clear();
    setAnalyzeOpen(false);
  };
  const cancel = () => {
    useImport.getState().cancel();
    setAnalyzeOpen(false);
    toast.info('Analyze again stopped', 'Your song wasn’t changed.');
  };
  const run = (choice: ReanalyzeOptions) => {
    // phones: the decoded piano samples are not kept in memory under the analysis
    getPlayer().pause();
    releasePianoSamplesIfLight();
    setStarting(true);
    void useImport
      .getState()
      .reanalyze(song.id, choice)
      .finally(() => setStarting(false));
  };
  const support = reanalyzeSupport(song, stored === 'yes');
  let body: ReactNode;
  let footer: ReactNode = null;
  if (current && current.stage === 'done') {
    const r = current.reanalyzeResult;
    const goBack = async () => {
      const s = await swapSongVersions(song.id);
      useImport.getState().clear();
      setAnalyzeOpen(false);
      if (s) toast.success('Back to the old notes', 'The new analysis is kept, so you can switch again under Analyze again.');
    };
    body = (
      <div className="flex flex-col gap-3 p-5 text-[13px] text-ink-200" data-testid="analyze-done">
        <p className="flex items-center gap-2 text-[15px] font-semibold text-ink-50">
          <CheckCircle2 size={18} className="text-ok" /> New notes are ready
        </p>
        {r && (
          <p>
            {r.label ? `${r.label} · ` : ''}Hard: {r.notes} notes (was {r.was})
          </p>
        )}
        {r?.keptTempo !== undefined && <p className="text-ink-300">Your tempo ({r.keptTempo} BPM) was kept.</p>}
        {current.warnings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {current.warnings.map((w) => (
              <li key={w} className="flex gap-2 text-[12.5px] text-warn">
                <Info size={14} className="mt-0.5 shrink-0" /> {w}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
    footer = (
      <>
        {r?.keptOther && (
          <Button variant="ghost" onClick={() => void goBack()} icon={<Undo2 size={15} />}>
            Go back to the old notes
          </Button>
        )}
        <Button variant="primary" onClick={close}>
          See the new notes
        </Button>
      </>
    );
  } else if (current || starting) {
    body = current ? (
      <JobProgress
        job={current}
        failed={failed}
        onCancel={current.stage === 'error' ? () => (useImport.getState().cancel(), setAnalyzeOpen(false)) : cancel}
        onDismiss={current.stage === 'error' ? close : undefined}
        pianoModelSelected={pianoModelSelected}
        scrollIntoView={false}
        className="m-4 sm:m-5"
      />
    ) : (
      <div className="flex items-center gap-2 p-5 text-[13px] text-ink-300">
        <Loader2 size={16} className="animate-spin" /> Starting…
      </div>
    );
  } else if (stored === 'checking') {
    body = (
      <div className="flex items-center gap-2 p-5 text-[13px] text-ink-300">
        <Loader2 size={16} className="animate-spin" /> Looking for the recording…
      </div>
    );
  } else if (!support.ok) {
    body = <NothingToAnalyze song={song} support={support} onClose={close} />;
    footer = (
      <Button variant="ghost" onClick={close}>
        Close
      </Button>
    );
  } else {
    body = <Options key={song.id} song={song} onRun={run} busy={busyOther} />;
  }
  return (
    <Modal open onClose={close} title="Analyze again" closable={!running && !starting} footer={footer}>
      {body}
    </Modal>
  );
}
