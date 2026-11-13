/**
 * Performance order of a score's measures: repeats, volta endings, D.C. / D.S., To Coda / Coda,
 * Fine and sections. The conventions follow MuseScore's playback (checked against MuseScore's
 * own repeat test suite), which is how most players read a score:
 * - A backward repeat goes back to the last forward repeat, or to the start of the piece /
 *   section when there is none. Each backward repeat is taken `times − 1` times (once usually).
 * - The pass number of a repeated section picks the volta bracket to play; a bracket that is not
 *   the last of its group and has no repeat sign implies one.
 * - Each D.C. / D.S. is taken once (inside a repeated section: on its last pass). On the pass after
 *   it, repeats are not taken again (unless the
 *   jump says so) and only the last bracket of a volta group is played; the pass stops at "Fine"
 *   or jumps from "To Coda" to the coda, after which repeats are played again.
 */
import type { IRJump, IRMeasure } from './ir';

export interface PerformedMeasure {
  /** Index into the written measures. */
  index: number;
  /** Pass number of the repeat section (1 the first time). */
  pass: number;
}

const MAX_PERFORMED = 20000;

export function unroll(measures: IRMeasure[]): { order: PerformedMeasure[]; warnings: string[] } {
  const warnings: string[] = [];
  const n = measures.length;
  const order: PerformedMeasure[] = [];
  if (!n) return { order, warnings };

  // volta groups: consecutive brackets; for each bracket the measure after it, and whether it is the group's last
  const bracketEnd = new Map<number, number>();
  const groupLast = new Map<number, boolean>();
  for (let i = 0; i < n; i++) {
    const e = measures[i].ending;
    if (e) bracketEnd.set(e.id, i + 1);
  }
  for (const [id, after] of bracketEnd) {
    const next = measures[after]?.ending;
    groupLast.set(id, !next || next.id === id);
  }
  // a bracket that is not the last of its group but has no repeat sign implies one at its end; a
  // repeat sign without a count (MusicXML) inside a volta group is taken until the group's last pass
  const repeatEnd: (number | undefined)[] = measures.map((m) => m.repeatEnd);
  for (let i = 0; i < n; ) {
    if (!measures[i].ending) {
      i++;
      continue;
    }
    let j = i;
    let max = 1;
    while (j < n && measures[j].ending) max = Math.max(max, ...measures[j++].ending!.passes);
    for (let k = i; k < j; k++) {
      const id = measures[k].ending!.id;
      if (repeatEnd[k] && measures[k].repeatTimesImplied) repeatEnd[k] = Math.max(repeatEnd[k]!, max);
      else if (bracketEnd.get(id) === k + 1 && !groupLast.get(id)) repeatEnd[k] = max;
    }
    i = j;
  }

  /** start of the section (piece) each measure is in */
  const sectionOf: number[] = [];
  for (let i = 0, s = 0; i < n; i++) sectionOf.push(measures[i].newSection ? (s = i) : s);
  const nextSection = (from: number) => {
    for (let k = from + 1; k < n; k++) if (measures[k].newSection) return k;
    return -1;
  };
  const segnoFor = (from: number) => {
    // the closest segno before the jump in its section, else any
    for (let i = from; i >= sectionOf[from]; i--) if (measures[i].segno) return i;
    return measures.findIndex((m) => m.segno);
  };
  /** The coda for a jump made from measure `from` (numbered codas match their number). */
  const codaAfter = (from: number, id?: string) => {
    const ok = (m: IRMeasure) => m.coda && (!id || !m.codaId || m.codaId === id);
    for (let i = from + 1; i < n; i++) if (ok(measures[i])) return i;
    for (let i = 0; i < n; i++) if (ok(measures[i])) return i;
    return -1;
  };

  const done = new Map<number, number>(); // backward-repeat measure → times taken
  /** A backward repeat at or after i (before the next forward repeat) will still be taken: a jump waits for the last pass. */
  const repeatPending = (at: number) => {
    for (let k = at; k < n; k++) {
      if (k > at && (measures[k].repeatStart || measures[k].newSection)) return false;
      const t = repeatEnd[k];
      if (t) return (done.get(k) ?? 0) + 1 < t;
    }
    return false;
  };

  let i = 0;
  let pass = 1;
  let repeatStart = 0;
  let playRepeats = true;
  /** the D.C. / D.S. being followed, and the measure it was taken from */
  let active: (IRJump & { from: number }) | null = null;
  const jumpsTaken = new Set<number>();
  let cameBack = false; // arrived at i by going back (repeat or jump)

  while (i < n) {
    if (order.length >= MAX_PERFORMED) {
      warnings.push('The repeat structure could not be followed completely; playback stops early.');
      break;
    }
    const m = measures[i];
    if (m.newSection && !cameBack && i > 0) {
      // a new section (piece / movement): repeats and jumps start afresh
      repeatStart = i;
      pass = 1;
      playRepeats = true;
      active = null;
    }
    // volta: skip brackets that are not for this pass
    if (m.ending) {
      const isLast = groupLast.get(m.ending.id) ?? true;
      // after a D.C. / D.S. (without "play repeats"), brackets already played: only the last one
      const replay = active && !playRepeats && i < active.from;
      const play = replay ? isLast : m.ending.passes.includes(pass);
      if (!play) {
        i = bracketEnd.get(m.ending.id) ?? i + 1;
        cameBack = false;
        continue;
      }
    }
    if (m.repeatStart && !cameBack) {
      repeatStart = i;
      pass = 1;
    }
    cameBack = false;
    order.push({ index: i, pass });

    const act = active as (IRJump & { from: number }) | null;
    if (act && act.exact) {
      // the file says where this pass ends (nowhere: to the end)
      if (i === act.until) {
        if (act.codaAt === undefined) {
          // Fine: the end of the piece, or of this section (the next one follows)
          const next = nextSection(i);
          if (next < 0) break;
          i = next;
          continue;
        }
        i = act.codaAt;
        active = null;
        playRepeats = true;
        continue;
      }
    } else if (act) {
      if (m.fine && !act.alCoda) {
        const next = nextSection(i);
        if (next < 0) break;
        i = next;
        continue;
      }
      if (m.toCoda && !act.alFine && (!act.codaId || !m.toCodaId || act.codaId === m.toCodaId)) {
        const c = codaAfter(act.from, act.codaId ?? m.toCodaId);
        if (c >= 0 && c !== i) {
          i = c;
          active = null;
          playRepeats = true;
          continue;
        }
      }
    }
    const times = repeatEnd[i];
    // (repeats already taken are not taken again after a jump, unless it says "play repeats")
    if (times) {
      const d = done.get(i) ?? 0;
      if (d + 1 < times) {
        done.set(i, d + 1);
        pass++;
        i = repeatStart;
        cameBack = true;
        continue;
      }
    }
    if (m.jump && !jumpsTaken.has(i) && !repeatPending(i)) {
      jumpsTaken.add(i);
      active = { ...m.jump, from: i };
      playRepeats = !!m.jump.playRepeats;
      if (playRepeats) done.clear();
      pass = 1;
      let to = sectionOf[i];
      if (m.jump.target !== undefined && m.jump.target >= 0 && m.jump.target < n) to = m.jump.target;
      else if (m.jump.to === 'segno') {
        const s = segnoFor(i);
        if (s >= 0) to = s;
        else warnings.push('The score says D.S. but has no segno sign: playing from the start instead.');
      }
      if (playRepeats) repeatStart = to;
      i = to;
      cameBack = true;
      continue;
    }
    i++;
  }
  return { order, warnings };
}
