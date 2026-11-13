import { useEffect, useState } from 'react';
import { Keyboard, Usb, Target, RotateCcw } from 'lucide-react';
import { midiInput, midiSupported, type MidiDevice } from '../../../lib/midiInput/webmidi';
import { useTransport } from '../../../state/transportStore';
import { useSettings } from '../../../state/settingsStore';
import { resetPracticeScore, startPractice, stopPractice } from '../../../state/practiceRuntime';
import { Badge, Button, Section, Segmented, Slider, Toggle } from '../../ui';
import { toast } from '../../../state/toastStore';

export function MidiDevices() {
  const [devices, setDevices] = useState<MidiDevice[]>(midiInput.devices);
  const [enabled, setEnabled] = useState(midiInput.enabled);
  useEffect(() => midiInput.onDevices(setDevices), []);
  if (!midiSupported()) return <p className="text-[12.5px] text-ink-300">This browser has no Web MIDI support. Use Chrome, Edge or Firefox — or play with your computer keyboard.</p>;
  if (!enabled)
    return (
      <Button
        size="sm"
        variant="subtle"
        icon={<Usb size={15} />}
        onClick={async () => {
          try {
            setDevices(await midiInput.enable());
            setEnabled(true);
          } catch (e) {
            toast.error('MIDI unavailable', (e as Error).message);
          }
        }}
      >
        Connect MIDI keyboard
      </Button>
    );
  return devices.length ? (
    <ul className="flex flex-col gap-1">
      {devices.map((d) => (
        <li key={d.id} className="flex items-center justify-between rounded-lg bg-ink-800 px-2.5 py-2 text-[12.5px]">
          <span className="truncate text-ink-100">{d.name}</span>
          <Badge tone={d.state === 'connected' ? 'ok' : 'neutral'}>{d.state}</Badge>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-[12.5px] text-ink-300">MIDI is enabled but no device is connected. Plug in a keyboard — it will appear here automatically.</p>
  );
}

export function PracticePanel({ computerKeys, setComputerKeys }: { computerKeys: boolean; setComputerKeys: (v: boolean) => void }) {
  const tr = useTransport();
  const practice = useSettings((s) => s.practice);
  const setPractice = useSettings((s) => s.setPractice);
  const stats = tr.stats;
  const handValue = tr.practiceHands.L && tr.practiceHands.R ? 'both' : tr.practiceHands.L ? 'L' : 'R';
  return (
    <div>
      <Section title="Input">
        <MidiDevices />
        <Toggle
          label={
            <span className="flex items-center gap-1.5">
              <Keyboard size={14} /> Computer keyboard piano
            </span>
          }
          hint="A W S E D F T G Y H U J K → C4…C5 · Z/X octave"
          checked={computerKeys}
          onChange={setComputerKeys}
        />
      </Section>
      <Section title="Practice">
        <span className="text-[12.5px] text-ink-200">Hands I’m playing</span>
        <Segmented
          size="sm"
          value={handValue}
          onChange={(v) => useTransport.setState({ practiceHands: { L: v !== 'R', R: v !== 'L' } })}
          options={[
            { value: 'R', label: 'Right' },
            { value: 'L', label: 'Left' },
            { value: 'both', label: 'Both' },
          ]}
        />
        <Toggle label="Wait for me" hint="Playback pauses at each note until you play it" checked={practice.waitMode} onChange={(waitMode) => setPractice({ waitMode })} />
        <Slider label="Timing window" min={60} max={400} step={10} value={practice.timingWindowMs} onChange={(timingWindowMs) => setPractice({ timingWindowMs })} format={(x) => `±${x} ms`} />
        {tr.practiceActive ? (
          <div className="flex gap-2">
            <Button size="sm" variant="danger" onClick={stopPractice}>
              Stop practice
            </Button>
            <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={resetPracticeScore}>
              Reset score
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="primary" icon={<Target size={15} />} onClick={startPractice}>
            Start practice
          </Button>
        )}
        <p className="text-[11.5px] leading-relaxed text-ink-400">The computer plays the other hand. Slow the speed down in the transport bar — timing is judged relative to the playback speed. With a loop, each time round is scored as a new pass.</p>
      </Section>
      {stats && (
        <Section title="Score">
          <div className="flex items-end gap-2">
            <span className="text-[34px] leading-none font-semibold text-ink-50 tabular-nums">{stats.accuracy}%</span>
            <span className="pb-1 text-[12px] text-ink-300">
              accuracy · pass {stats.pass}
              {stats.bestAccuracy !== null && ` · best ${stats.bestAccuracy}%`}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-ok/10 py-2">
              <div className="text-[18px] font-semibold text-ok tabular-nums">{stats.correct}</div>
              <div className="text-[11px] text-ink-300">correct</div>
            </div>
            <div className="rounded-lg bg-bad/10 py-2">
              <div className="text-[18px] font-semibold text-bad tabular-nums">{stats.wrong}</div>
              <div className="text-[11px] text-ink-300">wrong</div>
            </div>
            <div className="rounded-lg bg-warn/10 py-2">
              <div className="text-[18px] font-semibold text-warn tabular-nums">{stats.missed}</div>
              <div className="text-[11px] text-ink-300">missed</div>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-y-1 text-[12.5px]">
            <dt className="text-ink-300">Timing (avg)</dt>
            <dd className="text-right font-mono text-ink-100">{stats.meanAbsTimingMs} ms</dd>
            <dt className="text-ink-300">Tendency</dt>
            <dd className="text-right font-mono text-ink-100">
              {Math.abs(stats.meanSignedTimingMs) < 15 ? 'on time' : stats.meanSignedTimingMs > 0 ? `${stats.meanSignedTimingMs} ms late` : `${-stats.meanSignedTimingMs} ms early`}
            </dd>
            <dt className="text-ink-300">Streak / best</dt>
            <dd className="text-right font-mono text-ink-100">
              {stats.streak} / {stats.bestStreak}
            </dd>
          </dl>
        </Section>
      )}
    </div>
  );
}
