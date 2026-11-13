import { Link } from 'react-router-dom';
import { Music2, SquarePlay, FileAudio, FileMusic, Sparkles, Mic } from 'lucide-react';
import type { SongSummary } from '../lib/music/types';
import { formatTime } from '../lib/music/theory';
import { Badge } from './ui';

export const sourceIcon = (kind: SongSummary['source']['kind']) =>
  kind === 'youtube' ? SquarePlay : kind === 'midi' ? Music2 : kind === 'score' ? FileMusic : kind === 'demo' ? Sparkles : kind === 'capture' ? Mic : FileAudio;

/** What a song was made from, in a few words (when there is no artist to show). */
export const sourceLabel = (kind: SongSummary['source']['kind'], reader?: SongSummary['source']['reader']) =>
  kind === 'midi'
    ? 'MIDI file'
    : kind === 'score'
      ? reader === 'pdf'
        ? 'Read from a PDF'
        : reader === 'photo'
          ? 'Read from a photo'
          : 'Sheet music'
      : kind === 'demo'
        ? 'Demo'
        : 'Audio transcription';

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
          <span className="truncate">{song.artist || sourceLabel(song.source.kind, song.source.reader)}</span>
          {song.estimated && (
            <Badge tone="warn" title="Notes were estimated from audio">
              AI
            </Badge>
          )}
          {song.source.kind === 'score' && song.source.reader && (
            <Badge tone="warn" title={`${sourceLabel(song.source.kind, song.source.reader)} by the sheet-music reader (Beta) — check the notes`}>
              Beta
            </Badge>
          )}
        </div>
      </div>
    </Link>
  );
}
