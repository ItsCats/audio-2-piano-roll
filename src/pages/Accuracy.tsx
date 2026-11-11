import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Gauge, Info, Wand2, Timer, KeyRound, Music2 } from 'lucide-react';
import { ACCURACY_UPDATED, EXPECTATIONS, LIMITATIONS, PIANO_BENCHMARK, type Rating } from '../lib/accuracyStats';
import { Badge, cn } from '../components/ui';

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Stars({ rating }: { rating: Rating }) {
  return (
    <span className="flex gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={cn('h-2 w-5 rounded-full', i <= rating ? (rating >= 4 ? 'bg-ok' : rating === 3 ? 'bg-warn' : 'bg-bad/80') : 'bg-ink-700')} />
      ))}
    </span>
  );
}

function StatCard({ icon: Icon, value, label, sub }: { icon: typeof Gauge; value: string; label: string; sub: string }) {
  return (
    <div className="panel flex flex-col gap-1 p-3.5 sm:p-4">
      <Icon size={18} className="text-accent-400" />
      <span className="mt-1 text-[24px] leading-none font-semibold text-ink-50 tabular-nums sm:text-[28px]">{value}</span>
      <span className="text-[13px] font-medium text-ink-100">{label}</span>
      <span className="text-[12px] leading-snug text-ink-300">{sub}</span>
    </div>
  );
}

