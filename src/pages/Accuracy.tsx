import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Gauge, Info, Wand2, Timer, Mic2, Music2, Heart, ExternalLink, Piano } from 'lucide-react';
import {
  ACCURACY_UPDATED,
  AT_A_GLANCE,
  DATASETS,
  EXPECTATIONS,
  INSTRUMENTAL,
  LIMITATIONS,
  MAESTRO_ROWS,
  MAESTRO_CAVEATS,
  METHOD_NOTES,
  OTHER_PIANO_ROWS,
  PLAYABILITY,
  SEPARATION_EFFECT,
  SONG_ROWS,
  SONG_SUMMARY,
  SPEED_ROWS,
  SYNTHETIC_BENCHMARK,
  type Rating,
} from '../lib/accuracyStats';
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

const ICONS = { piano: Piano, mic: Mic2, bass: Music2, timer: Timer } as const;

function StatCard({ icon, value, label, sub }: { icon: keyof typeof ICONS; value: string; label: string; sub: string }) {
  const Icon = ICONS[icon];
  return (
    <div className="panel flex flex-col gap-1 p-3.5 sm:p-4">
      <Icon size={18} className="text-accent-400" />
      <span className="mt-1 text-[24px] leading-none font-semibold text-ink-50 tabular-nums sm:text-[28px]">{value}</span>
      <span className="text-[13px] font-medium text-ink-100">{label}</span>
      <span className="text-[12px] leading-snug text-ink-300">{sub}</span>
    </div>
  );
}

/** before → after on a 0..1 scale, with an optional "best possible" tick. */
function CompareBar({ before, after, best, label }: { before?: number; after: number; best?: number; label: string }) {
  return (
    <div className="flex min-w-[150px] flex-col gap-1" aria-label={label}>
      <div className="relative h-2 rounded-full bg-ink-800">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent-500/80" style={{ width: pct(after) }} />
        {before !== undefined && <div className="absolute -top-1 -bottom-1 w-[3px] -translate-x-1/2 rounded bg-ink-300" style={{ left: pct(before) }} title={`before ${pct(before)}`} />}
        {best !== undefined && <div className="absolute -top-1 -bottom-1 w-[3px] -translate-x-1/2 rounded bg-ok" style={{ left: pct(best) }} title={`best possible ${pct(best)}`} />}
      </div>
      <span className="font-mono text-[12px] whitespace-nowrap text-ink-200">
        {before !== undefined && <span className="text-ink-400">{pct(before)} → </span>}
        <b className="text-ink-50">{pct(after)}</b>
        {best !== undefined && <span className="text-ok"> · best {pct(best)}</span>}
      </span>
    </div>
  );
}

