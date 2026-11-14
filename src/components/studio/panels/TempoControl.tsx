/**
 * The tempo of a song whose notes follow a written tempo (sheet music, MIDI files, the demo:
 * followsWrittenTempo): where it came from, and setting it, which re-times the whole song (every
 * level, the sheet, practice and exports) by one factor (lib/sheet/retime.ts scaleSongTempo), as one
 * undo step. Songs from audio keep the beat-grid setting in ArrangementPanel.
 */
import { useEffect, useState } from 'react';
import type { Song, TempoFrom, TempoUnit } from '../../../lib/music/types';
import { followsWrittenTempo, scaleSongTempo, songStartQpm, songTempoUnit } from '../../../lib/sheet/retime';
import { TEMPO_UNIT_Q } from '../../../lib/sheet/score';
import { TEMPO_UNITS, UNIT_LABEL, UNIT_NAME, tempoNumber } from '../../../lib/sheet/tempoUnits';
import { useStudio } from '../../../state/studioStore';
import { toast, useToasts } from '../../../state/toastStore';
import { Badge, Button, Section, cn } from '../../ui';

export const TEMPO_INPUT_ID = 'song-tempo-input';

/** Where the starting tempo came from ('default' too for songs read from a page before this was saved). */
export function tempoFrom(song: Pick<Song, 'tempo' | 'source'>): TempoFrom | undefined {
  return song.tempo.from ?? (song.source.kind === 'score' && song.source.reader ? 'default' : undefined);
}

/** The starting tempo as the sheet writes it ("♩ = 120", "♩. = 80"). */
export function tempoText(song: Song): string {
  const unit = songTempoUnit(song);
  return `${UNIT_LABEL[unit]} = ${tempoNumber(songStartQpm(song) / TEMPO_UNIT_Q[unit])}`;
}

/** The tempo is a guess (no metronome mark on the page or in the file). */
export const tempoGuessed = (song: Pick<Song, 'tempo' | 'source'>): boolean => {
  const f = tempoFrom(song);
  return f === 'default' || f === 'words';
};

/** One sentence: where the tempo came from. */
export function tempoFromText(song: Song): string | null {
  const reader = song.source.kind === 'score' && !!song.source.reader;
  switch (tempoFrom(song)) {
    case 'mark':
      return 'From the metronome mark in the file.';
    case 'words':
      return `Guessed from “${song.tempo.fromText ?? 'the tempo words'}” in the file (it has no metronome mark).`;
    case 'page':
      return `Read from the text on the page${song.tempo.fromText ? `: “${song.tempo.fromText}”` : ''}. Check it against your page.`;
    case 'default':
      return reader
        ? `Not on the page: the sheet-music reader reads the notes but not tempo marks, so ${tempoText(song)} is a guess. Set the tempo printed on your page.`
        : `The file has no tempo mark, so ${tempoText(song)} is a guess.`;
    case 'set':
      return 'Set by you.';
    default:
      return null;
  }
}

/** Puts the cursor in the tempo field (the "Set the tempo" links). */
export function focusTempoInput(): void {
  const el = document.getElementById(TEMPO_INPUT_ID) as HTMLInputElement | null;
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
  el.select();
}

/** The song as the last tempo setting left it (kept while the panel is closed). */
let lastSet: Song | null = null;

/** Undoes the tempo setting when it is still the last change (the song is the one it made). */
function undoIf(song: Song | null): void {
  const st = useStudio.getState();
  if (song && st.song === song && st.past.length) st.undo();
  else toast.info('The tempo was changed since', 'Use Undo in Edit mode to step back.');
}

