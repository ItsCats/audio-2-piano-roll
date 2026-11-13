import { resolveMeter } from '../../../lib/sheet/grid';
import { readFromSheet, readerWhat } from '../SheetReaderNotice';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Wand2 } from 'lucide-react';
import { useStudio } from '../../../state/studioStore';
import { detectionParams } from '../../../state/settingsStore';
import { getPosteriors } from '../../../lib/storage/db';
import { redetectNotes, withLeadPass, EXTRACTION_PRESETS } from '../../../lib/transcription/pipeline';
import { regularBeats } from '../../../lib/music/beats';
import { detectKey } from '../../../lib/music/theory';
import { generateAllArrangements } from '../../../lib/music/difficulty';
import type { Difficulty, ExtractionParams } from '../../../lib/music/types';
import { Badge, Button, Section, Slider, Toggle } from '../../ui';
import { toast } from '../../../state/toastStore';
import { arrangementOptions, makeThumbnail } from '../../../lib/songs';

function LevelStats() {
  const song = useStudio((s) => s.song)!;
  const rows = (['easy', 'medium', 'hard'] as Difficulty[]).map((d) => {
    const a = song.arrangements[d];
    const n = a.notes.length;
    let lo = 127;
    let hi = 0;
    for (const x of a.notes) {
      lo = Math.min(lo, x.midi);
      hi = Math.max(hi, x.midi);
    }
    return { d, n, density: song.duration ? n / song.duration : 0, span: n ? hi - lo : 0, edited: a.edited };
  });
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="text-left text-[11px] text-ink-400">
          <th className="font-medium">Level</th>
          <th className="text-right font-medium">Notes</th>
          <th className="text-right font-medium">Notes/s</th>
          <th className="text-right font-medium">Span</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.d} className="text-ink-100">
            <td className="py-0.5 capitalize">
              {r.d} {r.edited && <Badge tone="accent">edited</Badge>}
            </td>
            <td className="text-right font-mono tabular-nums">{r.n}</td>
            <td className="text-right font-mono tabular-nums">{r.density.toFixed(1)}</td>
            <td className="text-right font-mono tabular-nums">{r.span} st</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ArrangementPanel() {
  const song = useStudio((s) => s.song)!;
  const replaceSong = useStudio((s) => s.replaceSong);
  const regenerateLevels = useStudio((s) => s.regenerateLevels);
  const difficulty = useStudio((s) => s.difficulty);
  const [params, setParams] = useState<ExtractionParams>(() => withLeadPass(song.transcription.params ?? detectionParams()));
  const [busy, setBusy] = useState(false);
  const [bpm, setBpm] = useState(String(song.tempo.bpm));
  const t = song.transcription;
  const estimated = t.estimated;

  const redetect = async () => {
    const edited = (['easy', 'medium', 'hard'] as Difficulty[]).filter((d) => song.arrangements[d].edited);
    if (edited.length && !confirm(`Re-detecting replaces your edits to ${edited.join(', ')}. Continue?`)) return;
    setBusy(true);
    try {
      const post = await getPosteriors(song.id);
      if (!post) throw new Error('The analysis data for this song is no longer stored. Re-import the audio to re-detect.');
      // keep the sung melody line (role 'melody') of separated songs: only the accompaniment is
      // re-detected, and the beats come from it alone, as on import
      const det = await redetectNotes(post, params, song.duration, { melody: song.base.filter((n) => n.role === 'melody') });
      const notes = det.notes;
      const tempo = song.tempo.source === 'manual' ? song.tempo : det.tempo;
      replaceSong({
        ...song,
        base: notes,
        tempo,
        key: detectKey(notes),
        arrangements: generateAllArrangements(notes, song.basePedal, tempo, song.duration, arrangementOptions(song)),
        transcription: { ...t, params },
        thumbnail: makeThumbnail(notes, song.duration),
        updatedAt: Date.now(),
      });
      toast.success('Notes re-detected', `${notes.length} notes with the new settings.`);
    } catch (e) {
      toast.error('Re-detection failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyBpm = () => {
    const v = parseFloat(bpm);
    if (!Number.isFinite(v) || v < 20 || v > 300) {
      toast.error('Invalid tempo', 'Enter a BPM between 20 and 300.');
      return;
    }
    const first = song.tempo.beats[song.tempo.downbeatIndex] ?? song.base[0]?.start ?? 0;
    const tempo = { ...song.tempo, bpm: v, beats: regularBeats(v, first, song.duration), downbeatIndex: 0, source: 'manual' as const, confidence: 1 };
    replaceSong({ ...song, tempo, arrangements: generateAllArrangements(song.base, song.basePedal, tempo, song.duration, arrangementOptions(song)) });
    toast.success('Tempo updated', 'The beat grid and the Easy/Medium arrangements were regenerated.');
  };

  return (
    <div>
      <Section title="Transcription">
        {readFromSheet(song) ? (
          <div className="flex gap-2 rounded-lg border border-warn/25 bg-warn/10 p-3 text-[12.5px] leading-relaxed text-ink-100">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
            <div>
              <p className="font-medium text-warn">Read from {readerWhat(song)} (Beta)</p>
              <p className="mt-0.5 text-ink-200">
                The sheet-music reader estimated these notes from the page. Wrong rhythms and missing sharps or flats are the most common
                mistakes: compare with your page, then fix notes in Edit mode.{' '}
                <Link to="/accuracy#sheet-reader" className="text-accent-400 hover:text-accent-300">
                  How accurate is it?
                </Link>
              </p>
            </div>
          </div>
        ) : estimated ? (
          <div className="flex gap-2 rounded-lg border border-warn/25 bg-warn/10 p-3 text-[12.5px] leading-relaxed text-ink-100">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
            <div>
              <p className="font-medium text-warn">Estimated from audio</p>
              <p className="mt-0.5 text-ink-200">
                Notes were detected by a neural network and may contain mistakes — especially in dense mixes. Blend in the original recording
                (Sound tab) to compare, then fix notes in Edit mode.{' '}
                <Link to="/accuracy" className="text-accent-400 hover:text-accent-300">
                  How accurate is it?
                </Link>
              </p>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 rounded-lg border border-ok/25 bg-ok/10 p-3 text-[12.5px] text-ink-100">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
            <p>
              {t.method === 'midi-file'
                ? 'Exact notes from a MIDI file.'
                : t.method === 'score-file'
                  ? 'Exact notes from sheet music, with repeats played in order. Hard is the piece as written.'
                  : 'Demo arrangement with exact notes.'}
            </p>
          </div>
        )}
        <dl className="grid grid-cols-2 gap-y-1 text-[12.5px]">
          <dt className="text-ink-300">Tempo</dt>
          <dd className="text-right text-ink-100">
            {song.tempo.bpm} BPM {song.tempo.source === 'estimated' && song.tempo.confidence < 0.2 && <Badge tone="warn">uncertain</Badge>}
          </dd>
          <dt className="text-ink-300">Meter</dt>
          <dd className="text-right text-ink-100">
            {song.tempo.beatsPerBar}/{resolveMeter(song.tempo).beatUnit}
          </dd>
          {song.key && (
            <>
              <dt className="text-ink-300">Key</dt>
              <dd className="text-right text-ink-100">{song.key.name}</dd>
            </>
          )}
          {t.backend && (
            <>
              <dt className="text-ink-300">Engine</dt>
              <dd className="text-right text-ink-100">
                {t.method === 'piano-specialist' ? 'Piano model (Kong et al.)' : 'Basic Pitch'} · {t.backend.toUpperCase()}
              </dd>
            </>
          )}
          {t.processingMs !== undefined && (
            <>
              <dt className="text-ink-300">Processing time</dt>
              <dd className="text-right text-ink-100">{(t.processingMs / 1000).toFixed(1)} s</dd>
            </>
          )}
          {t.separation ? (
            <>
              <dt className="text-ink-300">Source separation</dt>
              <dd className="text-right text-ink-100">
                SCNet · {t.separation.engine === 'scnet-server' ? 'server' : 'browser'}
                {t.separation.ms > 0 && <span className="text-ink-300"> · {(t.separation.ms / 1000).toFixed(0)} s</span>}
              </dd>
            </>
          ) : (
            t.separated && (
              <>
                <dt className="text-ink-300">Source separation</dt>
                <dd className="text-right text-ink-100">Demucs</dd>
              </>
            )
          )}
        </dl>
        {t.separation && (
          <div className="flex flex-wrap gap-1.5" aria-label="Source separation">
            {t.separation.vocals ? (
              <Badge tone="accent" title="The sung melody was transcribed from the separated vocals and put on the right hand">
                Vocals separated
              </Badge>
            ) : (
              <Badge title="No sung melody was found in the separated vocals">No singing found</Badge>
            )}
            <Badge tone="accent" title="Drums and vocals were removed before the accompaniment was transcribed">
              Drums removed
            </Badge>
          </div>
        )}
        {t.warnings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {t.warnings.map((w) => (
              <li key={w} className="text-[12px] text-warn">
                • {w}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Difficulty levels">
        <LevelStats />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="subtle" icon={<RefreshCw size={14} />} onClick={() => {
            if (song.arrangements[difficulty].edited && !confirm(`Discard your edits to ${difficulty}?`)) return;
            regenerateLevels([difficulty]);
          }}>
            Regenerate {difficulty}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => {
            if (!confirm('Rebuild Easy and Medium from the current Hard arrangement (including your Hard edits)?')) return;
            const hard = song.arrangements.hard.notes;
            const all = generateAllArrangements(hard, song.basePedal, song.tempo, song.duration, arrangementOptions(song));
            replaceSong({ ...song, arrangements: { ...song.arrangements, easy: all.easy, medium: all.medium } });
          }}>
            Easy & Medium from Hard
          </Button>
        </div>
      </Section>

      <Section title="Tempo">
        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[12.5px] text-ink-200">
            BPM
            <input
              value={bpm}
              onChange={(e) => setBpm(e.target.value)}
              inputMode="decimal"
              className="focus-ring h-9 rounded-[10px] border border-ink-600 bg-ink-800 px-2.5 font-mono text-[13px] text-ink-50"
            />
          </label>
          <Button size="sm" onClick={applyBpm}>
            Set tempo
          </Button>
        </div>
        <p className="text-[11.5px] text-ink-400">Sets a steady grid for the metronome, quantising and the simplified levels.</p>
      </Section>

      {song.hasPosteriors && (
        <Section title="Re-detect notes">
          <p className="text-[12px] leading-relaxed text-ink-300">Tune detection and re-run it instantly — the neural network output is cached, so this takes seconds.</p>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(EXTRACTION_PRESETS) as (keyof typeof EXTRACTION_PRESETS)[]).map((k) => (
              <Button key={k} size="sm" variant="ghost" onClick={() => setParams(EXTRACTION_PRESETS[k])}>
                {k === 'piano' ? 'Piano solo' : k === 'mix' ? 'Full song' : 'Sensitive'}
              </Button>
            ))}
          </div>
          <Slider label="Note onset sensitivity" min={0.2} max={0.8} value={1 - params.onsetThreshold} onChange={(v) => setParams({ ...params, onsetThreshold: Math.round((1 - v) * 100) / 100 })} format={(v) => `${Math.round(v * 100)}`} />
          <Slider label="Sustain sensitivity" min={0.4} max={0.85} value={1 - params.frameThreshold} onChange={(v) => setParams({ ...params, frameThreshold: Math.round((1 - v) * 100) / 100 })} format={(v) => `${Math.round(v * 100)}`} />
          <Slider label="Shortest note" min={30} max={200} step={5} value={params.minNoteMs} onChange={(minNoteMs) => setParams({ ...params, minNoteMs })} format={(v) => `${v} ms`} />
          <Slider
            label="Merge ringing re-detections"
            min={0}
            max={0.9}
            value={params.continuationOnset ?? 0}
            onChange={(v) => setParams({ ...params, continuationOnset: Math.round(v * 100) / 100 })}
            format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}`)}
          />
          <Toggle label="Remove overtone ghost notes" checked={params.suppressHarmonics} onChange={(suppressHarmonics) => setParams({ ...params, suppressHarmonics })} />
          <Toggle label="Follow sustained melodies (vocals)" checked={params.melodiaTrick} onChange={(melodiaTrick) => setParams({ ...params, melodiaTrick })} />
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void redetect()} icon={busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}>
            Re-detect notes
          </Button>
        </Section>
      )}
    </div>
  );
}
