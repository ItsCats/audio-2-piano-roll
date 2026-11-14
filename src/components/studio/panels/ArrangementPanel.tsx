import { resolveMeter } from '../../../lib/sheet/grid';
import { readByBeta, readFromSheet, readerWhat } from '../SheetReaderNotice';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, History, Loader2, RotateCcw, Wand2 } from 'lucide-react';
import { useStudio } from '../../../state/studioStore';
import { detectionParams, useSettings } from '../../../state/settingsStore';
import { getOtherVersion, getPosteriors, type StoredOther } from '../../../lib/storage/db';
import { importBusy, useImport } from '../../../state/importStore';
import { analysisLabel } from '../../../lib/transcription/analysisSummary';
import { reanalyzeSupport } from '../../../lib/reanalyze';
import { useStoredOriginal } from '../../../hooks/useStoredOriginal';
import { deleteOtherSongVersion, swapSongVersions } from '../../../state/songVersions';
import { isAudioSong } from '../../../lib/music/autoPedal';
import { blendAddedNotes, redetectNotes, redetectedBlendInfo, withLeadPass, EXTRACTION_PRESETS } from '../../../lib/transcription/pipeline';
import { regularBeats } from '../../../lib/music/beats';
import { detectKey } from '../../../lib/music/theory';
import { generateAllArrangements } from '../../../lib/music/difficulty';
import type { Difficulty, ExtractionParams, NoteLength } from '../../../lib/music/types';
import { Badge, Button, Section, Segmented, Slider, Toggle } from '../../ui';
import { toast } from '../../../state/toastStore';
import { arrangementOptions, easyMediumFromHard, hasNoteLength, levelName, makeThumbnail, noteLengthOf, resetConfirmText, resetLevel as resetLevelOf, resetToastBody, withNoteLength } from '../../../lib/songs';
import { followsWrittenTempo } from '../../../lib/sheet/retime';
import { NO_TEMPO_READ_WARNING } from '../../../lib/omr/readers';
import { SongTempoSection, TempoText, focusTempoInput, tempoFrom, tempoGuessed } from './TempoControl';

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

/**
 * Note length of a high-accuracy piano model song (Song.noteLength): as played (a note ends when its
 * key is let go, the pedal carries the sound) or as heard (a note lasts as long as it rings).
 */
function NoteLengthControl() {
  const song = useStudio((s) => s.song)!;
  const value = noteLengthOf(song);
  const change = (to: NoteLength) => {
    const s = useStudio.getState().song;
    if (!s || to === noteLengthOf(s)) return;
    const edited = (['easy', 'medium', 'hard'] as Difficulty[]).filter((d) => s.arrangements[d].edited);
    if (edited.length && !confirm(`Changing the note length rebuilds every level from the detected notes: your note fixes to ${edited.join(', ')} will be replaced (fingering and markings are kept). Continue?`)) return;
    const next = withNoteLength(s, to);
    // one undo step: the notes, the pedal, every level, the setting and the library picture together
    useStudio.getState().editSong(() => ({
      base: next.base,
      basePedal: next.basePedal,
      autoPedal: next.autoPedal,
      noteLength: next.noteLength,
      notesAsPlayed: next.notesAsPlayed,
      thumbnail: next.thumbnail,
      arrangements: next.arrangements,
    }));
    const autoOff = s.autoPedal === true && next.autoPedal !== true;
    if (to === 'played')
      toast.success(
        'Notes now end when the key is let go',
        autoOff
          ? 'The automatic pedal is now off: Medium and Hard use the sustain pedal heard in the recording, which keeps the notes ringing.'
          : 'The sustain pedal heard in the recording keeps them ringing.',
      );
    else toast.success('Notes now last as long as they ring');
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="note-length">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] text-ink-200">Note length</span>
        <Segmented<NoteLength>
          size="sm"
          ariaLabel="Note length"
          value={value}
          onChange={change}
          options={[
            { value: 'played', label: 'As played' },
            { value: 'heard', label: 'As heard' },
          ]}
        />
      </div>
      <p className="text-[11.5px] leading-snug text-ink-400">
        As played: a note ends when its key is let go, and the sustain pedal keeps it ringing. As heard: a note lasts as long as it rings.
      </p>
      {!song.noteLength && (
        <p className="text-[11.5px] leading-snug text-ink-300">
          Made before notes were shortened. Choose As played to see how long each key is held.
          {song.autoPedal ? ' Medium and Hard then use the sustain pedal heard in the recording instead of the automatic pedal.' : ''}
        </p>
      )}
    </div>
  );
}