export function SongTempoSection() {
  const song = useStudio((s) => s.song)!;
  const startQpm = songStartQpm(song);
  const [unit, setUnit] = useState<TempoUnit>(() => songTempoUnit(song));
  const [value, setValue] = useState(() => tempoNumber(startQpm / TEMPO_UNIT_Q[unit]));
  // the song's tempo changed (set here, undo, a tempo mark on the sheet): show it
  useEffect(() => {
    setValue(tempoNumber(startQpm / TEMPO_UNIT_Q[unit]));
  }, [startQpm]);
  const changeUnit = (u: TempoUnit) => {
    setUnit(u);
    setValue(tempoNumber(startQpm / TEMPO_UNIT_Q[u]));
  };
  const num = parseFloat(value.replace(',', '.'));
  const ok = Number.isFinite(num) && num >= 20 && num <= 400;
  const nudge = (f: (x: number) => number) => {
    const base = Number.isFinite(num) ? num : startQpm / TEMPO_UNIT_Q[unit];
    setValue(tempoNumber(Math.max(20, Math.min(400, f(base)))));
  };
  const apply = () => {
    const s = useStudio.getState().song;
    if (!s || !followsWrittenTempo(s)) return;
    if (!ok) {
      toast.error('Invalid tempo', `Enter a number between 20 and 400 ${UNIT_NAME[unit].toLowerCase()} notes per minute.`);
      return;
    }
    const v = Math.round(num * 10) / 10;
    const before = songStartQpm(s);
    if (Math.abs(before - v * TEMPO_UNIT_Q[unit]) < 1e-9) {
      toast.info(`The song already plays at ${UNIT_LABEL[unit]} = ${tempoNumber(v)}`);
      return;
    }
    const { patch } = scaleSongTempo(s, v, unit);
    useStudio.getState().editSong(() => patch);
    const after = useStudio.getState().song;
    lastSet = after;
    useToasts.getState().push(
      {
        kind: 'success',
        title: `Tempo set: ${UNIT_LABEL[unit]} = ${tempoNumber(v)}`,
        body: 'Every level, the sheet music, practice and exports play at the new speed. Tempo changes later in the piece keep their proportions.',
        actions: [{ label: 'Undo', variant: 'ghost', onClick: () => undoIf(after) }],
      },
      10000,
    );
  };
  // the song is still as this setting left it: one tap puts the tempo back (Undo is otherwise in Edit mode)
  const changed = lastSet;
  const canUndo = !!changed && changed === song;
  const fromLine = tempoFromText(song);
  const guessed = tempoGuessed(song);
  const stepBtn = 'focus-ring h-9 w-9 shrink-0 rounded-[10px] border border-ink-600 bg-ink-800 font-mono text-[15px] text-ink-50 hover:bg-ink-700';
  return (
    <Section title="Tempo">
      <div className="flex flex-col gap-1" data-testid="tempo-from">
        <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-100">
          Starts at <span className="font-mono">{tempoText(song)}</span>
          {guessed && (
            <Badge tone="warn" title="Not a metronome mark from the page or the file">
              guess
            </Badge>
          )}
        </p>
        {fromLine && <p className={cn('text-[11.5px] leading-snug', guessed ? 'text-warn' : 'text-ink-400')}>{fromLine}</p>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12.5px] text-ink-200">
          Beat
          <select
            value={unit}
            onChange={(e) => changeUnit(e.target.value as TempoUnit)}
            aria-label="Beat"
            data-testid="song-tempo-unit"
            className="focus-ring h-9 rounded-[10px] border border-ink-600 bg-ink-800 px-2 text-[13px] text-ink-50"
          >
            {TEMPO_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]} {UNIT_NAME[u]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12.5px] text-ink-200" htmlFor={TEMPO_INPUT_ID}>
          Tempo ({UNIT_NAME[unit].toLowerCase()} note = {ok ? tempoNumber(num) : '…'})
          <span className="flex items-center gap-1">
            <button type="button" className={stepBtn} aria-label="Slower" onClick={() => nudge((x) => Math.round(x) - 1)}>
              −
            </button>
            <input
              id={TEMPO_INPUT_ID}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              inputMode="decimal"
              aria-label={`${UNIT_NAME[unit]} notes per minute`}
              data-testid="song-tempo-input"
              className="focus-ring h-9 w-full min-w-0 rounded-[10px] border border-ink-600 bg-ink-800 px-2.5 text-center font-mono text-[13px] text-ink-50"
            />
            <button type="button" className={stepBtn} aria-label="Faster" onClick={() => nudge((x) => Math.round(x) + 1)}>
              +
            </button>
          </span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => nudge((x) => x / 2)} data-testid="song-tempo-half" title="Half the number in the box (then Set tempo)">
          Half
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => nudge((x) => x * 2)}
          data-testid="song-tempo-double"
          title="Double the number in the box (then Set tempo)"
        >
          Double
        </Button>
        {canUndo && (
          <Button size="sm" variant="ghost" onClick={() => undoIf(changed)} data-testid="song-tempo-undo" className="ml-auto">
            Undo
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!ok} onClick={apply} data-testid="song-tempo-set" className={canUndo ? '' : 'ml-auto'}>
          Set tempo
        </Button>
      </div>
      <p className="text-[11.5px] leading-snug text-ink-400">
        Use the tempo printed at the top of your page. Every level plays at it (Hard as written too), with the sheet music, practice and exports; your edits,
        fingering and markings stay. Later tempo changes and held notes keep their proportions.
      </p>
    </Section>
  );
}
