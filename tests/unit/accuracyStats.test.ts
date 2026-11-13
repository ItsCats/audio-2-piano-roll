import { describe, expect, it } from 'vitest';
import { AT_A_GLANCE, EXPECTATIONS, LIMITATIONS, MAESTRO_ROWS, SHEET_READER, SONG_ROWS, SPECIALIST, SPECIALIST_ROWS } from '../../src/lib/accuracyStats';

const pct = (x: number) => Math.round(x * 100);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// The Accuracy page states some figures twice (per-row tables and headline cards). Keep them consistent.
describe('Accuracy page figures', () => {
  it('headline cards match the per-piece and per-song rows', () => {
    const [piano, mic, bass] = AT_A_GLANCE;
    expect(piano.value).toBe(`${pct(mean(MAESTRO_ROWS.map((r) => r.f1)))}%`);
    const f1s = MAESTRO_ROWS.map((r) => pct(r.f1));
    expect(piano.sub).toContain(`${Math.min(...f1s)}–${Math.max(...f1s)}%`);
    expect(piano.sub).toContain(`was ${pct(mean(MAESTRO_ROWS.map((r) => r.before)))}%`);
    expect(mic.value).toBe(`${pct(mean(SONG_ROWS.map((r) => r.easy)))}%`);
    expect(bass.value).toBe(`${pct(mean(SONG_ROWS.map((r) => r.bass)))}%`);
  });

  it('the clean-piano expectation spans the Bach, Debussy and Mozart scores', () => {
    const clean = MAESTRO_ROWS.filter((r) => /Bach|Debussy|Mozart/.test(r.piece)).map((r) => pct(r.f1));
    const e = EXPECTATIONS.find((x) => x.kind === 'Clean solo piano')!;
    expect(e.summary).toContain(`${Math.min(...clean)}–${Math.max(...clean)}%`);
  });

  it('the virtuoso expectation spans the Chopin and Liszt scores, per preset', () => {
    const hard = MAESTRO_ROWS.filter((r) => /Chopin|Liszt/.test(r.piece));
    const piano = hard.map((r) => pct(r.f1));
    const sensitive = hard.map((r) => pct(r.f1Sensitive));
    const e = EXPECTATIONS.find((x) => x.kind === 'Virtuoso or heavily pedalled piano')!;
    expect(e.summary).toContain(`${Math.min(...piano)}–${Math.max(...piano)}% of notes right on concert performances with “Piano solo”`);
    expect(e.summary).toContain(`(${Math.min(...sensitive)}–${Math.max(...sensitive)}% with “Sensitive”)`);
  });

  it('the high-accuracy averages leave out the training-data piece and match the rows', () => {
    const test = SPECIALIST_ROWS.filter((r) => !r.inTraining);
    expect(test).toHaveLength(5);
    expect(SPECIALIST_ROWS.filter((r) => r.inTraining).map((r) => r.piece)).toEqual([expect.stringContaining('Ballade')]);
    const m = (k: 'f1' | 'f1Fast' | 'ends' | 'endsFast' | 'velR' | 'velRFast') => mean(test.map((r) => r[k]));
    for (const k of ['f1', 'f1Fast', 'ends', 'endsFast', 'velR', 'velRFast'] as const) expect(SPECIALIST.mean[k]).toBeCloseTo(m(k), 2);
    // the fast-model column is the "Piano solo" score of the table above
    for (const key of ['BWV 850', 'neige', 'K. 280', 'Op. 15', 'Waldesrauschen', 'Ballade']) {
      const a = SPECIALIST_ROWS.find((x) => x.piece.includes(key));
      const b = MAESTRO_ROWS.find((x) => x.piece.includes(key));
      expect(a && b, key).toBeTruthy();
      expect(pct(a!.f1Fast)).toBe(pct(b!.f1));
    }
    expect(AT_A_GLANCE[0].sub).toContain(`${pct(SPECIALIST.mean.f1)}% on the 5 it was not trained on`);
    const ends = test.map((r) => pct(r.ends));
    expect(LIMITATIONS.find((l) => l.title.startsWith('Note lengths'))!.body).toContain(`${Math.min(...ends)}–${Math.max(...ends)}%`);
  });
});

describe('sheet-music reader numbers', () => {
  it('every row has both numbers, photos are labelled simulated, and the measure is explained', () => {
    for (const r of SHEET_READER.rows) {
      expect(r.before).toMatch(/^\d+%$/);
      expect(r.after).toMatch(/^(\d+%|—)$/);
      if (/photo/i.test(r.what)) expect(r.what).toMatch(/Simulated/);
    }
    expect(SHEET_READER.intro).toMatch(/real phone photos have not been measured/);
    expect(SHEET_READER.metric).toMatch(/wrong time/);
    expect(SHEET_READER.limits.map((l) => l.title)).toEqual(expect.arrayContaining(['Lay the page flat', 'Very high or very low notes']));
  });
});
