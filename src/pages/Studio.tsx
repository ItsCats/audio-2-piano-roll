import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Film,
  Download,
  PencilRuler,
  PanelRightClose,
  PanelRightOpen,
  Palette,
  Type,
  SlidersHorizontal,
  Target,
  ListMusic,
  Loader2,
  Music2,
  FileAudio,
  FileJson,
  ChevronDown,
  Sparkles,
  Library,
  AlertTriangle,
} from 'lucide-react';
import { useStudio, currentArrangement } from '../state/studioStore';
import { useSettings } from '../state/settingsStore';
import { useTransport } from '../state/transportStore';
import { getPlayer } from '../state/playback';
import { attachInput } from '../state/practiceRuntime';
import { PianoRollView } from '../components/studio/PianoRollView';
import { Transport } from '../components/studio/Transport';
import { EditToolbar } from '../components/studio/EditToolbar';
import { ExportVideoDialog } from '../components/studio/ExportVideoDialog';
import { LookPanel } from '../components/studio/panels/LookPanel';
import { LabelsPanel } from '../components/studio/panels/LabelsPanel';
import { SoundPanel } from '../components/studio/panels/SoundPanel';
import { PracticePanel } from '../components/studio/panels/PracticePanel';
import { ArrangementPanel } from '../components/studio/panels/ArrangementPanel';
import { Badge, Button, EmptyState, IconButton, Modal, ProgressBar, Segmented, cn } from '../components/ui';
import { getAudio } from '../lib/storage/db';
import { downloadBlob, downloadMidi, exportProject, renderWav, safeFileName } from '../lib/export/downloads';
import { midiInput, QWERTY_MAP } from '../lib/midiInput/webmidi';
import type { Difficulty } from '../lib/music/types';
import { toast } from '../state/toastStore';
import { useImport } from '../state/importStore';

type PanelTab = 'look' | 'labels' | 'sound' | 'practice' | 'arrangement';