/**
 * "Analyze again" (AnalyzeAgainDialog): what the song was analyzed with, the button, and, after a
 * re-analysis, the version card (the other version is kept in storage: switch to it or delete it).
 */
function AnalyzeAgainSection({ redetecting }: { redetecting: boolean }) {
  const song = useStudio((s) => s.song)!;
  const setAnalyzeOpen = useStudio((s) => s.setAnalyzeOpen);
  const custom = useSettings((s) => s.customDetection);
  const job = useImport((s) => s.job);
  // this song is being analyzed again right now (a finished or failed run blocks nothing)
  const mine = importBusy(job) && job?.reanalyze?.songId === song.id;
  const busyOther = importBusy(job) && !mine;
  const [other, setOther] = useState<StoredOther | null>(null);
  const [working, setWorking] = useState(false);
  // while Re-detect runs, the notes it will replace must stay the ones on screen
  const locked = working || mine || redetecting;
  useEffect(() => {
    let alive = true;
    void getOtherVersion(song.id)
      .catch(() => undefined)
      .then((o) => alive && setOther(o ?? null));
    return () => {
      alive = false;
    };
  }, [song.id, song.updatedAt, job?.stage]);
  const t = song.transcription;
  const what =
    song.source.kind === 'midi' || t.method === 'midi-file'
      ? 'Notes from the MIDI file'
      : song.source.kind === 'score' || t.method === 'score-file'
        ? 'Notes from the sheet music'
        : `Analyzed as: ${analysisLabel(t, custom) || 'Earlier settings'}`;
  const swap = async () => {
    if (!other) return;
    setWorking(true);
    try {
      const role = other.otherVersion.role;
      const s = await swapSongVersions(song.id);
      if (!s) return;
      if (role === 'older') toast.success('Back to the old notes', 'The new analysis is kept, so you can switch again under Analyze again.');
      else toast.success('Using the new analysis', 'The old notes are kept, so you can switch again under Analyze again.');
    } catch (e) {
      toast.error('Couldn’t switch versions', (e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const remove = async () => {
    if (!other) return;
    const older = other.otherVersion.role === 'older';
    if (!confirm(older ? 'Delete the old notes for good? You won’t be able to go back to them.' : 'Delete the new analysis for good? You won’t be able to go back to it.')) return;
    await deleteOtherSongVersion(song.id);
    setOther(null);
    toast.info('Deleted', 'Only the version you’re using is kept.');
  };
  const n = other?.arrangements.hard.notes.length ?? 0;
  const otherLabel = other ? analysisLabel(other.transcription, custom) : '';
  return (
    <Section title="Analyze again">
      <p className="text-[12.5px] text-ink-200" data-testid="analyzed-as">
        {what}
      </p>
      <div>
        <Button variant="primary" size="sm" icon={<Wand2 size={14} />} disabled={busyOther || redetecting} onClick={() => setAnalyzeOpen(true)}>
          Analyze again…
        </Button>
        {busyOther && (
          <p className="mt-1.5 text-[11.5px] text-ink-400">
            Another import is running. Wait for it to finish.{' '}
            <Link to="/import" className="text-accent-400 hover:text-accent-300">
              See progress
            </Link>
          </p>
        )}
      </div>
      {other && (
        <div className="flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-900/60 p-3 text-[12.5px] text-ink-100" data-testid="version-card">
          <p className="flex gap-2">
            <History size={15} className="mt-0.5 shrink-0 text-accent-400" />
            <span>
              {other.otherVersion.role === 'older'
                ? `Your old notes are kept (${otherLabel ? `${otherLabel}, ` : ''}Hard: ${n} notes).`
                : `You’re using the old notes. The new analysis is kept (${otherLabel ? `${otherLabel}, ` : ''}Hard: ${n} notes).`}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button size="sm" disabled={locked} onClick={() => void swap()}>
              {other.otherVersion.role === 'older' ? 'Go back to the old notes' : 'Use the new analysis'}
            </Button>
            <button type="button" className="focus-ring rounded text-[12px] text-ink-300 underline-offset-2 hover:text-ink-50 hover:underline" disabled={locked} onClick={() => void remove()}>
              {other.otherVersion.role === 'older' ? 'Delete the old notes' : 'Delete the new analysis'}
            </button>
          </div>
          <p className="text-[11.5px] text-ink-400">Switching clears undo history.</p>
        </div>
      )}
    </Section>
  );
}

export function ArrangementPanel() {
  const song = useStudio((s) => s.song)!;
  const replaceSong = useStudio((s) => s.replaceSong);
  const difficulty = useStudio((s) => s.difficulty);
  const audioSong = isAudioSong(song) && song.transcription.estimated;
  const stored = useStoredOriginal(song.id, song.hasAudio, audioSong);
  const [params, setParams] = useState<ExtractionParams>(() => withLeadPass(song.transcription.params ?? detectionParams()));
  const [busy, setBusy] = useState(false);
  const [bpm, setBpm] = useState(String(song.tempo.bpm));
  // the song's notes were analyzed again or switched to the other version: start from its own values
  const analysis = song.transcription;
  useEffect(() => setParams(withLeadPass(analysis.params ?? detectionParams())), [analysis]);
  const tempoBpm = song.tempo.bpm;
  useEffect(() => setBpm(String(tempoBpm)), [tempoBpm]);
  const t = song.transcription;
  const estimated = t.estimated;
  // sheet music, MIDI files, the demo: setting the tempo re-times the whole song (TempoControl)
  const written = followsWrittenTempo(song);
  const warnings = t.warnings.filter((w) => w !== NO_TEMPO_READ_WARNING);

  const redetect = async () => {
    const edited = (['easy', 'medium', 'hard'] as Difficulty[]).filter((d) => song.arrangements[d].edited);
    if ((edited.length || song.sheet) && !confirm(`Re-detecting replaces your edits${edited.length ? ` to ${edited.join(', ')}` : ''}.${song.sheet ? ' Sheet edits on every level and key/time/tempo marks will be removed.' : ''} Continue?`)) return;
    setBusy(true);
    try {
      const post = await getPosteriors(song.id);
      if (!post) throw new Error('The analysis data for this song is no longer stored. Re-import the audio to re-detect.');
      // keep the sung melody line (role 'melody') of separated songs: only the accompaniment is
      // re-detected, and the beats come from it alone, as on import
      const det = await redetectNotes(post, params, song.duration, { melody: song.base.filter((n) => n.role === 'melody') });
      const notes = det.notes;
      const tempo = song.tempo.source === 'manual' ? song.tempo : det.tempo;
      const { sheet: _sheet, ...rest } = song;
      void _sheet;
      // the piano-model blend runs again only where it can (Full song preset, no sung line)
      const info = { ...t };
      delete info.pianoBlend;
      const pianoBlend = redetectedBlendInfo(t.pianoBlend, det.blend);
      // (only if the song still has the analysis this started from: switched to its other version,
      // analyzed again or another song opened meanwhile, the result belongs to notes no longer on screen)
      const replaced = replaceSong(
        {
          ...rest,
          base: notes,
          tempo,
          key: detectKey(notes),
          arrangements: generateAllArrangements(notes, song.basePedal, tempo, song.duration, arrangementOptions(song)),
          transcription: { ...info, params, ...(pianoBlend ? { pianoBlend } : {}) },
          thumbnail: makeThumbnail(notes, song.duration),
          updatedAt: Date.now(),
        },
        { ifTranscription: t },
      );
      if (!replaced) {
        toast.info('Re-detect stopped', 'The song’s notes changed while re-detecting, so the result wasn’t used.');
        return;
      }
      toast.success('Notes re-detected', `${notes.length} notes with the new settings.`);
    } catch (e) {
      toast.error('Re-detection failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** "Reset {Level} to detected notes": one undo step, and a toast that says what changed (with Undo). */
  const resetCurrent = () => {
    const st = useStudio.getState();
    const cur = st.song;
    if (!cur) return;
    const d = st.difficulty;
    const L = levelName(d);
    const a = cur.arrangements[d];
    if (a.edited || a.pedalEdited) {
      // (the question says what exactly goes back)
      const preview = resetLevelOf(cur, d);
      if (preview.changed && !confirm(resetConfirmText(preview, d))) return;
    }
    const r = st.resetLevel(d);
    if (!r) return;
    if (!r.changed) {
      const offer = audioSong && reanalyzeSupport(cur, stored === 'yes').ok;
      if (offer)
        toast.info(`${L} is already as detected`, 'Nothing to reset. To detect the notes again, for example with the high-accuracy piano model, use Analyze again.', {
          actions: [{ label: 'Analyze again', variant: 'primary', onClick: () => useStudio.getState().setAnalyzeOpen(true) }],
          ttl: 12000,
        });
      else toast.info(`${L} is already as detected`, 'Nothing to reset.');
      return;
    }
    const token = r.token;
    toast.success(`${L} reset to the detected notes`, resetToastBody(r, d), {
      actions: [
        {
          label: 'Undo',
          onClick: () => {
            const s = useStudio.getState();
            if (token && s.past[s.past.length - 1] === token) {
              s.undo();
              toast.info('Reset undone');
            } else if (token && s.past.includes(token)) {
              toast.info('Can’t undo the reset from here', 'You changed this level since. Use Undo in the editor to step back.');
            } else {
              toast.info('Can’t undo the reset anymore', 'Undo history was cleared when you switched levels.');
            }
          },
        },
      ],
      // (time to read it and reach Undo on a phone)
      ttl: 15000,
    });
  };

  const applyBpm = () => {
    const v = parseFloat(bpm);
    if (!Number.isFinite(v) || v < 20 || v > 300) {
      toast.error('Invalid tempo', 'Enter a BPM between 20 and 300.');
      return;
    }
    const edited = (['easy', 'medium', 'hard'] as Difficulty[]).filter((d) => song.arrangements[d].edited);
    if ((edited.length || song.sheet) && !confirm(`Setting the tempo rebuilds every level from the detected notes: your edits${edited.length ? ` to ${edited.join(', ')}` : ''}${song.sheet ? ', the sheet’s bar lines and its key/time/tempo marks' : ''} will be replaced. Continue?`)) return;
    const first = song.tempo.beats[song.tempo.downbeatIndex] ?? song.base[0]?.start ?? 0;
    const tempo = { ...song.tempo, bpm: v, beats: regularBeats(v, first, song.duration), downbeatIndex: 0, source: 'manual' as const, confidence: 1 };
    const { sheet: _sheet, ...rest } = song;
    void _sheet;
    replaceSong({ ...rest, tempo, arrangements: generateAllArrangements(song.base, song.basePedal, tempo, song.duration, arrangementOptions(song)) });
    toast.success('Tempo updated', 'The beat grid and the Easy/Medium arrangements were regenerated.');
  };

  return (
    <div>
      <Section title="Transcription">
        {readFromSheet(song) ? (
          <div className="flex gap-2 rounded-lg border border-warn/25 bg-warn/10 p-3 text-[12.5px] leading-relaxed text-ink-100">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
            <div>
              <p className="font-medium text-warn">Read from {readerWhat(song)}{readByBeta(song) ? ' (Beta)' : ''}</p>
              <p className="mt-0.5 text-ink-200">
                The sheet-music reader estimated these notes from the page. Wrong rhythms and missing sharps or flats are the most common
                mistakes: compare with your page, then fix notes in Edit mode.{' '}
                <Link to="/accuracy#sheet-reader" className="text-accent-400 hover:text-accent-300">
                  How accurate is it?
                </Link>
              </p>
              {written && tempoFrom(song) === 'default' && (
                <p className="mt-1.5 text-ink-200" data-testid="reader-tempo-note">
                  The reader doesn’t read tempo marks, so this plays at <TempoText song={song} />, a guess.{' '}
                  <button type="button" onClick={focusTempoInput} className="focus-ring rounded text-accent-400 underline-offset-2 hover:text-accent-300 hover:underline">
                    Set the tempo printed on your page
                  </button>
                </p>
              )}
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
        {hasNoteLength(song) && <NoteLengthControl />}
        <dl className="grid grid-cols-2 gap-y-1 text-[12.5px]">
          <dt className="text-ink-300">Tempo</dt>
          <dd className="text-right text-ink-100" data-testid="tempo-value">
            {written ? (
              <>
                <TempoText song={song} /> {tempoGuessed(song) && <Badge tone="warn">guess</Badge>}
              </>
            ) : (
              <>
                {song.tempo.bpm} BPM {song.tempo.source === 'estimated' && song.tempo.confidence < 0.2 && <Badge tone="warn">uncertain</Badge>}
              </>
            )}
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
          {blendAddedNotes(t.pianoBlend) && (
            <>
              <dt className="text-ink-300">Detection</dt>
              <dd className="text-right text-ink-100">Full song + piano model</dd>
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
        {t.separation?.pianoPart ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Source separation">
            {t.separation.singing ? (
              <Badge tone="accent" title="The singing was separated out and not turned into notes">
                Singing removed
              </Badge>
            ) : (
              <Badge title="No singing was found in the separated vocals">No singing found</Badge>
            )}
            <Badge
              tone="accent"
              title={t.separation.bassRemoved ? 'Drums and bass were removed before the piano part was transcribed' : 'Drums were removed before the piano part was transcribed'}
            >
              {t.separation.bassRemoved ? 'Drums and bass removed' : 'Drums removed'}
            </Badge>
          </div>
        ) : t.separation && (
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
        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {warnings.map((w) => (
              <li key={w} className="text-[12px] text-warn">
                • {w}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* songs that follow a written tempo: right under what the song is, easy to find on a phone */}
      {written && <SongTempoSection />}

      {song.source.kind !== 'demo' && t.method !== 'demo' && <AnalyzeAgainSection redetecting={busy} />}

      <Section title="Difficulty levels">
        <LevelStats />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="subtle" icon={<RotateCcw size={14} />} onClick={resetCurrent}>
            Reset {levelName(difficulty)} to detected notes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => {
            const fixed = song.arrangements.easy.edited || song.arrangements.medium.edited;
            if (!confirm(`Rebuild Easy and Medium from the current Hard arrangement (including your Hard edits)?${fixed ? ' Fixes and markings made on Easy and Medium will be replaced.' : ''} Hard’s fingering and markings are copied over.`)) return;
            replaceSong(easyMediumFromHard(song));
          }}>
            Easy & Medium from Hard
          </Button>
        </div>
        <p className="text-[11.5px] leading-snug text-ink-400">
          Reset puts one level back to the notes found when the song was analyzed.
          {audioSong ? ' To find the notes again with other settings, like the high-accuracy piano model, use Analyze again above.' : ''}
        </p>
      </Section>

      {!written && (
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
        <p className="text-[11.5px] text-ink-400">Sets a steady grid for the metronome, quantizing and the simplified levels.</p>
      </Section>
      )}

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
