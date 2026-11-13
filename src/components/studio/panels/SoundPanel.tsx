import { useSettings } from '../../../state/settingsStore';
import { PIANO_PRESETS, getPreset } from '../../../lib/audio/presets';
import type { ReverbType } from '../../../lib/audio/types';
import { Section, Segmented, Slider, Toggle, cn } from '../../ui';
import { getPlayer, useAudioStatus } from '../../../state/playback';
import { useStudio } from '../../../state/studioStore';
import { isAudioSong } from '../../../lib/music/autoPedal';
import { pedalEditedLevels, withAutoPedal } from '../../../lib/songs';

export function SoundPanel() {
  const a = useSettings((s) => s.audio);
  const setAudio = useSettings((s) => s.setAudio);
  const status = useAudioStatus();
  const hasAudio = useStudio((s) => s.song?.hasAudio);
  const fromAudio = useStudio((s) => !!s.song && isAudioSong(s.song));
  const autoPedal = useStudio((s) => s.song?.autoPedal === true);
  return (
    <div>
      <Section title="Piano">
        <div className="grid grid-cols-2 gap-2">
          {PIANO_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                const preset = getPreset(p.id);
                setAudio({ presetId: p.id, reverbType: preset.defaultReverb, reverbMix: preset.defaultReverbMix });
              }}
              className={cn(
                'focus-ring rounded-xl border p-2.5 text-left transition-colors',
                a.presetId === p.id ? 'border-accent-500 bg-accent-500/10' : 'border-ink-700 bg-ink-800 hover:border-ink-500',
              )}
            >
              <span className="block text-[13px] font-medium text-ink-50">{p.name}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-ink-300">{p.description}</span>
            </button>
          ))}
        </div>
        {status.loading && <p className="text-[12px] text-ink-300">Loading samples… {Math.round(status.progress * 100)}%</p>}
        {status.error && <p className="text-[12px] text-bad">{status.error}</p>}
        <button
          className="self-start text-[12px] text-accent-400 hover:text-accent-300"
          onClick={() => {
            const p = getPlayer();
            [60, 64, 67, 72].forEach((m, i) => setTimeout(() => p.liveNoteOn(m, 0.65), i * 140));
            setTimeout(() => [60, 64, 67, 72].forEach((m) => p.liveNoteOff(m)), 1600);
          }}
        >
          ▶ Audition chord
        </button>
      </Section>
      <Section title="Mix">
        <Slider label="Volume" min={0} max={1} value={a.volume} onChange={(volume) => setAudio({ volume })} format={(x) => `${Math.round(x * 100)}%`} />
        {hasAudio && (
          <Slider label="Original recording (A/B check)" min={0} max={1} value={a.originalVolume} onChange={(originalVolume) => setAudio({ originalVolume })} format={(x) => (x === 0 ? 'off' : `${Math.round(x * 100)}%`)} />
        )}
        <Slider label="Tone" min={-1} max={1} value={a.brightness} onChange={(brightness) => setAudio({ brightness })} format={(x) => (Math.abs(x) < 0.01 ? 'neutral' : x > 0 ? `bright +${Math.round(x * 100)}` : `dark ${Math.round(x * 100)}`)} />
        <Slider label="Dynamics (velocity sensitivity)" min={0} max={1} value={a.velocitySensitivity} onChange={(velocitySensitivity) => setAudio({ velocitySensitivity })} format={(x) => `${Math.round(x * 100)}%`} />
      </Section>
      <Section title="Room">
        <Segmented<ReverbType>
          size="sm"
          value={a.reverbType}
          onChange={(reverbType) => setAudio({ reverbType })}
          options={[
            { value: 'off', label: 'Dry' },
            { value: 'studio', label: 'Studio' },
            { value: 'room', label: 'Room' },
            { value: 'hall', label: 'Hall' },
            { value: 'cathedral', label: 'Church' },
          ]}
        />
        <Slider label="Reverb amount" min={0} max={0.8} value={a.reverbMix} onChange={(reverbMix) => setAudio({ reverbMix })} format={(x) => `${Math.round(x * 100)}%`} disabled={a.reverbType === 'off'} />
        <Slider label="Chorus" min={0} max={1} value={a.chorus} onChange={(chorus) => setAudio({ chorus })} format={(x) => `${Math.round(x * 100)}%`} />
      </Section>
      <Section title="Pedal & mechanics">
        <Toggle label="Sustain pedal" hint="Play the arrangement's pedal markings (and your MIDI pedal)" checked={a.pedalEnabled} onChange={(pedalEnabled) => setAudio({ pedalEnabled })} />
        {fromAudio && (
          <Toggle
            label="Automatic pedal"
            hint="Adds pedal to Medium and Hard so the notes join up (also in MIDI and video)."
            checked={autoPedal}
            disabled={!a.pedalEnabled}
            onChange={(on) => {
              const song = useStudio.getState().song;
              if (!song) return;
              // pedal edited on the sheet is kept unless the user says to replace it
              const replaceEdited = pedalEditedLevels(song).length > 0 && confirm('Replace the pedal you edited on the sheet?');
              const next = withAutoPedal(song, on, { replaceEdited });
              useStudio.getState().updateSong({ autoPedal: next.autoPedal, arrangements: next.arrangements });
            }}
          />
        )}
        <Toggle label="Damper & pedal noises" hint="Subtle key-release and pedal mechanics from the Salamander recordings" checked={a.mechanicalNoise} onChange={(mechanicalNoise) => setAudio({ mechanicalNoise })} />
      </Section>
    </div>
  );
}
