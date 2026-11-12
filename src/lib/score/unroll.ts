/**
 * Performance order of a score's measures: repeats (with an implicit start at the beginning or
 * after the previous repeat / volta group), volta endings, D.C. / D.S., To Coda / Coda and Fine.
 *
 * Conventions (as most players and notation programs do it):
 * - A backward repeat with no forward repeat before it goes back to the start of the piece, or to
 *   the measure after the previous backward repeat / volta group.
 * - On the pass after a D.C. / D.S., repeats are not taken again and only the last volta of a
 *   group is played; that pass stops after a "Fine" and jumps from "To Coda" to the coda.
 * - Each D.C. / D.S. is taken once.
 */
import type { IRMeasure } from './ir';

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

  // volta groups: consecutive brackets; for each bracket, the measure after it and whether it is the group's last
  const bracketEnd = new Map<number, number>(); // bracket id → index after it
  const groupLast = new Map<number, boolean>(); // bracket id → last bracket of its group
  for (let i = 0; i < n; i++) {
    const e = measures[i].ending;
    if (!e) continue;
    bracketEnd.set(e.id, i + 1);
  }
  for (const [id, after] of bracketEnd) {
    const next = measures[after]?.ending;
    groupLast.set(id, !next || next.id === id);
  }
  // backward repeats: inside a volta group they are taken until the group's last pass; a bracket
  // that is not the group's last but has no repeat sign implies one at its end
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
      const lastOfBracket = bracketEnd.get(id) === k + 1;
      if (repeatEnd[k]) repeatEnd[k] = Math.max(repeatEnd[k]!, max);
      else if (lastOfBracket && !groupLast.get(id)) repeatEnd[k] = max;
    }
    i = j;
  }
  const segnoAt = measures.findIndex((m) => m.segno);
  const codaAt = (from: number) => {
    for (let i = from + 1; i < n; i++) if (measures[i].coda) return i;
    for (let i = 0; i < n; i++) if (measures[i].coda) return i;
    return -1;
  };

  let i = 0;
  let pass = 1;
  let sectionStart = 0;
  let afterJump = false;
  const repeatsDone = new Map<number, number>(); // repeat-end index → times played so far
  const jumpsTaken = new Set<number>();
  let prevHadEnding = false;
  let cameBack = false; // arrived at i through a backward repeat

  while (i < n) {
    if (order.length >= MAX_PERFORMED) {
      warnings.push('The repeat structure could not be followed completely; playback stops early.');
      break;
    }
    const m = measures[i];
    // volta: skip brackets that are not for this pass
    if (m.ending) {
      const isLast = groupLast.get(m.ending.id) ?? true;
      const play = afterJump ? isLast : m.ending.passes.includes(pass) || (isLast && pass > Math.max(...m.ending.passes) && !hasLaterBracketFor(measures, i, pass));
      if (!play) {
        i = bracketEnd.get(m.ending.id) ?? i + 1;
        prevHadEnding = true;
        continue;
      }
    } else if (prevHadEnding && !cameBack) {
      // a volta group is over: the next repeat goes back to here
      sectionStart = i;
      pass = 1;
    }
    if (m.repeatStart && !cameBack) {
      sectionStart = i;
      pass = 1;
    }
    cameBack = false;
    prevHadEnding = !!m.ending;
    order.push({ index: i, pass });

    if (afterJump && m.fine) break;
    if (afterJump && m.toCoda) {
      const c = codaAt(i);
      if (c >= 0 && c !== i) {
        i = c;
        prevHadEnding = false;
        continue;
      }
    }
    const times = repeatEnd[i];
    if (times && !afterJump) {
      const done = repeatsDone.get(i) ?? 1;
      if (done < times) {
        repeatsDone.set(i, done + 1);
        pass = done + 1;
        i = sectionStart;
        cameBack = true;
        continue;
      }
      repeatsDone.delete(i);
      if (!m.ending) {
        sectionStart = i + 1;
        pass = 1;
      }
    }
    if (m.jump && !jumpsTaken.has(i)) {
      jumpsTaken.add(i);
      afterJump = true;
      pass = 1;
      prevHadEnding = false;
      let to = 0;
      if (m.jump.to === 'segno') {
        if (segnoAt >= 0) to = segnoAt;
        else warnings.push('The score says D.S. but has no segno sign: playing from the start instead.');
      }
      i = to;
      cameBack = true;
      continue;
    }
    i++;
  }
  return { order, warnings };
}

/** Whether a bracket later in the same volta group is marked for this pass. */
function hasLaterBracketFor(measures: IRMeasure[], i: number, pass: number): boolean {
  const id = measures[i].ending?.id;
  for (let k = i + 1; k < measures.length; k++) {
    const e = measures[k].ending;
    if (!e) return false;
    if (e.id !== id && e.passes.includes(pass)) return true;
  }
  return false;
}
