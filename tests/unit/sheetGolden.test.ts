/**
 * Golden MusicXML of songs without sheet edits, captured before sheet editing existed: the
 * sheet of an old song must stay byte-identical at every level (UPDATE_GOLDEN=1 rewrites them).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/lib/music/types';
import { buildSheet, toMusicXml } from '../../src/lib/sheet';
import { GOLDEN_SONGS } from './sheetSongs';

const dir = path.join(__dirname, '__golden__');

describe('sheet golden MusicXML (songs without sheet edits)', () => {
  for (const [name, make] of GOLDEN_SONGS) {
    const song = make();
    for (const d of DIFFICULTIES) {
      it(`${name} ${d}`, () => {
        const xml = toMusicXml(buildSheet(song, d), { title: name, date: '2026-01-01', credits: true });
        const file = path.join(dir, `${name}-${d}.musicxml`);
        if (process.env.UPDATE_GOLDEN || !fs.existsSync(file)) fs.writeFileSync(file, xml);
        expect(xml === fs.readFileSync(file, 'utf8')).toBe(true);
      });
    }
  }
});
