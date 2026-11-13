import { useMemo } from 'react';
import { cn } from '../ui';
import { useSettings } from '../../state/settingsStore';
import { transcriberChoice, useImport, type PresetId } from '../../state/importStore';
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

/** `alwaysOffered`: shown whatever the detection preset (the Record tab, which has no preset picker). */
export function PianoModelOption({ className, alwaysOffered = false }: { className?: string; alwaysOffered?: boolean }) {
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