export default function AccuracyPage() {
  const best = PIANO_BENCHMARK[0];
  const avgF1 = PIANO_BENCHMARK.reduce((s, r) => s + r.f1, 0) / PIANO_BENCHMARK.length;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-5 py-8 md:px-10">
        <header>
          <p className="text-[12px] font-semibold tracking-[0.14em] text-accent-400 uppercase">Transparency</p>
          <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-ink-50 md:text-[32px]">How accurate is Piano2Vision?</h1>
          <p className="mt-3 max-w-3xl text-[14.5px] leading-relaxed text-ink-300">
            When you import audio, an AI model listens to the recording and estimates which notes were played. It’s good — but it is an
            estimate, not a perfect score. Here is what we’ve measured, what to expect for different kinds of music, and how to get the best
            result.
          </p>
          <div className="mt-4 flex gap-2.5 rounded-xl border border-warn/25 bg-warn/10 p-3.5 text-[13px] leading-relaxed text-ink-100">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-warn" />
            <p>
              Every song made from audio is labelled <b className="text-warn">AI transcription</b> in the Studio. Always compare it with the
              original before learning a piece note-for-note — and fix anything that sounds off in Edit mode.
            </p>
          </div>
        </header>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-200">At a glance — piano benchmark</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={Gauge} value={pct(avgF1)} label="Notes correct (F1)" sub={`Best case: clean piano, ${PIANO_BENCHMARK.length} test pieces with known notes (best ${pct(best.f1)}). Real recordings score lower.`} />
            <StatCard icon={Timer} value="< 5 ms" label="Timing error" sub="Average onset error of correctly found notes, with no drift over the song." />
            <StatCard icon={Music2} value="2 / 2" label="Tempo detected" sub="Within 0.2 BPM on both test pieces (66 and 120 BPM)." />
            <StatCard icon={KeyRound} value="3 / 3" label="Key detected" sub="Both test pieces plus a real recording of Chopin’s Nocturne Op. 55 No. 1 (F minor)." />
          </div>
        </section>

        <section>
          <h2 className="mb-1 text-[13px] font-semibold tracking-wide text-ink-200">Benchmark results</h2>
          <p className="mb-3 text-[12.5px] text-ink-300">
            Pieces with known notes, played through a sampled grand piano with reverb and transcribed by the app. “Stock settings” is the same
            AI model with its default settings, before Piano2Vision’s piano-specific tuning.
          </p>
          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-ink-700 text-[11.5px] text-ink-400">
                  <th className="px-4 py-2.5 font-medium">Piece</th>
                  <th className="px-3 py-2.5 text-right font-medium">Notes</th>
                  <th className="px-3 py-2.5 text-right font-medium">Correct (F1)</th>
                  <th className="px-3 py-2.5 text-right font-medium">Found (recall)</th>
                  <th className="px-3 py-2.5 text-right font-medium">Right when found (precision)</th>
                  <th className="px-3 py-2.5 text-right font-medium">Stock settings</th>
                  <th className="px-4 py-2.5 text-right font-medium">Timing</th>
                </tr>
              </thead>
              <tbody>
                {PIANO_BENCHMARK.map((r) => (
                  <tr key={r.piece} className="border-b border-ink-800 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-50">{r.piece}</p>
                      <p className="text-[12px] text-ink-300">{r.description}</p>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-ink-200">{r.notes}</td>
                    <td className="px-3 py-3 text-right font-mono font-semibold text-ok">{pct(r.f1)}</td>
                    <td className="px-3 py-3 text-right font-mono text-ink-100">{pct(r.recall)}</td>
                    <td className="px-3 py-3 text-right font-mono text-ink-100">{pct(r.precision)}</td>
                    <td className="px-3 py-3 text-right font-mono text-ink-400">{pct(r.baselineF1)}</td>
                    <td className="px-4 py-3 text-right font-mono whitespace-nowrap text-ink-100">{r.meanTimingErrorMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 flex gap-1.5 text-[12px] text-ink-400">
            <Info size={13} className="mt-0.5 shrink-0" />
            These are best-case conditions: one clean piano, no background noise. Real recordings — and especially full songs — score lower.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-200">What to expect by type of music</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {EXPECTATIONS.map((e) => (
              <div key={e.kind} className="panel flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[14px] font-medium text-ink-50">{e.kind}</p>
                  <Stars rating={e.rating} />
                </div>
                <p className="text-[12px] text-ink-400">{e.examples}</p>
                <p className="text-[13px] leading-relaxed text-ink-200">{e.summary}</p>
                <p className="flex gap-1.5 text-[12.5px] leading-relaxed text-ink-300">
                  <Wand2 size={13} className="mt-0.5 shrink-0 text-accent-400" /> {e.tips}
                </p>
                <div>
                  {e.measured ? <Badge tone="ok">Measured</Badge> : <Badge title="Based on testing; precise measurements on real recordings are in progress">Estimate</Badge>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-200">What the AI can’t (fully) do</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LIMITATIONS.map((l) => (
              <div key={l.title} className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
                <p className="text-[13.5px] font-medium text-ink-50">{l.title}</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-300">{l.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="text-[15px] font-semibold text-ink-50">Getting the best result</h2>
          <ol className="mt-3 flex flex-col gap-2 text-[13px] leading-relaxed text-ink-200">
            {[
              'Choose the right detection preset when importing: Piano solo, Full song or Sensitive.',
              'Use the cleanest recording you can — less reverb, crowd noise and background music means better notes.',
              'In the Studio, blend in the original recording (Sound tab → Original recording) to hear differences.',
              'Re-tune detection in the Notes tab — it re-runs in seconds without re-analysing the audio.',
              'Fix remaining mistakes in Edit mode; your edits are saved per difficulty level.',
              'Have a MIDI file? Import that instead — it’s exact.',
            ].map((t, i) => (
              <li key={t} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-500/20 text-[11px] font-semibold text-accent-300">{i + 1}</span>
                {t}
              </li>
            ))}
          </ol>
          <Link to="/import" className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent-400 hover:text-accent-300">
            <CheckCircle2 size={14} /> Import a song
          </Link>
        </section>

        <section className="text-[12px] leading-relaxed text-ink-400">
          <h2 className="mb-1 text-[12px] font-semibold tracking-wide text-ink-300 uppercase">How we measure</h2>
          <p>
            A note counts as correct when its pitch is exact and it starts within 50 milliseconds of the real note (the standard “note onset”
            measure used in music-transcription research). F1 combines how many real notes were found (recall) with how many detected notes
            were real (precision). The benchmark runs the full app pipeline in a browser and is part of the project’s automated tests. Transcription
            uses Spotify’s open-source Basic Pitch model with Piano2Vision’s own note detection tuned for piano. Last updated {ACCURACY_UPDATED}.
          </p>
        </section>
      </div>
    </div>
  );
}