function MobileStat({ label, value, strong, dim }: { label: string; value: string; strong?: boolean; dim?: boolean }) {
  return (
    <div className="flex flex-col">
      <span>{label}</span>
      <span className={cn('font-mono text-[13px]', strong ? 'font-semibold text-ink-50' : dim ? 'text-ink-400' : 'text-ink-100')}>{value}</span>
    </div>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <>
      <h2 className="mb-1 text-[15px] font-semibold text-ink-50">{title}</h2>
      {sub && <p className="mb-3 max-w-3xl text-[12.5px] leading-relaxed text-ink-300">{sub}</p>}
    </>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 flex gap-1.5 text-[12px] leading-relaxed text-ink-400">
      <Info size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function BeforeAfterTable({ rows, cols = ['What we measured', 'Before', 'Now'] }: { rows: { what: string; before: string; after: string; note?: string }[]; cols?: [string, string, string] | string[] }) {
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-ink-700 text-[11.5px] text-ink-400">
            <th className="px-3 py-2.5 font-medium sm:px-4">{cols[0]}</th>
            <th className="px-3 py-2.5 text-right font-medium">{cols[1]}</th>
            <th className="px-4 py-2.5 text-right font-medium">{cols[2]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.what} className="border-b border-ink-800 last:border-0">
              <td className="px-3 py-2.5 sm:px-4">
                <p className="text-ink-100">{r.what}</p>
                {r.note && <p className="text-[12px] text-ink-400">{r.note}</p>}
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-ink-400 sm:px-3 sm:whitespace-nowrap">{r.before}</td>
              <td className="px-3 py-2.5 text-right font-mono font-semibold text-ink-50 sm:px-4 sm:whitespace-nowrap">{r.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AccuracyPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-9 px-4 py-8 sm:px-5 md:px-10">
        <header>
          <p className="text-[12px] font-semibold tracking-[0.14em] text-accent-400 uppercase">Transparency</p>
          <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-ink-50 md:text-[32px]">How accurate is Piano2Vision?</h1>
          <p className="mt-3 max-w-3xl text-[14.5px] leading-relaxed text-ink-300">
            When you import audio, an AI model listens to the recording and estimates which notes were played. It is an estimate, not a perfect
            score. Below is what we measured on real recordings — concert piano performances with an exact answer key, other piano recordings,
            and full songs with singers, bands and drums — what got better, and where it still goes wrong.
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
          <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-200">At a glance</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {AT_A_GLANCE.map((c) => (
              <StatCard key={c.label} {...c} />
            ))}
          </div>
        </section>

        <section>
          <SectionTitle
            title="Solo piano: real recordings with an exact answer key"
            sub="Six concert performances recorded on a Yamaha Disklavier, a real grand piano that also records exactly which keys were pressed and when (the MAESTRO dataset). That record is the answer key. A note counts as right when the pitch is exact and it starts within 50 ms (1/20 s) of the real one."
          />
          <div className="flex flex-col gap-2 sm:hidden">
            {MAESTRO_ROWS.map((r) => (
              <div key={r.piece} className="panel p-3.5">
                <p className="text-[13.5px] font-medium text-ink-50">{r.piece}</p>
                <p className="text-[12px] text-ink-300">{r.detail}</p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-ink-400">
                  <MobileStat label="“Piano solo”" value={pct(r.f1)} strong />
                  <MobileStat label="“Sensitive”" value={pct(r.f1Sensitive)} />
                  <MobileStat label="Before" value={pct(r.before)} dim />
                  <MobileStat label="Found" value={pct(r.recall)} />
                  <MobileStat label="Right when found" value={pct(r.precision)} />
                  <MobileStat label="Notes" value={r.notes.toLocaleString('en-US')} />
                </div>
              </div>
            ))}
          </div>
          <div className="panel hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-ink-700 text-[11.5px] text-ink-400">
                  <th className="px-4 py-2.5 font-medium">Piece</th>
                  <th className="px-3 py-2.5 text-right font-medium">Notes</th>
                  <th className="px-3 py-2.5 text-right font-medium" title="F1: combines found and right-when-found">Score “Piano solo”</th>
                  <th className="px-3 py-2.5 text-right font-medium">Found</th>
                  <th className="px-3 py-2.5 text-right font-medium">Right when found</th>
                  <th className="px-3 py-2.5 text-right font-medium">Score “Sensitive”</th>
                  <th className="px-4 py-2.5 text-right font-medium">Before</th>
                </tr>
              </thead>
              <tbody>
                {MAESTRO_ROWS.map((r) => (
                  <tr key={r.piece} className="border-b border-ink-800 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-50">{r.piece}</p>
                      <p className="text-[12px] text-ink-300">{r.detail}</p>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-ink-200">{r.notes.toLocaleString('en-US')}</td>
                    <td className={cn('px-3 py-3 text-right font-mono font-semibold', r.f1 >= 0.85 ? 'text-ok' : r.f1 >= 0.7 ? 'text-ink-50' : 'text-warn')}>{pct(r.f1)}</td>
                    <td className="px-3 py-3 text-right font-mono text-ink-100">{pct(r.recall)}</td>
                    <td className="px-3 py-3 text-right font-mono text-ink-100">{pct(r.precision)}</td>
                    <td className={cn('px-3 py-3 text-right font-mono', r.f1Sensitive > r.f1 ? 'font-semibold text-ink-50' : 'text-ink-200')}>{pct(r.f1Sensitive)}</td>
                    <td className="px-4 py-3 text-right font-mono text-ink-400">{pct(r.before)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {MAESTRO_CAVEATS.map((c) => (
              <li key={c.title} className="rounded-xl border border-ink-700 bg-ink-900/60 p-3.5">
                <p className="text-[13px] font-medium text-ink-50">{c.title}</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-300">{c.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <SectionTitle
            title="Other piano recordings (no answer key)"
            sub="For recordings without a key-by-key record we compare with a second, piano-specialist AI model that is too heavy to run in a browser. On the three answer-key pieces above it was checked on (Liszt, Mozart and Chopin’s Nocturne Op. 15) it scores 94–99 %, so high agreement is a good sign — but it is a second opinion, not the truth (it is weaker on pianos, rooms and styles unlike its training data, such as the jazz cover)."
          />
          <div className="flex flex-col gap-2 sm:hidden">
            {OTHER_PIANO_ROWS.map((r) => (
              <div key={r.piece} className="panel p-3.5">
                <p className="text-[13.5px] font-medium text-ink-50">{r.piece}</p>
                <p className="text-[12px] text-ink-300">
                  {r.detail} · {r.length}
                </p>
                <p className="mt-2 mb-1 text-[11px] text-ink-400">Agreement, “Piano solo” (“Sensitive”: {pct(r.agreementSensitive)})</p>
                <CompareBar before={r.before} after={r.agreement} label={`agreement ${pct(r.agreement)}`} />
              </div>
            ))}
          </div>
          <div className="panel hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[620px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-ink-700 text-[11.5px] text-ink-400">
                  <th className="px-4 py-2.5 font-medium">Recording</th>
                  <th className="px-3 py-2.5 text-right font-medium">Length</th>
                  <th className="px-3 py-2.5 font-medium">Agreement, “Piano solo”</th>
                  <th className="px-4 py-2.5 text-right font-medium">“Sensitive”</th>
                </tr>
              </thead>
              <tbody>
                {OTHER_PIANO_ROWS.map((r) => (
                  <tr key={r.piece} className="border-b border-ink-800 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-50">{r.piece}</p>
                      <p className="text-[12px] text-ink-300">{r.detail}</p>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-ink-200">{r.length}</td>
                    <td className="px-3 py-3">
                      <CompareBar before={r.before} after={r.agreement} label={`agreement ${pct(r.agreement)}`} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-ink-100">{pct(r.agreementSensitive)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionTitle title="Full songs with a singer" sub={SONG_SUMMARY.intro} />
          <div className="flex flex-col gap-2 sm:hidden">
            {SONG_ROWS.map((r) => (
              <div key={r.song} className="panel flex flex-col gap-2 p-3.5">
                <div>
                  <p className="text-[13.5px] font-medium text-ink-50">{r.song}</p>
                  <p className="text-[12px] text-ink-300">{r.detail}</p>
                </div>
                <div>
                  <p className="mb-1 text-[11px] text-ink-400">Easy right hand follows the singer</p>
                  <CompareBar before={r.easyBefore} after={r.easy} best={r.best} label="Easy right hand follows the singer" />
                </div>
                <div>
                  <p className="mb-1 text-[11px] text-ink-400">Medium right hand</p>
                  <CompareBar before={r.mediumBefore} after={r.medium} best={r.best} label="Medium right hand follows the singer" />
                </div>
                <div>
                  <p className="mb-1 text-[11px] text-ink-400">Easy left hand on the bass note</p>
                  <CompareBar before={r.bassBefore} after={r.bass} label="Easy left hand on the bass note" />
                </div>
              </div>
            ))}
          </div>
          <div className="panel hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-ink-700 text-[11.5px] text-ink-400">
                  <th className="px-4 py-2.5 font-medium">Song</th>
                  <th className="px-3 py-2.5 font-medium">Easy right hand follows the singer</th>
                  <th className="px-3 py-2.5 font-medium">Medium right hand</th>
                  <th className="px-4 py-2.5 font-medium">Easy left hand on the bass note</th>
                </tr>
              </thead>
              <tbody>
                {SONG_ROWS.map((r) => (
                  <tr key={r.song} className="border-b border-ink-800 align-top last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-50">{r.song}</p>
                      <p className="text-[12px] text-ink-300">{r.detail}</p>
                    </td>
                    <td className="px-3 py-3">
                      <CompareBar before={r.easyBefore} after={r.easy} best={r.best} label="Easy right hand follows the singer" />
                    </td>
                    <td className="px-3 py-3">
                      <CompareBar before={r.mediumBefore} after={r.medium} best={r.best} label="Medium right hand follows the singer" />
                    </td>
                    <td className="px-4 py-3">
                      <CompareBar before={r.bassBefore} after={r.bass} label="Easy left hand on the bass note" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-400">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-[3px] rounded bg-ink-300" /> before (earlier version, no separation)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-5 rounded-full bg-accent-500/80" /> now (“Full song” with “Separate vocals &amp; drums”)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-[3px] rounded bg-ok" /> best possible with written-out notes
            </span>
          </div>
          {SONG_SUMMARY.notes.map((n) => (
            <Note key={n}>{n}</Note>
          ))}
        </section>

        <section>
          <SectionTitle title={INSTRUMENTAL.title} sub={INSTRUMENTAL.intro} />
          <BeforeAfterTable rows={INSTRUMENTAL.rows} />
          {INSTRUMENTAL.notes.map((n) => (
            <Note key={n}>{n}</Note>
          ))}
        </section>

        <section>
          <SectionTitle
            title="What “Separate vocals & drums” changes"
            sub="The same app version and the same five sung songs (plus the instrumental track for drums and bass), transcribed with the “Full song” preset with and without separation. Separation is on by default for “Full song” on computers with enough memory."
          />
          <BeforeAfterTable rows={SEPARATION_EFFECT} cols={['', 'Without separation', 'With separation']} />
        </section>

        <section>
          <SectionTitle
            title="Playable arrangements"
            sub="Two things that made the generated levels hard to play: long notes chopped into quick repeats of the same key, and chords one hand cannot reach. Measured on the same songs and pieces, before → now."
          />
          <BeforeAfterTable rows={PLAYABILITY} />
        </section>

        <section>
          <SectionTitle
            title="Timing and speed"
            sub="Measured in headless Chromium on a shared 4-core virtual machine without a GPU (WebAssembly), so a typical laptop is similar or faster. Everything runs on your device; phones detect notes on the processor (WebAssembly) and leave separation off by default."
          />
          <BeforeAfterTable rows={SPEED_ROWS} cols={['', 'Without separation', 'With separation']} />
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-ink-50">What to expect by type of music</h2>
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
                  {e.measured ? <Badge tone="ok">Measured</Badge> : <Badge title="Based on testing, not on a measurement with an answer key">Estimate</Badge>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-ink-50">What the AI can’t (fully) do yet</h2>
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
              'Choose the right detection preset when importing: Piano solo, Full song or Sensitive (fast or very soft playing).',
              'For songs with a singer, keep “Separate vocals & drums” on: the right hand then follows the singer.',
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

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-ink-50">
            <Gauge size={16} className="text-accent-400" /> How we measured
          </h2>
          <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[12.5px] leading-relaxed text-ink-300">
            {METHOD_NOTES.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <div className="panel mt-3 overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-ink-700 text-[11.5px] text-ink-400">
                  <th className="px-4 py-2.5 font-medium">Data or tool</th>
                  <th className="px-3 py-2.5 font-medium">Used for</th>
                  <th className="px-4 py-2.5 font-medium">Licence</th>
                </tr>
              </thead>
              <tbody>
                {DATASETS.map((d) => (
                  <tr key={d.name} className="border-b border-ink-800 align-top last:border-0">
                    <td className="px-4 py-2.5">
                      {d.url ? (
                        <a href={d.url} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex items-center gap-1 rounded font-medium text-ink-50 hover:text-accent-300">
                          {d.name} <ExternalLink size={12} className="text-ink-400" />
                        </a>
                      ) : (
                        <span className="font-medium text-ink-50">{d.name}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-ink-300">{d.use}</td>
                    <td className="px-4 py-2.5 text-ink-300 sm:whitespace-nowrap">{d.license}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
            <p className="text-[13px] font-medium text-ink-50">Synthetic best case (automated test)</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-300">{SYNTHETIC_BENCHMARK}</p>
          </div>
        </section>

        <footer className="flex flex-col gap-2 border-t border-ink-800 pt-5 text-[12px] leading-relaxed text-ink-400">
          <p>Last updated {ACCURACY_UPDATED}. Numbers are rounded; the full report with every table is produced by the project’s accuracy scripts (tests/accuracy).</p>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link to="/credits" className="inline-flex items-center gap-1.5 text-accent-400 hover:text-accent-300">
              <Heart size={13} /> Credits &amp; licences
            </Link>
            <Link to="/import" className="text-accent-400 hover:text-accent-300">
              Import a song
            </Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
