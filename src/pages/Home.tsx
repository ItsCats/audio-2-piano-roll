import { useNavigate, Link } from 'react-router-dom';
import { Sparkles, SquarePlay, Music2, Keyboard, ArrowRight, Wand2, Gauge, Film } from 'lucide-react';
import { Dropzone } from '../components/import/Dropzone';
import { SongCard } from '../components/SongCard';
import { useLibrary } from '../state/libraryStore';
import { useImport } from '../state/importStore';
import { Button } from '../components/ui';
import { toast } from '../state/toastStore';

export function HomePage() {
  const songs = useLibrary((s) => s.songs);
  const navigate = useNavigate();
  const importFile = useImport((s) => s.importFile);
  const importDemo = useImport((s) => s.importDemo);
  const recent = songs.slice(0, 8);

  const onFile = (f: File) => {
    void importFile(f);
    navigate('/import');
  };

  const actions = [
    {
      icon: Sparkles,
      title: 'Try the demo',
      text: 'Bach’s Prelude in C — hear the grand piano and explore the Studio.',
      onClick: async () => {
        try {
          const id = await importDemo();
          navigate(`/studio/${id}`);
        } catch (e) {
          toast.error('Could not create demo', (e as Error).message);
        }
      },
    },
    { icon: SquarePlay, title: 'Paste a YouTube link', text: 'Turn a video you have rights to into a piano roll.', onClick: () => navigate('/import/youtube') },
    { icon: Music2, title: 'Import a MIDI file', text: 'Exact notes, pedal and tempo — no transcription needed.', onClick: () => navigate('/import?tab=midi') },
    { icon: Keyboard, title: 'Connect a MIDI keyboard', text: 'Practice along and get scored on accuracy and timing.', onClick: () => navigate('/settings#midi') },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-8 md:px-10 md:py-12">
        <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr]">
          <div className="animate-fade-in">
            <p className="text-[12px] font-semibold tracking-[0.14em] text-accent-400 uppercase">Music → Piano roll</p>
            <h1 className="mt-3 text-[34px] leading-[1.1] font-semibold tracking-tight text-ink-50 md:text-[44px]">
              Hear a song. <span className="text-ink-300">See it on the keys.</span>
            </h1>
            <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-ink-300">
              Piano2Vision listens to your music with a neural pitch detector, writes out the notes, and turns them into an
              interactive falling-note piano roll — with a real sampled grand piano, three difficulty levels, editing,
              practice tools and video export.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button variant="primary" size="lg" onClick={() => navigate('/import')} icon={<Wand2 size={18} />}>
                Import music
              </Button>
              <Button variant="subtle" size="lg" onClick={actions[0].onClick} icon={<Sparkles size={18} />}>
                Play the demo
              </Button>
            </div>
            <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-ink-300">
              <span className="flex items-center gap-1.5"><Gauge size={14} className="text-accent-400" /> Runs in your browser</span>
              <span className="flex items-center gap-1.5"><Music2 size={14} className="text-accent-400" /> Easy · Medium · Hard</span>
              <span className="flex items-center gap-1.5"><Film size={14} className="text-accent-400" /> 1080p60 video export</span>
            </div>
          </div>
          <Dropzone onFile={onFile} />
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-200">Get started</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {actions.map((a) => (
              <button
                key={a.title}
                onClick={a.onClick}
                className="focus-ring group flex flex-col gap-2 rounded-xl border border-ink-700 bg-ink-850 p-4 text-left transition-colors hover:border-ink-600 hover:bg-ink-800"
              >
                <a.icon size={20} className="text-accent-400" strokeWidth={1.8} />
                <span className="text-[14px] font-medium text-ink-50">{a.title}</span>
                <span className="text-[12.5px] leading-relaxed text-ink-300">{a.text}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-wide text-ink-200">Recent songs</h2>
            {songs.length > 0 && (
              <Link to="/library" className="flex items-center gap-1 text-[12.5px] text-accent-400 hover:text-accent-300">
                Library <ArrowRight size={14} />
              </Link>
            )}
          </div>
          {recent.length ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {recent.map((s) => (
                <SongCard key={s.id} song={s} />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-ink-800 bg-ink-900/50 px-5 py-8 text-center text-[13px] text-ink-300">
              Songs you import will appear here.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
