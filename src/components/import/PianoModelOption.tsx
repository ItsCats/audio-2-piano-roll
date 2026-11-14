import { useMemo } from 'react';
import { cn } from '../ui';
import { useSettings } from '../../state/settingsStore';
import { pageBlendEnv, pianoBlendAvailability, pianoBlendChoice, transcriberChoice, useImport, type PianoBlendAvailability, type PresetId } from '../../state/importStore';
import { useSeparationChoice } from './SeparationOption';
import { pianoSpecialistSupport, type PianoSpecialistSupport } from '../../lib/pianoSpecialist';
import type { TranscriptionEngine } from '../../lib/transcription/pipeline';

/**
 * The optional "High-accuracy piano model" checkbox for the "Piano solo" preset (the piano specialist,
 * lib/pianoSpecialist; unticked = Basic Pitch, the default). Off unless the user ticks it; the choice is
 * remembered in the import prefs (importStore `pianoModel`).
 */
export function usePianoModelChoice(alwaysOffered = false): {
  /** the choice is shown (preset "Piano solo") */
  offered: boolean;
  checked: boolean;
  setChecked: (v: boolean) => void;
  /** the model this import would use */
  transcriber: TranscriptionEngine;
  support: PianoSpecialistSupport;
} {
  const preset = useSettings((s) => s.detectionPreset) as PresetId;
  const prefs = useImport((s) => s.prefs);
  const setPref = useImport((s) => s.setPianoModelPref);
  const support = useMemo(() => pianoSpecialistSupport(), []);
  // the Record tab (microphone, usually a piano in the room) offers it whatever the preset
  const transcriber = transcriberChoice(prefs, alwaysOffered ? 'piano' : preset, support.available);
  return {
    offered: alwaysOffered || preset === 'piano',
    checked: support.available && prefs.pianoModel === true,
    setChecked: setPref,
    transcriber,
    support,
  };
}

/**
 * "Add the high-accuracy piano model" for the "Full song" preset: the piano model blended into the
 * Full song result (transcription/pipeline.ts, music/pianoBlend.ts). Needs in-browser separation,
 * not offered as runnable on memory-constrained devices; remembered in the import prefs
 * (importStore `pianoBlend`, default PIANO_BLEND_DEFAULT).
 */
export function usePianoBlendChoice(): {
  offered: boolean;
  checked: boolean;
  setChecked: (v: boolean) => void;
  avail: PianoBlendAvailability;
  downloadMB: number;
  /** the solo piano model's speed estimate here (pianoSpecialistSupport, from the WASM threads) */
  estSecondsPerMinute: number;
} {
  const preset = useSettings((s) => s.detectionPreset) as PresetId;
  const prefs = useImport((s) => s.prefs);
  const setPref = useImport((s) => s.setPianoBlendPref);
  const sep = useSeparationChoice();
  const support = useMemo(() => pianoSpecialistSupport(), []);
  const browserSeparation = sep.checked && sep.avail.engine === 'browser';
  const avail = useMemo(() => pianoBlendAvailability({ ...pageBlendEnv(browserSeparation), specialist: support.available }), [browserSeparation, support.available]);
  return {
    offered: preset === 'mix',
    checked: pianoBlendChoice(prefs, preset, avail),
    setChecked: setPref,
    avail,
    downloadMB: support.downloadMB,
    estSecondsPerMinute: support.estSecondsPerMinute,
  };
}

/**
 * The blend's added time per minute of song, from the solo model's thread-aware estimate: the blend
 * ran 1.0-1.5x that on the band test song (other stem, 3 threads: 40-57 s per minute vs 38), so 1.2x.
 */
export function blendTimeText(estSecondsPerMinute: number): string {
  const s = Math.max(5, Math.round((estSecondsPerMinute * 1.2) / 5) * 5);
  if (s < 90) return `about ${s} seconds`;
  const halves = Math.round(s / 30);
  return `about ${Math.floor(halves / 2)}${halves % 2 ? '½' : ''} minutes`;
}

function PianoBlendOption({ className }: { className?: string }) {
  const { checked, setChecked, avail, downloadMB, estSecondsPerMinute } = usePianoBlendChoice();
  const unavailable = !avail.available;
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-lg border p-3 transition-colors',
        checked ? 'border-accent-500/60 bg-accent-500/[0.07]' : 'border-ink-700 bg-ink-900/60',
        unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-ink-600',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={unavailable}
        onChange={(e) => setChecked(e.target.checked)}
        className="mt-[3px] h-4 w-4 shrink-0 accent-[var(--color-accent-500)]"
        aria-describedby="piano-blend-hint"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[13px] font-medium text-ink-50">Add the high-accuracy piano model</span>
        <span id="piano-blend-hint" className="flex flex-col gap-0.5 text-[12px] leading-relaxed text-ink-300">
          <span>
            {`For instrumental songs (no singing). Blends in what the piano model hears best (keyboard parts, riffs and the notes between the melody) while keeping the Full song melody line and bass. Adds ${blendTimeText(estSecondsPerMinute)} per minute of song on this device; downloads ${downloadMB} MB the first time.`}
          </span>
          {unavailable ? <span className="text-ink-400">{avail.reason}</span> : <span className="text-ink-400">Songs with singing and songs over 10 minutes use the standard Full song result.</span>}
        </span>
      </span>
    </label>
  );
}

/** `alwaysOffered`: the solo option, shown whatever the detection preset (the Record tab, which has no preset picker). */
export function PianoModelOption({ className, alwaysOffered = false }: { className?: string; alwaysOffered?: boolean }) {
  const preset = useSettings((s) => s.detectionPreset) as PresetId;
  if (preset === 'mix' && !alwaysOffered) return <PianoBlendOption className={className} />;
  return <SoloPianoModelOption className={className} alwaysOffered={alwaysOffered} />;
}

function SoloPianoModelOption({ className, alwaysOffered = false }: { className?: string; alwaysOffered?: boolean }) {
  const { offered, checked, setChecked, support } = usePianoModelChoice(alwaysOffered);
  if (!offered) return null;
  const unavailable = !support.available;
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
        checked ? 'border-accent-500/60 bg-accent-500/[0.07]' : 'border-ink-700 bg-ink-900/60',
        unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-ink-600',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={unavailable}
        onChange={(e) => setChecked(e.target.checked)}
        className="mt-[3px] h-4 w-4 shrink-0 accent-[var(--color-accent-500)]"
        aria-describedby="piano-model-hint"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[13px] font-medium text-ink-50">High-accuracy piano model</span>
        <span id="piano-model-hint" className="flex flex-col gap-0.5 text-[12px] leading-relaxed text-ink-300">
          <span>{`For solo piano. Takes longer and downloads a ${support.downloadMB} MB model once.`}</span>
          {unavailable && <span className="text-ink-400">Not available in this browser.</span>}
          {!unavailable && !support.recommended && (
            <span className="text-warn">
              {support.phone
                ? 'May be slow on phones. Songs over 6 minutes might not work on phones with little memory.'
                : 'May be slow on this device. Songs over 6 minutes might not work.'}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}
