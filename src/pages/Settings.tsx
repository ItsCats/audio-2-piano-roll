import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Server, HardDrive, Keyboard as KeyboardIcon, Music2, Info, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useSettings } from '../state/settingsStore';
import { Button, Section, Segmented, Slider, Toggle } from '../components/ui';
import { MidiDevices } from '../components/studio/panels/PracticePanel';
import { configuredBackendUrl, health, type BackendHealth } from '../lib/backend/client';
import { storageEstimate } from '../lib/storage/db';
import type { Difficulty } from '../lib/music/types';
import { PIANO_PRESETS } from '../lib/audio/presets';
import { SOURCE_CODE_LABEL, SOURCE_CODE_URL } from '../lib/credits';
import { toast } from '../state/toastStore';
import { rememberServerHealth } from '../state/importStore';

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['Home', 'Back to start'],
  ['← / →', 'Seek ±5 s (Shift: ±1 s)'],
  ['F', 'Full screen (Esc to leave)'],
  ['E', 'Toggle edit mode (not in full screen)'],
  ['Ctrl/⌘ + Z', 'Undo (Shift: redo)'],
  ['Delete', 'Delete selected notes'],
  ['↑ / ↓', 'Transpose selection (Shift: octave)'],
  ['← / → (edit)', 'Nudge selection by one grid step'],
  ['L / R / H', 'Left hand / right hand / swap'],
  ['Q', 'Quantize to grid'],
  ['Ctrl/⌘ + A', 'Select all'],
  ['Ctrl + wheel', 'Zoom (note speed)'],
  ['Double-click', 'Add a note (edit mode)'],
  ['Shift-drag timeline', 'Set loop region'],
];

