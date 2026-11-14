import { Segmented } from '../ui';
import { PianoModelOption } from './PianoModelOption';
import type { PresetId } from '../../state/importStore';

export const PRESET_DESCRIPTIONS: Record<PresetId, string> = {
  piano: 'Best for solo piano recordings. Tuned to ignore ringing strings and reverb.',
  mix: 'For full songs with vocals, drums and band. Follows sustained melody lines.',
  sensitive: 'Catches quiet and fast notes, at the cost of more false notes to clean up.',
  custom: 'Your custom thresholds from Settings.',
};

/**
 * "What kind of recording is it?": the detection preset, its description and the piano model option
 * that goes with it. Controlled: the Import page passes the global preset (settings.detectionPreset),
 * "Analyze again" its own. `seconds`: the recording's length, when known.
 */
export function DetectionOptions({ value, onChange, seconds }: { value: PresetId; onChange: (v: PresetId) => void; seconds?: number }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12.5px] font-medium text-ink-200">What kind of recording is it?</span>
      <Segmented<PresetId>
        ariaLabel="Detection preset"
        value={value}
        onChange={onChange}
        options={[
          { value: 'piano', label: 'Piano solo' },
          { value: 'mix', label: 'Full song' },
          { value: 'sensitive', label: 'Sensitive' },
        ]}
      />
      <p className="text-[12px] text-ink-300">{PRESET_DESCRIPTIONS[value]}</p>
      <PianoModelOption className="mt-1" preset={value} seconds={seconds} />
    </div>
  );
}
