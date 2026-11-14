import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Server, Cpu } from 'lucide-react';
import { Badge, cn } from '../ui';
import { useSettings } from '../../state/settingsStore';
import { separationAvailability, separationChoice, serverHasStems, serverHealth, useImport, type PresetId, type SeparationAvailability } from '../../state/importStore';
import { configuredBackendUrl } from '../../lib/backend/client';
import { estimateSeparationMB, formatMemory, separationSupport } from '../../lib/separation';
import { pianoSpecialistSupport } from '../../lib/pianoSpecialist';

/**
 * Where "Separate vocals & drums" would run and whether it is ticked for the current detection
 * preset (the user's last choice for that preset, else on for "Full song" when recommended).
 * `presetOverride`: for that preset instead (the Record tab has no preset picker: "piano").
 */
export function useSeparationChoice(presetOverride?: PresetId): {
  avail: SeparationAvailability;
  checked: boolean;
  setChecked: (v: boolean) => void;
  preset: PresetId;
  checkingServer: boolean;
} {
  const current = useSettings((s) => s.detectionPreset) as PresetId;
  const preset = presetOverride ?? current;
  const url = configuredBackendUrl(useSettings((s) => s.backendUrl));
  const prefs = useImport((s) => s.prefs);
  const setPref = useImport((s) => s.setSeparatePref);
  const [server, setServer] = useState<{ url: string; stems: boolean } | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void serverHealth(url).then((h) => alive && setServer({ url, stems: serverHasStems(h) }));
    return () => {
      alive = false;
    };
  }, [url]);
  const serverStems = !!url && server?.url === url && server.stems;
  const browser = useMemo(() => separationSupport(), []);
  const avail = useMemo(() => separationAvailability(serverStems, browser), [serverStems, browser]);
  return {
    avail,
    checked: separationChoice(prefs, preset, avail),
    setChecked: (v) => setPref(preset, v, avail.engine),
    preset,
    checkingServer: !!url && server?.url !== url,
  };
}

/** "about N× the song's length", from the measured seconds of work per minute of audio */
export function lengthMultiple(estSecondsPerMinute: number): string {
  const x = Math.max(1, Math.round(estSecondsPerMinute / 60));
  return `about ${x}× the song’s length`;
}
const explainBrowser = (est: number, maxSeconds: number) =>
  `Better melody and fewer false notes on songs with drums or singing; downloads a 13 MB model once and takes ${lengthMultiple(est)}. ` +
  `Memory grows with length (${formatMemory(estimateSeparationMB(240))} for a 4-minute song), so recordings over ${Math.round(maxSeconds / 60)} minutes are transcribed without it`;
const EXPLAIN_SERVER = 'Better melody and fewer false notes on songs with drums or singing; runs on your processing server';

/** "Remove singing and drums" (Piano solo): what it keeps and what it removes */
const PIANO_WHAT = 'Keeps only the piano part: the singing, drums and bass are removed, so they aren’t turned into notes.';
/**
 * …in this browser (`est`: seconds of work per minute of audio). `lowMemory` (phones, small devices):
 * the memory warning below says it already, so the memory and length sentence is left out.
 */
const explainPianoBrowser = (est: number, maxSeconds: number, lowMemory: boolean) =>
  `${PIANO_WHAT} Downloads a 13 MB model once and takes ${lengthMultiple(est)}.` +
  (lowMemory ? '' : ` Memory grows with length (${formatMemory(estimateSeparationMB(240))} for a 4-minute song), so recordings over ${Math.round(maxSeconds / 60)} minutes are transcribed without it.`);
const EXPLAIN_PIANO_SERVER = `${PIANO_WHAT} Runs on your processing server.`;
/** what it cannot do (always shown under Piano solo) */
export const PIANO_PART_LIMITS = 'Guitars, synths and other instruments stay in: the separation can’t tell them apart from the piano.';

/**
 * The checkbox's words: "Remove singing and drums" under Piano solo (`piano`), "Separate vocals &
 * drums" elsewhere. `modelEst`: the high-accuracy piano model's seconds per minute when it is ticked
 * (it runs after the separation, so the times add up; the memory peak stays the separation's).
 */
export function separationOptionText(o: { piano: boolean; engine: 'server' | 'browser' | null; est: number; maxSeconds: number; modelEst?: number; lowMemory?: boolean; reason?: string }): {
  label: string;
  explain: string;
  limits?: string;
  warning?: string;
} {
  const explain = o.piano
    ? o.engine === 'server'
      ? EXPLAIN_PIANO_SERVER
      : explainPianoBrowser(o.est + (o.modelEst ?? 0), o.maxSeconds, !!o.lowMemory)
    : o.engine === 'server'
      ? EXPLAIN_SERVER
      : explainBrowser(o.est, o.maxSeconds);
  const warning = o.lowMemory ? `May run out of memory on this device. ${o.reason ?? ''}${o.piano && o.modelEst ? ' The piano model runs after it.' : ''}`.replace(/\s+$/, '') : undefined;
  return { label: o.piano ? 'Remove singing and drums' : 'Separate vocals & drums', explain, ...(o.piano ? { limits: PIANO_PART_LIMITS } : {}), ...(warning ? { warning } : {}) };
}

/**
 * `unusedReason`: separation does not apply to this import (shown unticked and disabled, with the reason; the remembered choice is kept).
 * Under "Piano solo" (or `preset` "piano": the Record tab) it is "Remove singing and drums": only the
 * piano part is transcribed, with either model (`pianoModel`: the high-accuracy piano model is ticked).
 */
export function SeparationOption({ className, unusedReason, preset: presetOverride, pianoModel = false }: { className?: string; unusedReason?: string; preset?: PresetId; pianoModel?: boolean }) {
  const { avail, checked: chosen, setChecked, preset } = useSeparationChoice(presetOverride);
  const piano = preset === 'piano';
  const modelEst = useMemo(() => (pianoModel ? pianoSpecialistSupport().estSecondsPerMinute : 0), [pianoModel]);
  const disabled = !avail.available || !!unusedReason;
  const checked = chosen && !unusedReason;
  const lowMemory = avail.engine === 'browser' && !avail.browser.recommended;
  const text = separationOptionText({ piano, engine: avail.engine, est: avail.browser.estSecondsPerMinute, maxSeconds: avail.browser.maxSeconds, modelEst, lowMemory, reason: avail.reason });
  return (
    <div className={cn('rounded-xl border border-ink-700 bg-ink-900/60 p-3.5', className)}>
      <label className={cn('flex items-start gap-2.5', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-[3px] h-4 w-4 shrink-0 accent-[var(--color-accent-500)]"
          aria-describedby="sep-explain"
        />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink-50">
            {text.label}
            {avail.engine === 'server' && (
              <Badge tone="ok">
                <Server size={11} /> on your server
              </Badge>
            )}
            {avail.engine === 'browser' && (
              <Badge>
                <Cpu size={11} /> in this browser
              </Badge>
            )}
          </span>
          <span id="sep-explain" className="text-[12px] leading-relaxed text-ink-300">
            {text.explain}
          </span>
          {text.limits && <span className="text-[11.5px] leading-relaxed text-ink-400">{text.limits}</span>}
          {unusedReason ? (
            <span className="text-[11.5px] text-ink-400">{unusedReason}</span>
          ) : (
            disabled && avail.reason && <span className="text-[11.5px] text-ink-400">Not available: {avail.reason}</span>
          )}
          {text.warning && !unusedReason && (
            <span className="flex gap-1.5 text-[11.5px] leading-relaxed text-warn">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{text.warning}</span>
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