function BackendSettings() {
  const backendUrl = useSettings((s) => s.backendUrl);
  const set = useSettings((s) => s.set);
  const [draft, setDraft] = useState(backendUrl);
  const [status, setStatus] = useState<{ state: 'idle' | 'checking' | 'ok' | 'error'; health?: BackendHealth; error?: string }>({ state: 'idle' });
  const effective = configuredBackendUrl(backendUrl);
  const test = async (url: string) => {
    if (!url) return setStatus({ state: 'idle' });
    setStatus({ state: 'checking' });
    try {
      const h = await health(url);
      rememberServerHealth(url, h); // the Import page's separation option uses the same answer
      setStatus({ state: 'ok', health: h });
    } catch (e) {
      rememberServerHealth(url, null);
      setStatus({ state: 'error', error: (e as Error).message });
    }
  };
  useEffect(() => {
    if (effective) void test(effective);
  }, [effective]);
  return (
    <Section title="Processing server (optional)">
      <p className="text-[12.5px] leading-relaxed text-ink-300">
        Transcription runs in your browser. A self-hosted processing server adds YouTube audio fetching and faster SCNet vocals &amp; drums
        separation for full songs. See <code className="text-ink-100">server/README.md</code>.
      </p>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={import.meta.env.VITE_PROCESSING_URL || 'http://localhost:8000'}
          aria-label="Processing server URL"
          className="focus-ring h-9 flex-1 rounded-[10px] border border-ink-600 bg-ink-800 px-3 font-mono text-[12.5px] text-ink-50 placeholder:text-ink-400"
        />
        <Button
          size="sm"
          onClick={() => {
            const v = draft.trim();
            if (v && !/^https?:\/\//.test(v)) return toast.error('Invalid URL', 'Use http:// or https://');
            set({ backendUrl: v });
            void test(configuredBackendUrl(v));
          }}
        >
          Save & test
        </Button>
      </div>
      {status.state === 'checking' && <p className="flex items-center gap-2 text-[12.5px] text-ink-300"><Loader2 size={14} className="animate-spin" /> Connecting…</p>}
      {status.state === 'ok' && status.health && (
        <p className="flex items-center gap-2 text-[12.5px] text-ok">
          <CheckCircle2 size={14} /> Connected (v{status.health.version}) · YouTube {status.health.features.youtube ? '✓' : '✗'} · Separation{' '}
          {status.health.features.separation ? (status.health.features.stems ? '✓ (SCNet stems)' : '✓ (old server without stems: update it)') : '✗'}
        </p>
      )}
      {status.state === 'error' && <p className="flex items-center gap-2 text-[12.5px] text-bad"><XCircle size={14} /> {status.error}</p>}
    </Section>
  );
}

export default function SettingsPage() {
  const s = useSettings();
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    void storageEstimate().then(setStorage);
    if (location.hash === '#midi') document.getElementById('midi')?.scrollIntoView();
  }, []);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-8 md:px-10">
        <header>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink-50">Settings</h1>
          <p className="mt-1 text-[13.5px] text-ink-300">Preferences are saved in this browser.</p>
        </header>

        <div className="panel overflow-hidden">
          <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3 text-[14px] font-semibold text-ink-50">
            <Music2 size={16} className="text-accent-400" /> Playback & arrangement
          </div>
          <Section title="Defaults">
            <span className="text-[12.5px] text-ink-200">Default difficulty</span>
            <Segmented<Difficulty>
              size="sm"
              value={s.defaultDifficulty}
              onChange={(defaultDifficulty) => s.set({ defaultDifficulty })}
              options={[
                { value: 'easy', label: 'Easy' },
                { value: 'medium', label: 'Medium' },
                { value: 'hard', label: 'Hard' },
              ]}
            />
            <span className="text-[12.5px] text-ink-200">Default note detection</span>
            <Segmented
              size="sm"
              value={s.detectionPreset}
              onChange={(detectionPreset) => s.set({ detectionPreset })}
              options={[
                { value: 'piano', label: 'Piano solo' },
                { value: 'mix', label: 'Full song' },
                { value: 'sensitive', label: 'Sensitive' },
              ]}
            />
          </Section>
          <Section title="Audio">
            <span className="text-[12.5px] text-ink-200">Piano</span>
            <Segmented
              size="sm"
              value={s.audio.presetId}
              onChange={(presetId) => s.setAudio({ presetId })}
              options={PIANO_PRESETS.map((p) => ({ value: p.id, label: p.name.replace(' Piano', '') }))}
            />
            <Slider label="Master volume" min={0} max={1} value={s.audio.volume} onChange={(volume) => s.setAudio({ volume })} format={(x) => `${Math.round(x * 100)}%`} />
            <Slider label="Metronome volume" min={0} max={1} value={s.practice.metronomeVolume} onChange={(metronomeVolume) => s.setPractice({ metronomeVolume })} format={(x) => `${Math.round(x * 100)}%`} />
            <Toggle label="Count-in before playback" checked={s.practice.countIn} onChange={(countIn) => s.setPractice({ countIn })} />
            <Button size="sm" variant="ghost" className="self-start" onClick={s.resetAudio}>
              Reset sound settings
            </Button>
          </Section>
          <Section title="Visual">
            <Slider label="Note speed (seconds visible)" min={0.8} max={10} step={0.1} value={s.visual.lookahead} onChange={(lookahead) => s.setVisual({ lookahead })} format={(x) => `${x.toFixed(1)}s`} />
            <Toggle label="Sparks & trails" checked={s.visual.particles} onChange={(particles) => s.setVisual({ particles, trails: particles })} />
            <Button size="sm" variant="ghost" className="self-start" onClick={s.resetVisual}>
              Reset look to defaults
            </Button>
          </Section>
        </div>

        <div className="panel overflow-hidden" id="midi">
          <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3 text-[14px] font-semibold text-ink-50">
            <KeyboardIcon size={16} className="text-accent-400" /> Keyboard
          </div>
          <Section title="MIDI devices">
            <MidiDevices />
          </Section>
          <Section title="Shortcuts">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>
                    <kbd className="rounded-md border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-ink-100">{k}</kbd>
                  </dt>
                  <dd className="text-ink-300">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </div>

        <div className="panel overflow-hidden">
          <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3 text-[14px] font-semibold text-ink-50">
            <Server size={16} className="text-accent-400" /> Processing
          </div>
          <BackendSettings />
        </div>

        <div className="panel overflow-hidden">
          <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3 text-[14px] font-semibold text-ink-50">
            <HardDrive size={16} className="text-accent-400" /> Storage & account
          </div>
          <Section title="Local storage">
            {storage && (
              <p className="text-[12.5px] text-ink-300">
                Using {(storage.usage / 1024 / 1024).toFixed(1)} MB of {(storage.quota / 1024 / 1024 / 1024).toFixed(1)} GB available to this site.
              </p>
            )}
            <p className="text-[12.5px] leading-relaxed text-ink-300">
              No account is needed: songs, original audio and settings stay in this browser. Use <b>Export → Project file</b> to back up or move a
              song to another device.
            </p>
          </Section>
        </div>

        <div className="panel overflow-hidden">
          <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3 text-[14px] font-semibold text-ink-50">
            <Info size={16} className="text-accent-400" /> About & credits
          </div>
          <Section title="Transcription accuracy">
            <p className="text-[12.5px] leading-relaxed text-ink-300">
              Audio transcription is an AI estimate.{' '}
              <Link to="/accuracy" className="text-accent-400 hover:text-accent-300">
                See measured accuracy and what to expect →
              </Link>
            </p>
          </Section>
          <Section title="Credits & licences">
            <ul className="flex flex-col gap-1 text-[12.5px] text-ink-300">
              <li>Basic Pitch note-detection model — Spotify (Apache-2.0)</li>
              <li>SCNet vocals &amp; drums separation model — Tong et al. (MIT)</li>
              <li>Salamander Grand Piano V3 — Alexander Holm (CC BY 3.0) · Upright Piano KW — FreePats (CC0)</li>
              <li>TensorFlow.js · ONNX Runtime Web · Mediabunny · @tonejs/midi · React, and more</li>
            </ul>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-300">
              <Link to="/credits" className="text-accent-400 hover:text-accent-300">
                All credits, licences and the test data we used →
              </Link>
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-300">
              <a href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer" className="text-accent-400 hover:text-accent-300">
                {SOURCE_CODE_LABEL}
              </a>
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
