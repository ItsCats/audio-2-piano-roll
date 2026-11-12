import { describe, expect, it } from 'vitest';
import { AT_A_GLANCE, EXPECTATIONS, MAESTRO_ROWS, SONG_ROWS } from '../../src/lib/accuracyStats';

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
});
