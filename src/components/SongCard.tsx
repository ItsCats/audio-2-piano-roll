import { Link } from 'react-router-dom';
import { Music2, SquarePlay, FileAudio, Sparkles, Mic } from 'lucide-react';
import type { SongSummary } from '../lib/music/types';
import { formatTime } from '../lib/music/theory';
import { Badge } from './ui';

export const sourceIcon = (kind: SongSummary['source']['kind']) =>
  kind === 'youtube' ? SquarePlay : kind === 'midi' ? Music2 : kind === 'demo' ? Sparkles : kind === 'capture' ? Mic : FileAudio;

export function SongCard({ song }: { song: SongSummary }) {
  const Icon = sourceIcon(song.source.kind);
  return (
    <Link
      to={`/studio/${song.id}`}
      className="focus-ring group flex flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-850 transition-all hover:-translate-y-0.5 hover:border-ink-600"
    >
      <div className="relative aspect-video bg-ink-900">
        {song.thumbnail ? <img src={song.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
        <span className="absolute right-2 bottom-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-ink-100">{formatTime(song.duration)}</span>
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <p className="truncate text-[13.5px] font-medium text-ink-50">{song.title}</p>
        <div className="flex items-center gap-1.5 text-[11.5px] text-ink-300">
          <Icon size={13} />
          <span className="truncate">{song.artist || (song.source.kind === 'midi' ? 'MIDI file' : song.source.kind === 'demo' ? 'Demo' : 'Audio transcription')}</span>
          {song.estimated && (
            <Badge tone="warn" title="Notes were estimated from audio">
              AI
            </Badge>
          )}
        </div>
      </div>
    </Link>
  );
}
