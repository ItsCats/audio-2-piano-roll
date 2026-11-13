import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Star, Trash2, Upload, LayoutGrid, List, FileJson, Library as LibraryIcon } from 'lucide-react';
import { useLibrary } from '../state/libraryStore';
import { Badge, Button, EmptyState, IconButton, Segmented, Select, cn } from '../components/ui';
import { SongCard, sourceIcon, sourceLabel } from '../components/SongCard';
import { formatTime } from '../lib/music/theory';
import type { SongSummary } from '../lib/music/types';
import { getSong, saveSong } from '../lib/storage/db';
import { importProject } from '../lib/export/downloads';
import { toast } from '../state/toastStore';
import { useStudio } from '../state/studioStore';

type Sort = 'recent' | 'title' | 'duration' | 'created';
type Filter = 'all' | 'favorites' | 'audio' | 'midi' | 'youtube' | 'score';

export default function LibraryPage() {
  const { songs, loaded, refresh, remove } = useLibrary();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const hasYouTube = useMemo(() => songs.some((s) => s.source.kind === 'youtube'), [songs]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = songs.filter((s) => !needle || s.title.toLowerCase().includes(needle) || s.artist?.toLowerCase().includes(needle) || s.keyName?.toLowerCase().includes(needle));
    if (filter === 'favorites') list = list.filter((s) => s.favorite);
    else if (filter === 'audio') list = list.filter((s) => s.source.kind === 'audio' || s.source.kind === 'capture');
    else if (filter !== 'all') list = list.filter((s) => s.source.kind === filter);
    const by: Record<Sort, (a: SongSummary, b: SongSummary) => number> = {
      recent: (a, b) => (b.lastPlayedAt ?? b.updatedAt) - (a.lastPlayedAt ?? a.updatedAt),
      created: (a, b) => b.createdAt - a.createdAt,
      title: (a, b) => a.title.localeCompare(b.title),
      duration: (a, b) => b.duration - a.duration,
    };
    return [...list].sort(by[sort]);
  }, [songs, q, sort, filter]);

  const toggleFavorite = async (id: string) => {
    const s = await getSong(id);
    if (!s) return;
    s.favorite = !s.favorite;
    await saveSong(s);
    if (useStudio.getState().song?.id === id) useStudio.setState({ song: { ...useStudio.getState().song!, favorite: s.favorite } });
    void refresh();
  };
  const del = async (s: SongSummary) => {
    if (!confirm(`Delete “${s.title}” and its arrangements? This cannot be undone.`)) return;
    if (useStudio.getState().song?.id === s.id) useStudio.getState().close();
    await remove(s.id);
    toast.info('Song deleted');
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-5 py-8 md:px-10">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight text-ink-50">My Library</h1>
            <p className="mt-1 text-[13.5px] text-ink-300">{songs.length} songs stored on this device</p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" icon={<FileJson size={15} />} onClick={() => fileRef.current?.click()}>
              Import project
            </Button>
            <Button variant="primary" icon={<Upload size={15} />} onClick={() => navigate('/import')}>
              Import music
            </Button>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept=".json,application/json"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  const s = await importProject(f);
                  await refresh();
                  toast.success('Project imported', s.title);
                } catch (err) {
                  toast.error('Import failed', (err as Error).message);
                }
              }}
            />
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-56 flex-1">
            <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search title, artist or key"
              aria-label="Search songs"
              className="focus-ring h-10 w-full rounded-xl border border-ink-700 bg-ink-900 pr-3 pl-9 text-[13.5px] text-ink-50 placeholder:text-ink-400"
            />
          </label>
          <Segmented<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'favorites', label: '★' },
              { value: 'audio', label: 'Audio' },
              // songs imported with the old YouTube tab (removed 2026-11) keep their own filter
              ...(hasYouTube || filter === 'youtube' ? [{ value: 'youtube' as const, label: 'YouTube' }] : []),
              { value: 'midi', label: 'MIDI' },
              { value: 'score', label: 'Sheet music' },
            ]}
          />
          <Select<Sort>
            value={sort}
            onChange={setSort}
            options={[
              { value: 'recent', label: 'Recently played' },
              { value: 'created', label: 'Date added' },
              { value: 'title', label: 'Title' },
              { value: 'duration', label: 'Length' },
            ]}
          />
          <div className="flex">
            <IconButton label="Grid view" active={view === 'grid'} onClick={() => setView('grid')}>
              <LayoutGrid size={17} />
            </IconButton>
            <IconButton label="List view" active={view === 'list'} onClick={() => setView('list')}>
              <List size={17} />
            </IconButton>
          </div>
        </div>

        {loaded && !songs.length ? (
          <EmptyState icon={<LibraryIcon size={22} />} title="Your library is empty" action={<Button variant="primary" onClick={() => navigate('/import')}>Import your first song</Button>}>
            Imported songs, MIDI files and their arrangements are saved here automatically.
          </EmptyState>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {shown.map((s) => (
              <div key={s.id} className="group relative">
                <SongCard song={s} />
                <div className="absolute top-2 right-2 flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                  <button aria-label={s.favorite ? 'Unfavourite' : 'Favourite'} onClick={() => void toggleFavorite(s.id)} className={cn('rounded-md bg-black/60 p-1.5', s.favorite ? 'text-warn' : 'text-ink-100 hover:text-warn')}>
                    <Star size={14} fill={s.favorite ? 'currentColor' : 'none'} />
                  </button>
                  <button aria-label="Delete" onClick={() => void del(s)} className="rounded-md bg-black/60 p-1.5 text-ink-100 hover:text-bad">
                    <Trash2 size={14} />
                  </button>
                </div>
                {s.favorite && <Star size={14} fill="currentColor" className="absolute top-2.5 left-2.5 text-warn md:group-hover:opacity-0" />}
              </div>
            ))}
          </div>
        ) : (
          <div className="panel divide-y divide-ink-700 overflow-hidden">
            {shown.map((s) => {
              const Icon = sourceIcon(s.source.kind);
              return (
                <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-ink-800">
                  {s.thumbnail ? <img src={s.thumbnail} alt="" className="h-10 w-16 rounded-md object-cover" /> : <div className="h-10 w-16 rounded-md bg-ink-800" />}
                  <Link to={`/studio/${s.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-ink-50">{s.title}</p>
                    <p className="flex items-center gap-1.5 text-[11.5px] text-ink-300">
                      <Icon size={12} /> {s.artist || (s.source.reader ? sourceLabel(s.source.kind, s.source.reader) : s.source.fileName || s.source.kind)} · {s.noteCount} notes · {Math.round(s.bpm)} BPM {s.keyName && `· ${s.keyName}`}
                    </p>
                  </Link>
                  {s.estimated && <Badge tone="warn">AI</Badge>}
                  {s.source.kind === 'score' && s.source.reader && (
                    <Badge tone="warn" title={`${sourceLabel(s.source.kind, s.source.reader)} by the sheet-music reader (Beta) — check the notes`}>
                      Beta
                    </Badge>
                  )}
                  <span className="hidden font-mono text-[12px] text-ink-300 sm:block">{formatTime(s.duration)}</span>
                  <span className="hidden text-[11.5px] text-ink-400 md:block">{new Date(s.createdAt).toLocaleDateString()}</span>
                  <IconButton size="sm" label="Favourite" active={!!s.favorite} onClick={() => void toggleFavorite(s.id)}>
                    <Star size={15} fill={s.favorite ? 'currentColor' : 'none'} />
                  </IconButton>
                  <IconButton size="sm" label="Delete" onClick={() => void del(s)} className="hover:text-bad">
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
        {loaded && songs.length > 0 && !shown.length && <p className="py-10 text-center text-[13px] text-ink-300">No songs match your search.</p>}
      </div>
    </div>
  );
}
