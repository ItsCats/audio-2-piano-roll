/** Names of the beat units a tempo is given in (♩ = 72, ♩. = 60 …), for the UI. */
import type { TempoUnit } from '../music/types';

export const UNIT_LABEL: Record<TempoUnit, string> = {
  q: '♩',
  h: '𝅗𝅥',
  e: '♪',
  'q.': '♩.',
};
export const UNIT_NAME: Record<TempoUnit, string> = {
  q: 'Quarter',
  h: 'Half',
  e: 'Eighth',
  'q.': 'Dotted quarter',
};
export const TEMPO_UNITS: TempoUnit[] = ['q', 'q.', 'h', 'e'];

/** A tempo number as shown (one decimal at most). */
export const tempoNumber = (x: number): string => String(Math.round(x * 10) / 10);
