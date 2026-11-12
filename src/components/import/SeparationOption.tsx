import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Server, Cpu } from 'lucide-react';
import { Badge, cn } from '../ui';
import { useSettings } from '../../state/settingsStore';
import { separationAvailability, separationChoice, serverHasStems, serverHealth, useImport, type PresetId, type SeparationAvailability } from '../../state/importStore';
import { configuredBackendUrl } from '../../lib/backend/client';
import { estimateSeparationMB, formatMemory, separationSupport } from '../../lib/separation';

/**
 * Where "Separate vocals & drums" would run and whether it is ticked for the current detection
 * preset (the user's last choice for that preset, else on for "Full song" when recommended).
 */
export function useSeparationChoice(): {
  avail: SeparationAvailability;
  checked: boolean;
  setChecked: (v: boolean) => void;
  preset: PresetId;
  checkingServer: boolean;
} {
  const preset = useSettings((s) => s.detectionPreset) as PresetId;
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

/** `unusedReason`: separation does not apply to this import (shown unticked and disabled, with the reason; the remembered choice is kept). */
export function SeparationOption({ className, unusedReason }: { className?: string; unusedReason?: string }) {
  const { avail, checked: chosen, setChecked } = useSeparationChoice();
  const disabled = !avail.available || !!unusedReason;
  const checked = chosen && !unusedReason;
  const lowMemory = avail.engine === 'browser' && !avail.browser.recommended;
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
            Separate vocals &amp; drums
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
            {avail.engine === 'server' ? EXPLAIN_SERVER : explainBrowser(avail.browser.estSecondsPerMinute, avail.browser.maxSeconds)}
          </span>
          {unusedReason ? (
            <span className="text-[11.5px] text-ink-400">{unusedReason}</span>
          ) : (
            disabled && avail.reason && <span className="text-[11.5px] text-ink-400">Not available: {avail.reason}</span>
          )}
          {lowMemory && !unusedReason && (
            <span className="flex gap-1.5 text-[11.5px] leading-relaxed text-warn">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>May run out of memory on this device. {avail.reason}</span>
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
