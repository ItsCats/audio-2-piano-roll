import { useNavigate, Link } from 'react-router-dom';
import { PlayCircle, MonitorSpeaker, Music2, Keyboard, ArrowRight, Upload, Gauge, Film } from 'lucide-react';
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
      icon: PlayCircle,
      title: 'Try the demo',
      text: 'Bach’s Prelude in C. A good way to poke around the Studio.',
      onClick: async () => {
        try {
          const id = await importDemo();
          navigate(`/studio/${id}`);
        } catch (e) {
          toast.error('Could not create demo', (e as Error).message);
        }
      },
    },
    { icon: MonitorSpeaker, title: 'Record what’s playing', text: 'Record a song playing in another tab on your computer.', onClick: () => navigate('/import?tab=computer') },
    { icon: Music2, title: 'Import MIDI or sheet music', text: 'MIDI, MusicXML or MuseScore files. The notes come out exactly right.', onClick: () => navigate('/import?tab=midi') },
    { icon: Keyboard, title: 'Connect a MIDI keyboard', text: 'Play along and see how many notes you hit, and how on time you were.', onClick: () => navigate('/settings#midi') },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-8 md:px-10 md:py-12">
        <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr]">
          <div className="animate-fade-in">
            <p className="text-[12px] font-semibold tracking-[0.14em] text-accent-400 uppercase">Free · No sign-up</p>
            <h1 className="mt-3 text-[34px] leading-[1.1] font-semibold tracking-tight text-ink-50 md:text-[44px]">
              Turn a song into <span className="text-ink-300">notes you can play.</span>
            </h1>
            <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-ink-300">
              Drop in a song and Piano2Vision works out the notes, then shows them falling onto a keyboard so you can learn it by
              watching. You also get a real grand piano sound, Easy, Medium and Hard versions, editing, practice tools and video
              export.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button variant="primary" size="lg" onClick={() => navigate('/import')} icon={<Upload size={18} />}>
                Import music
              </Button>
              <Button variant="subtle" size="lg" onClick={actions[0].onClick} icon={<PlayCircle size={18} />}>
                Play the demo
              </Button>
            </div>
            <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-ink-300">
              <span className="flex items-center gap-1.5"><Gauge size={14} className="text-accent-400" /> Works in your browser</span>
              <span className="flex items-center gap-1.5"><Music2 size={14} className="text-accent-400" /> Easy · Medium · Hard</span>
              <span className="flex items-center gap-1.5"><Film size={14} className="text-accent-400" /> Save it as a 1080p video</span>
            </div>
          </div>
          <Dropzone onFile={onFile} />
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-200">Ways to start</h2>
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
              Nothing here yet. Songs you import show up here.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
