/**
 * What an audio song was analyzed with, worked out from its stored TranscriptionInfo (the detection
 * preset itself is not stored): for "Analyze again" (the preset it starts on, "Last time: …") and the
 * version card.
 */
import type { ExtractionParams, TranscriptionInfo } from '../music/types';
import { EXTRACTION_PRESETS, sameParams, withLeadPass, type TranscriptionEngine } from './pipeline';

/** Detection preset ids (as settings.detectionPreset and importStore PresetId). */
export type AnalysisPreset = 'piano' | 'mix' | 'sensitive' | 'custom';

const isAudioInfo = (info: TranscriptionInfo) => info.method === 'basic-pitch' || info.method === 'piano-specialist';

/**
 * The detection preset a song was analyzed with: the high-accuracy piano model and "Remove singing and
 * drums" only run with Piano solo, the piano-model blend only with Full song; otherwise the stored
 * detection parameters are compared with the presets (and with `custom`, the custom thresholds from
 * Settings). Songs separated by an older version (only `separated` stored): Full song. null: not known
 * (parameters that match no preset any more, and songs not from audio).
 */
export function presetOfInfo(info: TranscriptionInfo, custom?: ExtractionParams): AnalysisPreset | null {
  if (!isAudioInfo(info)) return null;
  if (info.method === 'piano-specialist' || info.separation?.pianoPart) return 'piano';
  if (info.pianoBlend) return 'mix';
  if (info.params) {
    const p = withLeadPass(info.params);
    for (const k of ['piano', 'mix', 'sensitive'] as const) if (sameParams(p, withLeadPass(EXTRACTION_PRESETS[k]))) return k;
    if (custom && sameParams(info.params, custom)) return 'custom';
  }
  if (info.separated && !info.separation) return 'mix';
  return null;
}

/** What the analysis used: preset, model, separation and the piano-model blend. */
export interface AnalysisChoice {
  preset: AnalysisPreset | null;
  transcriber: TranscriptionEngine;
  separated: boolean;
  blend: boolean;
}

export function choiceOf(info: TranscriptionInfo, custom?: ExtractionParams): AnalysisChoice {
  return {
    preset: presetOfInfo(info, custom),
    transcriber: info.method === 'piano-specialist' ? 'piano-specialist' : 'basic-pitch',
    separated: !!info.separation || !!info.separated,
    blend: !!info.pianoBlend,
  };
}

const PRESET_LABEL: Record<AnalysisPreset, string> = { piano: 'Piano solo', mix: 'Full song', sensitive: 'Sensitive', custom: 'Custom settings' };

/**
 * "Piano solo · high-accuracy piano model · singing and drums removed", "Full song · vocals & drums
 * separated · high-accuracy piano model", "Sensitive". Empty for songs not from audio.
 */
export function analysisLabel(info: TranscriptionInfo, custom?: ExtractionParams): string {
  if (!isAudioInfo(info)) return '';
  const c = choiceOf(info, custom);
  const preset = c.preset ? PRESET_LABEL[c.preset] : 'Earlier settings';
  const sep = info.separation?.pianoPart ? 'singing and drums removed' : c.separated ? 'vocals & drums separated' : null;
  const model = c.preset === 'piano' ? (c.transcriber === 'piano-specialist' ? 'high-accuracy piano model' : 'standard model') : c.preset === 'mix' && c.blend ? 'high-accuracy piano model' : null;
  const parts = c.preset === 'piano' ? [preset, model, sep] : [preset, sep, model];
  return parts.filter((x): x is string => !!x).join(' · ');
}

/** The options "Analyze again" is about to run with. */
export interface ReanalyzeChoice {
  presetId: AnalysisPreset;
  separate: boolean;
  transcriber: TranscriptionEngine;
  pianoBlend: boolean;
}

/** The chosen options are the ones the song was analyzed with (the notes will most likely come out the same). */
export function sameAsLast(info: TranscriptionInfo, choice: ReanalyzeChoice, custom?: ExtractionParams): boolean {
  const c = choiceOf(info, custom);
  if (!c.preset || c.preset !== choice.presetId) return false;
  // the piano model outside Piano solo does not separate (importStore separationUnused)
  return c.transcriber === choice.transcriber && c.separated === choice.separate && c.blend === choice.pianoBlend;
}
