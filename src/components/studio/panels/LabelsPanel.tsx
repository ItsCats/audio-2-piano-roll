import { useSettings } from '../../../state/settingsStore';
import type { LabelStyle } from '../../../lib/music/theory';
import { ColorInput, Section, Segmented, Select, Slider, Toggle } from '../../ui';

const FONTS = [
  { value: 'Inter Variable, Inter, system-ui, sans-serif', label: 'Inter' },
  { value: 'JetBrains Mono, ui-monospace, monospace', label: 'JetBrains Mono' },
  { value: 'Georgia, "Times New Roman", serif', label: 'Serif' },
  { value: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', label: 'System' },
  { value: '"Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive', label: 'Playful' },
];

const PCS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function LabelsPanel() {
  const l = useSettings((s) => s.visual.labels);
  const setLabels = useSettings((s) => s.setLabels);
  const on = l.style !== 'none';
  return (
    <div>
      <Section title="Note labels">
        <Toggle label="Show labels on notes" checked={on} onChange={(v) => setLabels({ style: v ? 'letter' : 'none' })} />
        <Toggle
          label="Fingering"
          hint="Finger numbers added on the sheet music, on their falling notes and in videos"
          checked={l.fingering !== false}
          onChange={(fingering) => setLabels({ fingering })}
        />
        <Select<LabelStyle>
          label="Style"
          value={l.style}
          onChange={(style) => setLabels({ style })}
          options={[
            { value: 'letter', label: 'Letters (C, D, E)' },
            { value: 'letter-octave', label: 'With octave (C4, D4)' },
            { value: 'solfege', label: 'Solfège (Do, Re, Mi)' },
            { value: 'number', label: 'MIDI numbers (60, 62)' },
            { value: 'custom', label: 'Custom' },
            { value: 'none', label: 'No labels' },
          ]}
        />
        <Segmented
          size="sm"
          value={l.accidentals}
          onChange={(accidentals) => setLabels({ accidentals })}
          options={[
            { value: 'auto', label: 'Auto (key)', title: 'Sharps or flats according to the detected key' },
            { value: 'sharps', label: 'Sharps ♯' },
            { value: 'flats', label: 'Flats ♭' },
          ]}
        />
        {l.style === 'custom' && (
          <div className="grid grid-cols-4 gap-1.5">
            {PCS.map((pc, i) => (
              <label key={pc} className="flex flex-col gap-0.5 text-[11px] text-ink-300">
                {pc}
                <input
                  value={l.custom[i] ?? ''}
                  maxLength={6}
                  onChange={(e) => {
                    const custom = [...l.custom];
                    custom[i] = e.target.value;
                    setLabels({ custom });
                  }}
                  className="focus-ring h-8 rounded-md border border-ink-600 bg-ink-800 px-2 text-[12.5px] text-ink-50"
                />
              </label>
            ))}
          </div>
        )}
      </Section>
      <Section title="Appearance">
        <Select label="Font" value={l.font} onChange={(font) => setLabels({ font })} options={FONTS} />
        <Slider label="Size" min={8} max={32} step={1} value={l.size} onChange={(size) => setLabels({ size })} format={(x) => `${x}px`} />
        <ColorInput label="Color" value={l.color} onChange={(color) => setLabels({ color })} />
        <Slider label="Opacity" min={0.1} max={1} value={l.opacity} onChange={(opacity) => setLabels({ opacity })} format={(x) => `${Math.round(x * 100)}%`} />
        <Segmented
          size="sm"
          value={l.position}
          onChange={(position) => setLabels({ position })}
          options={[
            { value: 'bottom', label: 'Bottom' },
            { value: 'center', label: 'Center' },
            { value: 'top', label: 'Top' },
          ]}
        />
        <Toggle label="Bold" checked={l.bold} onChange={(bold) => setLabels({ bold })} />
        <Slider label="Hide on notes shorter than" min={0} max={80} step={1} value={l.minNoteHeight} onChange={(minNoteHeight) => setLabels({ minNoteHeight })} format={(x) => `${x}px`} />
        <Toggle label="Octave labels on C keys" checked={l.showOnKeys} onChange={(showOnKeys) => setLabels({ showOnKeys })} />
      </Section>
    </div>
  );
}
