import { useEffect, useRef } from 'react';
import { PianoRollRenderer, type EditOverlay } from '../../lib/render/renderer';
import { midiAtX } from '../../lib/render/layout';
import { useSettings } from '../../state/settingsStore';
import { currentArrangement, useStudio } from '../../state/studioStore';
import { useTransport } from '../../state/transportStore';
import { getPlayer } from '../../state/playback';
import { currentMarks, liveKeys } from '../../state/liveInput';
import { beatToTime, snapTime, timeToBeat } from '../../lib/music/beats';
import type { Note } from '../../lib/music/types';
import { useBackgroundMedia } from './useBackgroundMedia';
import { midiInput } from '../../lib/midiInput/webmidi';

type Drag =
  | { mode: 'move' | 'resize-end' | 'resize-start'; x0: number; y0: number; anchor: Note; originals: Map<number, Note>; key: string; moved: boolean }
  | { mode: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: Set<number> }
  | { mode: 'scrub'; y0: number; t0: number }
  | { mode: 'keys'; midi: number };

let dragSeq = 0;

export function PianoRollView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PianoRollRenderer | null>(null);
  const dirty = useRef(true);
  const drag = useRef<Drag | null>(null);
  const hover = useRef<number | null>(null);
  const ghost = useRef<Note | null>(null);
  const marquee = useRef<EditOverlay['marquee']>(null);
  const visual = useSettings((s) => s.visual);
  const song = useStudio((s) => s.song);
  const arrangement = useStudio(currentArrangement);
  const editMode = useStudio((s) => s.editMode);
  const selection = useStudio((s) => s.selection);
  const transport = useTransport();
  const bg = useBackgroundMedia(visual.background);

  // create renderer once
  useEffect(() => {
    const canvas = canvasRef.current!;
    rendererRef.current = new PianoRollRenderer(canvas, useSettings.getState().visual);
    return () => {
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setSettings(visual);
    dirty.current = true;
  }, [visual]);

  useEffect(() => {
    if (!song || !arrangement) return;
    rendererRef.current?.setNotes(arrangement.notes, arrangement.pedal, song.tempo, song.key);
    dirty.current = true;
  }, [arrangement, song]);

  useEffect(() => {
    rendererRef.current?.setBackgroundMedia(bg.source, bg.kind);
    dirty.current = true;
  }, [bg.source, bg.kind]);

  useEffect(() => {
    dirty.current = true;
  }, [selection, editMode, transport.loop, transport.loopEnabled, transport.hands]);

  // resize with device pixel ratio
  useEffect(() => {
    const el = containerRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const canvas = canvasRef.current!;
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      rendererRef.current?.resize(r.width * dpr, r.height * dpr);
      dirty.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // render loop
  useEffect(() => {
    let raf = 0;
    let lastTime = -1;
    const player = getPlayer();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const r = rendererRef.current;
      if (!r) return;
      const t = player.getVisualTime();
      const playing = player.isPlaying;
      const marks = currentMarks();
      const bgVideo = bg.kind === 'video';
      if (!playing && !dirty.current && t === lastTime && !marks && !liveKeys.size && !bgVideo) return;
      lastTime = t;
      dirty.current = false;
      const st = useStudio.getState();
      const tr = useTransport.getState();
      let edit: EditOverlay | null = null;
      if (st.editMode && st.song) {
        const tempo = st.song.tempo;
        const grid: EditOverlay['grid'] = [];
        const tTop = r.yToTime(0, t);
        const b0 = Math.floor(timeToBeat(tempo.beats, t, tempo.bpm));
        const b1 = Math.ceil(timeToBeat(tempo.beats, tTop, tempo.bpm));
        for (let b = b0; b <= b1 && grid.length < 2000; b++) {
          for (let k = 0; k < tr.gridDivision; k++) {
            grid.push({ t: beatToTime(tempo.beats, b + k / tr.gridDivision, tempo.bpm), strong: k === 0 });
          }
        }
        edit = { selected: st.selection, hover: hover.current, grid, ghost: ghost.current, marquee: marquee.current };
      }
      const countIn = player.getCountInRemaining();
      r.render({
        time: t,
        liveKeys: liveKeys.size ? liveKeys : undefined,
        keyMarks: marks,
        mutedHands: { L: !tr.hands.L, R: !tr.hands.R },
        loop: tr.loopEnabled ? tr.loop : null,
        edit,
        countIn: countIn > 0 ? Math.ceil(countIn / (60 / (st.song?.tempo.bpm ?? 120) / tr.rate)) : 0,
        pedalOverride: player.engine.isPedalDown || undefined,
      });
    };
    raf = requestAnimationFrame(frame);
    const unsub = player.subscribe(() => (dirty.current = true));
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [bg.kind]);

  /* ---------------- interaction ---------------- */
  const toDevice = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const dpr = rendererRef.current!.width / rect.width;
    return { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr };
  };
  const snap = (t: number) => {
    const st = useStudio.getState();
    const tr = useTransport.getState();
    if (!tr.snap || !st.song) return t;
    return snapTime(st.song.tempo.beats, st.song.tempo.bpm, t, tr.gridDivision);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const r = rendererRef.current;
    if (!r) return;
    const { x, y } = toDevice(e);
    const player = getPlayer();
    const now = player.getVisualTime();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // keyboard area: play the key
    if (y >= r.hitY) {
      const midi = midiAtX(r.keyLayout, x, y < r.hitY + r.keyboardHeight * 0.63);
      if (midi !== null) {
        drag.current = { mode: 'keys', midi };
        midiInput.emit({ type: 'noteon', midi, velocity: 0.7, device: 'screen' });
      }
      return;
    }
    const st = useStudio.getState();
    if (!st.editMode) {
      drag.current = { mode: 'scrub', y0: y, t0: player.getTime() };
      return;
    }
    const hit = r.hitTest(x, y, now);
    if (hit) {
      const id = hit.note.id;
      if (e.shiftKey || e.metaKey || e.ctrlKey) st.select([id], true);
      else if (!st.selection.has(id)) st.select([id]);
      const sel = useStudio.getState().selection;
      const arr = currentArrangement(useStudio.getState());
      const originals = new Map((arr?.notes ?? []).filter((n) => sel.has(n.id)).map((n) => [n.id, { ...n }]));
      drag.current = {
        mode: hit.edge === 'top' ? 'resize-end' : hit.edge === 'bottom' ? 'resize-start' : 'move',
        x0: x,
        y0: y,
        anchor: { ...hit.note },
        originals,
        key: `drag-${++dragSeq}`,
        moved: false,
      };
      player.liveNoteOn(hit.note.midi, hit.note.vel);
      window.setTimeout(() => player.liveNoteOff(hit.note.midi), 250);
    } else {
      const base = e.shiftKey ? new Set(st.selection) : new Set<number>();
      if (!e.shiftKey) st.clearSelection();
      drag.current = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y, base };
    }
    dirty.current = true;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const r = rendererRef.current;
    if (!r) return;
    const { x, y } = toDevice(e);
    const player = getPlayer();
    const now = player.getVisualTime();
    const d = drag.current;
    const canvas = canvasRef.current!;
    if (!d) {
      if (!useStudio.getState().editMode || y >= r.hitY) {
        canvas.style.cursor = y >= r.hitY ? 'pointer' : 'grab';
        if (hover.current !== null) {
          hover.current = null;
          dirty.current = true;
        }
        return;
      }
      const hit = r.hitTest(x, y, now);
      canvas.style.cursor = hit ? (hit.edge === 'body' ? 'move' : 'ns-resize') : 'crosshair';
      const id = hit?.note.id ?? null;
      if (id !== hover.current) {
        hover.current = id;
        dirty.current = true;
      }
      return;
    }
    if (d.mode === 'keys') return;
    if (d.mode === 'scrub') {
      const dt = (y - d.y0) / r.pxPerSec;
      player.seek(Math.max(0, d.t0 + dt));
      return;
    }
    if (d.mode === 'marquee') {
      d.x1 = x;
      d.y1 = y;
      marquee.current = { x0: d.x0, y0: d.y0, x1: x, y1: y };
      const arr = currentArrangement(useStudio.getState());
      const minX = Math.min(d.x0, x);
      const maxX = Math.max(d.x0, x);
      const minY = Math.min(d.y0, y);
      const maxY = Math.max(d.y0, y);
      const ids = new Set(d.base);
      for (const n of arr?.notes ?? []) {
        const rect = r.noteRect(n, now);
        if (rect && rect.x < maxX && rect.x + rect.w > minX && rect.y < maxY && rect.y + rect.h > minY) ids.add(n.id);
      }
      useStudio.setState({ selection: ids });
      dirty.current = true;
      return;
    }
    if (Math.abs(x - d.x0) + Math.abs(y - d.y0) < 4 && !d.moved) return;
    d.moved = true;
    const dt = (d.y0 - y) / r.pxPerSec;
    const a = d.anchor;
    const minDur = 0.03;
    if (d.mode === 'move') {
      const newStart = Math.max(0, snap(a.start + dt));
      const delta = newStart - a.start;
      const targetMidi = midiAtX(r.keyLayout, x, true);
      const dp = targetMidi !== null && Math.abs(x - d.x0) > r.keyLayout.whiteW * 0.4 ? targetMidi - a.midi : 0;
      useStudio.getState().edit(
        (notes) =>
          notes.map((n) => {
            const o = d.originals.get(n.id);
            return o ? { ...n, start: Math.max(0, o.start + delta), midi: Math.max(21, Math.min(108, o.midi + dp)) } : n;
          }),
        { coalesceKey: d.key },
      );
    } else if (d.mode === 'resize-end') {
      const newEnd = snap(a.start + a.dur + dt);
      const delta = newEnd - (a.start + a.dur);
      useStudio.getState().edit(
        (notes) => notes.map((n) => {
          const o = d.originals.get(n.id);
          return o ? { ...n, dur: Math.max(minDur, o.dur + delta) } : n;
        }),
        { coalesceKey: d.key },
      );
    } else if (d.mode === 'resize-start') {
      const newStart = Math.max(0, snap(a.start + dt));
      const delta = newStart - a.start;
      useStudio.getState().edit(
        (notes) => notes.map((n) => {
          const o = d.originals.get(n.id);
          if (!o) return n;
          const end = o.start + o.dur;
          const s = Math.min(end - minDur, Math.max(0, o.start + delta));
          return { ...n, start: s, dur: end - s };
        }),
        { coalesceKey: d.key },
      );
    }
    dirty.current = true;
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (d?.mode === 'keys') midiInput.emit({ type: 'noteoff', midi: d.midi, device: 'screen' });
    drag.current = null;
    marquee.current = null;
    dirty.current = true;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const r = rendererRef.current;
    const st = useStudio.getState();
    if (!r || !st.editMode || !st.song) return;
    const { x, y } = toDevice(e);
    if (y >= r.hitY) return;
    const now = getPlayer().getVisualTime();
    if (r.hitTest(x, y, now)) return;
    const midi = midiAtX(r.keyLayout, x, true);
    if (midi === null) return;
    const t = Math.max(0, snap(r.yToTime(y, now)));
    const beat = 60 / st.song.tempo.bpm;
    const dur = Math.max(0.1, beat / Math.max(1, useTransport.getState().gridDivision / 2));
    st.addNote({ midi, start: t, dur, vel: 0.7, hand: midi < 60 ? 'L' : 'R' });
    getPlayer().liveNoteOn(midi, 0.7);
    window.setTimeout(() => getPlayer().liveNoteOff(midi), 250);
  };

  const onWheel = (e: React.WheelEvent) => {
    const player = getPlayer();
    const r = rendererRef.current;
    if (!r) return;
    if (e.ctrlKey) {
      // zoom: change how many seconds are visible
      const s = useSettings.getState();
      const next = Math.max(0.8, Math.min(12, s.visual.lookahead * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
      s.setVisual({ lookahead: Math.round(next * 100) / 100 });
      return;
    }
    if (player.isPlaying) return;
    const secPerPx = (r.yToTime(0, 0) - r.yToTime(1, 0)) * (r.width / canvasRef.current!.getBoundingClientRect().width);
    player.seek(Math.max(0, player.getTime() - e.deltaY * secPerPx));
  };

  return (
    <div ref={containerRef} className="relative h-full w-full touch-none overflow-hidden bg-black select-none" onWheel={onWheel}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        aria-label="Piano roll"
        role="img"
      />
    </div>
  );
}