function ExportMenu({ onVideo }: { onVideo: () => void }) {
  const [open, setOpen] = useState(false);
  const [wav, setWav] = useState<{ progress: number; abort: AbortController } | null>(null);
  const song = useStudio((s) => s.song)!;
  const difficulty = useStudio((s) => s.difficulty);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const exportWav = async () => {
    setOpen(false);
    const abort = new AbortController();
    setWav({ progress: 0, abort });
    try {
      const blob = await renderWav(song, difficulty, useSettings.getState().audio, {
        rate: useTransport.getState().rate,
        signal: abort.signal,
        onProgress: (progress) => setWav((w) => (w ? { ...w, progress } : w)),
      });
      downloadBlob(blob, `${safeFileName(song.title)} (${difficulty}).wav`);
      toast.success('WAV exported', `${(blob.size / 1024 / 1024).toFixed(1)} MB`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error('Audio export failed', (e as Error).message);
    } finally {
      setWav(null);
    }
  };
  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="subtle" icon={<Download size={15} />} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="hidden sm:inline">Export</span> <ChevronDown size={14} />
      </Button>
      {open && (
        <div className="panel absolute top-10 right-0 z-30 w-60 p-1.5" role="menu">
          {[
            { icon: Film, label: 'Video (MP4 / WebM)…', onClick: () => { setOpen(false); onVideo(); } },
            { icon: Music2, label: `MIDI file (${difficulty})`, onClick: () => { setOpen(false); downloadMidi(song, difficulty); } },
            { icon: FileAudio, label: `Audio WAV (${difficulty})`, onClick: () => void exportWav() },
            { icon: FileJson, label: 'Project file (.json)', onClick: () => { setOpen(false); exportProject(song); } },
          ].map((item) => (
            <button key={item.label} role="menuitem" onClick={item.onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-100 hover:bg-ink-700">
              <item.icon size={15} className="text-ink-300" /> {item.label}
            </button>
          ))}
        </div>
      )}
      <Modal open={!!wav} onClose={() => wav?.abort.abort()} title="Rendering audio">
        <div className="flex flex-col gap-3 p-5">
          <p className="text-[13px] text-ink-300">Rendering the piano offline with your current sound settings…</p>
          <ProgressBar value={wav?.progress ?? 0} />
          <Button size="sm" variant="ghost" className="self-start" onClick={() => wav?.abort.abort()}>
            Cancel
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function useStudioKeyboard(computerKeys: boolean) {
  const octave = useRef(0);
  useEffect(() => {
    const down = new Set<string>();
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const st = useStudio.getState();
      const player = getPlayer();
      const mod = e.ctrlKey || e.metaKey;
      if (computerKeys && !st.editMode && !mod) {
        if (e.code in QWERTY_MAP) {
          e.preventDefault();
          if (down.has(e.code)) return;
          down.add(e.code);
          midiInput.emit({ type: 'noteon', midi: 60 + octave.current * 12 + QWERTY_MAP[e.code], velocity: 0.7, device: 'computer' });
          return;
        }
        if (e.code === 'KeyZ') return void (octave.current = Math.max(-3, octave.current - 1));
        if (e.code === 'KeyX') return void (octave.current = Math.min(3, octave.current + 1));
      }
      if (e.code === 'Space') {
        e.preventDefault();
        player.toggle();
      } else if (e.code === 'Home') {
        player.seek(0);
      } else if (e.code === 'ArrowLeft' && !st.editMode) {
        player.seek(player.getTime() - (e.shiftKey ? 1 : 5));
      } else if (e.code === 'ArrowRight' && !st.editMode) {
        player.seek(player.getTime() + (e.shiftKey ? 1 : 5));
      } else if (e.code === 'KeyE' && !mod) {
        st.setEditMode(!st.editMode);
      } else if (st.editMode) {
        if (mod && e.code === 'KeyZ') {
          e.preventDefault();
          if (e.shiftKey) st.redo();
          else st.undo();
        } else if (mod && e.code === 'KeyY') {
          e.preventDefault();
          st.redo();
        } else if (mod && e.code === 'KeyA') {
          e.preventDefault();
          const arr = currentArrangement(st);
          if (arr) st.select(arr.notes.map((n) => n.id));
        } else if (e.code === 'Delete' || e.code === 'Backspace') {
          e.preventDefault();
          st.deleteSelected();
        } else if (e.code === 'Escape') st.clearSelection();
        else if (e.code === 'KeyH') st.setHandSelected('toggle');
        else if (e.code === 'KeyL') st.setHandSelected('L');
        else if (e.code === 'KeyR' && !mod) st.setHandSelected('R');
        else if (e.code === 'KeyQ') st.quantizeSelected(useTransport.getState().gridDivision);
        else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
          e.preventDefault();
          st.transposeSelected((e.code === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
        } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && st.selection.size && st.song) {
          e.preventDefault();
          const step = (60 / st.song.tempo.bpm / useTransport.getState().gridDivision) * (e.code === 'ArrowLeft' ? -1 : 1);
          const sel = st.selection;
          st.edit((notes) => notes.map((n) => (sel.has(n.id) ? { ...n, start: Math.max(0, n.start + step) } : n)), { coalesceKey: 'nudge' });
        }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!down.has(e.code)) return;
      down.delete(e.code);
      midiInput.emit({ type: 'noteoff', midi: 60 + octave.current * 12 + QWERTY_MAP[e.code], device: 'computer' });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  }, [computerKeys]);
}

/** Keeps the playback controller in sync with the open song, arrangement and transport options. */
function usePlayerSync() {
  const song = useStudio((s) => s.song);
  const arr = useStudio(currentArrangement);
  const transport = useTransport();
  const practice = useSettings((s) => s.practice);
  const songId = song?.id;
  const hasAudio = song?.hasAudio;

  useEffect(() => {
    const player = getPlayer();
    const unsub = player.subscribe(() => useTransport.setState({ playing: player.isPlaying }));
    const detach = attachInput();
    return () => {
      unsub();
      detach();
      player.pause();
    };
  }, []);

  useEffect(() => {
    const player = getPlayer();
    const s = useStudio.getState().song;
    if (!s) return;
    const a = currentArrangement(useStudio.getState())!;
    player.pause();
    player.setSong(a.notes, a.pedal, s.tempo, s.duration);
    player.seek(0);
    player.setOriginalAudio(null);
    if (hasAudio) void getAudio(s.id).then((blob) => blob && useStudio.getState().song?.id === s.id && player.setOriginalAudio(blob));
    useTransport.setState({ loop: null, loopEnabled: false });
  }, [songId, hasAudio]);

  useEffect(() => {
    if (arr) getPlayer().updateNotes(arr.notes, arr.pedal);
  }, [arr]);

  useEffect(() => {
    getPlayer().setOptions({
      rate: transport.rate,
      hands: transport.hands,
      loop: transport.loopEnabled ? transport.loop : null,
      metronome: practice.metronome,
      metronomeVolume: practice.metronomeVolume,
      countIn: practice.countIn,
    });
  }, [transport.rate, transport.hands, transport.loop, transport.loopEnabled, practice]);
}

export default function StudioPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { song, loading, error, open, difficulty, setDifficulty, editMode, setEditMode, saving } = useStudio();
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1100);
  const [tab, setTab] = useState<PanelTab>('look');
  const [exportOpen, setExportOpen] = useState(false);
  const [computerKeys, setComputerKeys] = useState(false);
  const importDemo = useImport((s) => s.importDemo);

  useEffect(() => {
    if (id) void open(id);
    else if (song) navigate(`/studio/${song.id}`, { replace: true });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  usePlayerSync();
  useStudioKeyboard(computerKeys);

  if (!id && !song) {
    return (
      <EmptyState
        icon={<Music2 size={22} />}
        title="No song open"
        action={
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => navigate('/import')}>
              Import music
            </Button>
            <Button icon={<Library size={15} />} onClick={() => navigate('/library')}>
              Library
            </Button>
            <Button variant="ghost" icon={<Sparkles size={15} />} onClick={async () => navigate(`/studio/${await importDemo()}`)}>
              Demo
            </Button>
          </div>
        }
      >
        Import a song or open one from your library to start playing.
      </EmptyState>
    );
  }
  if (error && !song) {
    return (
      <EmptyState icon={<AlertTriangle size={22} />} title="Couldn’t open this song" action={<Button onClick={() => navigate('/library')}>Go to library</Button>}>
        {error}
      </EmptyState>
    );
  }
  if (loading || !song || (id && song.id !== id)) {
    return (
      <div className="flex h-full items-center justify-center text-ink-300">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const counts = (d: Difficulty) => song.arrangements[d].notes.length;
  const tabs: { id: PanelTab; label: string; icon: typeof Palette }[] = [
    { id: 'look', label: 'Look', icon: Palette },
    { id: 'labels', label: 'Labels', icon: Type },
    { id: 'sound', label: 'Sound', icon: SlidersHorizontal },
    { id: 'practice', label: 'Practice', icon: Target },
    { id: 'arrangement', label: 'Notes', icon: ListMusic },
  ];

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 bg-ink-900/95 px-3 py-2 md:flex-nowrap md:px-4">
          <div className="mr-auto flex w-full min-w-0 items-center gap-2 md:w-auto md:flex-1">
            <input
              value={song.title}
              onChange={(e) => useStudio.getState().updateSong({ title: e.target.value })}
              aria-label="Song title"
              className="focus-ring min-w-0 truncate rounded-md bg-transparent px-1 text-[15px] font-semibold text-ink-50 hover:bg-ink-800"
              style={{ width: `${Math.min(36, Math.max(8, song.title.length + 1))}ch` }}
            />
            {song.transcription.estimated ? (
              <Link to="/accuracy" title="Notes were estimated from audio by AI and may contain mistakes — see how accurate it is" className="focus-ring rounded-md">
                <Badge tone="warn">AI transcription</Badge>
              </Link>
            ) : (
              <Badge tone="ok">{song.source.kind === 'midi' ? 'MIDI' : 'Exact'}</Badge>
            )}
            <span className="hidden text-[11.5px] text-ink-400 2xl:inline">{saving ? 'Saving…' : 'Saved'}</span>
            <IconButton className="ml-auto md:hidden" label={panelOpen ? 'Hide panel' : 'Show panel'} onClick={() => setPanelOpen((o) => !o)}>
              {panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </IconButton>
          </div>
          <Segmented<Difficulty>
            ariaLabel="Difficulty"
            value={difficulty}
            onChange={setDifficulty}
            options={(['easy', 'medium', 'hard'] as Difficulty[]).map((d) => ({
              value: d,
              label: (
                <span className="flex items-center gap-1.5 capitalize">
                  {d}
                  <span className="hidden font-mono text-[10.5px] text-ink-400 sm:inline">{counts(d)}</span>
                </span>
              ),
              title: `${counts(d)} notes`,
            }))}
          />
          <Button size="sm" variant={editMode ? 'primary' : 'subtle'} icon={<PencilRuler size={15} />} onClick={() => setEditMode(!editMode)} title="Edit notes (E)">
            <span className="hidden sm:inline">{editMode ? 'Editing' : 'Edit'}</span>
          </Button>
          <Button size="sm" variant="primary" icon={<Film size={15} />} onClick={() => setExportOpen(true)}>
            <span className="hidden lg:inline">Export Video</span>
          </Button>
          <ExportMenu onVideo={() => setExportOpen(true)} />
          <IconButton className="hidden md:inline-flex" label={panelOpen ? 'Hide panel' : 'Show panel'} onClick={() => setPanelOpen((o) => !o)}>
            {panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </IconButton>
        </header>
        {editMode && <EditToolbar />}
        <div className="relative min-h-0 flex-1">
          <PianoRollView />
        </div>
        <Transport />
      </div>

      {panelOpen && (
        <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(340px,92vw)] flex-col border-l border-ink-800 bg-ink-900 shadow-2xl xl:static xl:z-auto xl:shadow-none">
          <div role="tablist" className="flex shrink-0 border-b border-ink-800 px-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                title={t.label}
                className={cn(
                  'focus-ring flex flex-1 flex-col items-center gap-0.5 border-b-2 py-2 text-[10.5px] font-medium transition-colors',
                  tab === t.id ? 'border-accent-500 text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-100',
                )}
              >
                <t.icon size={16} />
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'look' && <LookPanel />}
            {tab === 'labels' && <LabelsPanel />}
            {tab === 'sound' && <SoundPanel />}
            {tab === 'practice' && <PracticePanel computerKeys={computerKeys} setComputerKeys={setComputerKeys} />}
            {tab === 'arrangement' && <ArrangementPanel />}
          </div>
          <div className="border-t border-ink-800 px-4 py-2 text-[11px] text-ink-400">
            <Link to="/settings" className="hover:text-ink-200">
              Keyboard shortcuts & defaults →
            </Link>
          </div>
        </aside>
      )}
      <ExportVideoDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}
