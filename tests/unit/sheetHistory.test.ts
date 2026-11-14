/** One undo stack for piano-roll edits, arrangement edits and song-level changes (the grid lock too). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/storage/db', async (orig) => ({ ...(await orig<object>()), getSong: vi.fn(), saveSong: vi.fn(async () => undefined) }));
vi.mock('../../src/state/playback', () => ({ getPlayer: () => ({ isPlaying: false, liveNoteOn() {}, liveNoteOff() {} }) }));
vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: number) => clearTimeout(t) });

const { useStudio } = await import('../../src/state/studioStore');
const { runSheetEdit } = await import('../../src/state/sheetEdit');
const { pitchOp, deleteOp } = await import('../../src/lib/sheet/edit');
const { straightSong } = await import('./sheetSongs');
const db = await import('../../src/lib/storage/db');

beforeEach(() => {
  const song = straightSong();
  useStudio.setState({ song, difficulty: 'medium', past: [], future: [], selection: new Set(), editMode: true });
});

describe('studio history', () => {
  it('undoes and redoes roll edits, sheet edits (with the lock) and song changes in order', () => {
    const st = useStudio.getState;
    const s0 = st().song!;
    const first = s0.arrangements.medium.notes[0];
    st().edit((ns) => ns.map((n) => (n.id === first.id ? { ...n, vel: 0.2 } : n)));
    const s1 = st().song!;
    expect(runSheetEdit((ctx) => pitchOp(ctx, new Set([first.id]), 'step', 1))).toBe(true);
    const s2 = st().song!;
    expect(s2.sheet).toBeDefined();
    expect(s2.arrangements.medium.notes.find((n) => n.id === first.id)!.pin).toBeDefined();
    st().editSong(() => ({ duration: s2.duration + 4 }));
    st().editArr((a) => ({ ...a, pedal: [{ start: 0, end: 1 }] }));
    expect(st().past).toHaveLength(4);
    st().undo();
    expect(st().song!.arrangements.medium.pedal).toEqual(s2.arrangements.medium.pedal);
    st().undo();
    expect(st().song!.duration).toBe(s2.duration);
    st().undo();
    expect('sheet' in st().song!).toBe(false);
    expect(st().song!.arrangements).toBe(s1.arrangements);
    st().undo();
    expect(st().song!.arrangements).toBe(s0.arrangements);
    st().redo();
    st().redo();
    expect(st().song!.sheet).toBe(s2.sheet);
    expect(st().song!.arrangements).toBe(s2.arrangements);
    expect(st().future).toHaveLength(2);
  });

  it('a level switch clears the history; a delete selects nothing', () => {
    const st = useStudio.getState;
    const id = st().song!.arrangements.medium.notes[3].id;
    useStudio.setState({ selection: new Set([id]) });
    runSheetEdit((ctx) => deleteOp(ctx, new Set([id])));
    expect(st().selection.size).toBe(0);
    expect(st().past).toHaveLength(1);
    st().setDifficulty('hard');
    expect(st().past).toHaveLength(0);
  });

  it('saves the edited song even when another song opens before the save is due', async () => {
    const st = useStudio.getState;
    vi.mocked(db.saveSong).mockClear();
    st().edit((ns) => ns.slice(1));
    const edited = st().song!;
    const other = { ...straightSong(), id: 'other' };
    vi.mocked(db.getSong).mockResolvedValue(other);
    await st().open('other');
    expect(vi.mocked(db.saveSong).mock.calls.some(([s]) => s === edited)).toBe(true);
  });
});

describe('review fixes in the store', () => {
  it('an edit that puts a note before the locked start moves the start back in the same undo step', async () => {
    const { buildSheet } = await import('../../src/lib/sheet');
    const { writtenSpan } = await import('../../src/lib/sheet/written');
    const st = useStudio.getState;
    // the song with every note 6 s later (an empty start the lock leaves out)
    const s0 = st().song!;
    const later = (ns: typeof s0.base) => ns.map((n) => ({ ...n, start: n.start + 6 }));
    const arr = (a: typeof s0.arrangements.easy) => ({ ...a, notes: later(a.notes) });
    useStudio.setState({ song: { ...s0, duration: s0.duration + 6, base: later(s0.base), arrangements: { easy: arr(s0.arrangements.easy), medium: arr(s0.arrangements.medium), hard: arr(s0.arrangements.hard) } } });
    const first = st().song!.arrangements.medium.notes[0];
    expect(runSheetEdit((ctx) => pitchOp(ctx, new Set([first.id]), 'step', 1))).toBe(true);
    const locked = st().song!;
    const t0 = buildSheet(locked, 'medium').time;
    const start = t0.posToTime(0);
    // the piano roll adds a note a bar and a half before the first written bar
    const at = start - (t0.posToTime(48) - start) * 1.5;
    expect(at).toBeGreaterThanOrEqual(0);
    st().edit((ns) => [...ns, { id: 99001, midi: 72, start: at, dur: 0.2, vel: 0.7, hand: 'R' }]);
    const moved = st().song!;
    expect(moved.sheet!.grid.originQ).toBeLessThan(locked.sheet!.grid.originQ);
    const s = buildSheet(moved, 'medium');
    expect(writtenSpan(s, 99001)!.on).toBeLessThan(writtenSpan(s, first.id)!.on);
    // the pinned note is still written where it was in seconds
    const p0 = locked.arrangements.medium.notes.find((n) => n.id === first.id)!.pin!;
    const p1 = moved.arrangements.medium.notes.find((n) => n.id === first.id)!.pin!;
    expect(s.time.posToTime(p1.on)).toBeCloseTo(t0.posToTime(p0.on), 9);
    st().undo();
    expect(st().song!.sheet).toBe(locked.sheet);
  });

  it('the automatic pedal switch is one undo step for the switch and every level; an update of arrangements outside the history clears it', () => {
    const st = useStudio.getState;
    const s0 = st().song!;
    const first = s0.arrangements.medium.notes[0];
    st().edit((ns) => ns.map((n) => (n.id === first.id ? { ...n, vel: 0.3 } : n)));
    const pedal = [{ start: 0, end: 1 }];
    st().editSong((s) => ({ autoPedal: true, arrangements: { easy: s.arrangements.easy, medium: { ...s.arrangements.medium, pedal }, hard: { ...s.arrangements.hard, pedal } } }));
    expect(st().song!.autoPedal).toBe(true);
    st().undo();
    const back = st().song!;
    expect(back.autoPedal).toBe(s0.autoPedal);
    expect(back.arrangements.hard.pedal).toBe(s0.arrangements.hard.pedal);
    expect(back.arrangements.medium.notes.find((n) => n.id === first.id)!.vel).toBe(0.3);
    st().updateSong({ title: 'renamed' });
    expect(st().past.length).toBe(1);
    st().updateSong({ arrangements: { ...back.arrangements } });
    expect(st().past.length).toBe(0);
    expect(st().future.length).toBe(0);
  });
});
