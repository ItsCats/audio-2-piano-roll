import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Gauge, Info, Wand2, Timer, Mic2, Music2, Heart, ExternalLink, Piano, ScanLine } from 'lucide-react';
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
  SHEET_READER,
  readerScoreText,
  SONG_ROWS,
  SONG_SUMMARY,
  SPECIALIST,
  SPECIALIST_ROWS,
  SPEED_ROWS,
  SYNTHETIC_BENCHMARK,
  type Rating,
} from '../lib/accuracyStats';
import { Badge, cn } from '../components/ui';
import { SOURCE_CODE_LABEL, SOURCE_CODE_URL } from '../lib/credits';

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** like pct, but never rounds a score below 1 up to "100%" */
const pctTop = (x: number) => (x >= 0.995 && x < 1 ? `${(Math.floor(x * 1000) / 10).toFixed(1)}%` : pct(x));

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

function SpecialistStat({ label, fast, accurate, corr }: { label: string; fast: number; accurate: number; corr?: boolean }) {
  const f = (x: number) => (corr ? x.toFixed(2) : pct(x));
  return (
    <div className="panel flex flex-col gap-1 p-3 sm:p-4">
      <span className="text-[22px] leading-none font-semibold text-ok tabular-nums sm:text-[26px]">{f(accurate)}</span>
      <span className="text-[12.5px] font-medium text-ink-100">{label}</span>
      <span className="text-[11.5px] text-ink-400">normal model: {f(fast)}</span>
    </div>
  );
}

function SpecialistSpotlight() {
  const fastRuns = SPECIALIST.found.find((r) => r.what.startsWith('Notes in fast runs'));
  const stats: { value: string; label: string; was: string }[] = [
    { value: pct(SPECIALIST.mean.f1), label: 'Notes right', was: pct(SPECIALIST.mean.f1Fast) },
    { value: pct(SPECIALIST.mean.ends), label: 'Notes that also end right', was: pct(SPECIALIST.mean.endsFast) },
    ...(fastRuns ? [{ value: fastRuns.after, label: 'Notes in fast runs', was: fastRuns.before }] : []),
  ];
  return (
    <section aria-labelledby="spotlight-title" className="relative overflow-hidden rounded-2xl border border-ok/30 bg-gradient-to-br from-ok/[0.12] via-accent-500/[0.06] to-transparent p-5 sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-xl">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.12em] text-ok uppercase">
            <Piano size={15} /> New · High-accuracy piano model
          </p>
          <h2 id="spotlight-title" className="mt-2 text-[22px] leading-tight font-semibold text-ink-50 sm:text-[26px]">
            {pct(SPECIALIST.mean.f1)} of the notes right on solo piano
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-200">
            Measured on 5 concert recordings with an exact answer key, whole pieces, through the app. Note lengths and how hard each key was
            played come out close to the real performance too.
          </p>
          <p className="mt-3 text-[13px] text-ink-300">
            To use it: <b className="text-ink-100">Import</b> → <b className="text-ink-100">Piano solo</b> → tick{' '}
            <b className="text-ink-100">High-accuracy piano model</b>.{' '}
            <a href="#high-accuracy" className="text-accent-300 underline-offset-2 hover:underline">
              Details
            </a>
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:w-[400px] lg:shrink-0">
          {stats.map((x) => (
            <div key={x.label} className="rounded-xl border border-ink-700/70 bg-ink-950/60 p-3">
              <div className="text-[24px] leading-none font-semibold text-ok tabular-nums sm:text-[28px]">{x.value}</div>
              <div className="mt-1.5 text-[12px] leading-snug font-medium text-ink-100">{x.label}</div>
              <div className="mt-1 text-[11px] text-ink-400">normal model: {x.was}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrainingTag() {
  return (
    <span className="mt-1 inline-flex rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-[11px] text-warn" title="MAESTRO train split">
      In the model’s training data — flattering, not in the averages
    </span>
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

/** `even`: two measurements side by side (both columns alike), not before → after. */
function BeforeAfterTable({ rows, cols = ['What we measured', 'Before', 'Now'], even }: { rows: { what: string; before: string; after: string; note?: string }[]; cols?: [string, string, string] | string[]; even?: boolean }) {
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
              <td className={cn('px-2 py-2.5 text-right font-mono sm:px-3 sm:whitespace-nowrap', even ? 'font-semibold text-ink-50' : 'text-ink-400')}>{r.before}</td>
              <td className="px-3 py-2.5 text-right font-mono font-semibold text-ink-50 sm:px-4 sm:whitespace-nowrap">{r.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Sheet music from PDFs and photos: both readers' measured numbers and limits. */
function SheetReaderSection() {
  const rows = SHEET_READER.rows.map((r) => ({ what: r.what, note: r.note, before: readerScoreText(r.accurate), after: readerScoreText(r.quick) }));
  return (
    <section id="sheet-reader" className="scroll-mt-6">
      <h2 className="mb-1 flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink-50">
        <ScanLine size={16} className="text-accent-400" /> Sheet music from PDFs and photos
      </h2>
      <p className="mb-3 max-w-3xl text-[12.5px] leading-relaxed text-ink-300">{SHEET_READER.intro}</p>
      <p className="mb-1.5 text-[11.5px] text-ink-400">Notes right / rhythm right</p>
      <BeforeAfterTable rows={rows} cols={['What was read', 'Accurate reader', 'Quick reader (Beta)']} even />
      <Note>{SHEET_READER.metric}</Note>
      <Note>{SHEET_READER.speed}</Note>
      <Note>
        Songs read by the Quick reader are labeled <b className="text-warn">Sheet music · Beta</b> in the Studio, those read by the Accurate reader{' '}
        <b className="text-warn">Read from PDF</b> or <b className="text-warn">Read from photo</b>. Compare them with your page and fix mistakes in Edit mode. Have the music as a MusicXML or
        MuseScore file? Import that instead — it is exact.
      </Note>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SHEET_READER.limits.map((l) => (
          <div key={l.title} className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
            <p className="text-[13.5px] font-medium text-ink-50">{l.title}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-300">{l.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function AccuracyPage() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#sheet-reader' || hash === '#high-accuracy') document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);
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
          <div className="mt-5">
            <SpecialistSpotlight />
          </div>
          <div className="mt-4 flex gap-2.5 rounded-xl border border-warn/25 bg-warn/10 p-3.5 text-[13px] leading-relaxed text-ink-100">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-warn" />
            <p>
              Every song made from audio is labeled <b className="text-warn">AI transcription</b> in the Studio. Always compare it with the
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

        <section id="high-accuracy" className="scroll-mt-6">
          <SectionTitle title={SPECIALIST.title} sub={SPECIALIST.intro} />
          <div className="mb-3 grid grid-cols-3 gap-2 sm:gap-3">
            <SpecialistStat label="Notes right" fast={SPECIALIST.mean.f1Fast} accurate={SPECIALIST.mean.f1} />
            <SpecialistStat label="Notes that also end right" fast={SPECIALIST.mean.endsFast} accurate={SPECIALIST.mean.ends} />
            <SpecialistStat label="Loudness follows the playing" fast={SPECIALIST.mean.velRFast} accurate={SPECIALIST.mean.velR} corr />
          </div>
          <div className="flex flex-col gap-2 sm:hidden">
            {SPECIALIST_ROWS.map((r) => (
              <div key={r.piece} className={cn('panel p-3.5', r.inTraining && 'opacity-80')}>
                <p className="text-[13.5px] font-medium text-ink-50">{r.piece}</p>
                {r.inTraining && <TrainingTag />}
                <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-ink-400">
                  <MobileStat label="Notes right" value={`${pct(r.f1Fast)} → ${pctTop(r.f1)}`} strong />
                  <MobileStat label="Ends right" value={`${pct(r.endsFast)} → ${pct(r.ends)}`} />
                  <MobileStat label="Loudness r" value={`${r.velRFast.toFixed(2)} → ${r.velR.toFixed(2)}`} />
                </div>
              </div>
            ))}
          </div>
          <div className="panel hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-ink-700 text-[11.5px] text-ink-400">
                  <th className="px-4 py-2.5 font-medium">Piece</th>
                  <th className="px-3 py-2.5 text-right font-medium">Notes right: normal → high-accuracy model</th>
                  <th className="px-3 py-2.5 text-right font-medium">Also end right</th>
                  <th className="px-4 py-2.5 text-right font-medium" title="Correlation of the played and the transcribed loudness of each note (1 = perfect)">Loudness (r)</th>
                </tr>
              </thead>
              <tbody>
                {SPECIALIST_ROWS.map((r) => (
                  <tr key={r.piece} className={cn('border-b border-ink-800 last:border-0', r.inTraining && 'opacity-80')}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-50">{r.piece}</p>
                      {r.inTraining && <TrainingTag />}
                    </td>
                    <td className="px-3 py-3 text-right font-mono">
                      <span className="text-ink-400">{pct(r.f1Fast)} → </span>
                      <b className="text-ok">{pctTop(r.f1)}</b>
                    </td>
                    <td className="px-3 py-3 text-right font-mono">
                      <span className="text-ink-400">{pct(r.endsFast)} → </span>
                      <b className="text-ink-50">{pct(r.ends)}</b>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      <span className="text-ink-400">{r.velRFast.toFixed(2)} → </span>
                      <b className="text-ink-50">{r.velR.toFixed(2)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-col gap-4">
            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-ink-100">Where the difference is</h3>
              <BeforeAfterTable rows={SPECIALIST.found} cols={['Notes found, 5 pieces', 'Normal', 'High-accuracy']} />
            </div>
            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-ink-100">What it costs</h3>
              <BeforeAfterTable rows={SPECIALIST.cost} cols={['Measured on a 4-core computer', 'Normal', 'High-accuracy']} />
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-ok/25 bg-ok/5 p-3.5">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink-50">
                <CheckCircle2 size={14} className="text-ok" /> Use it for
              </p>
              <ul className="mt-1.5 flex list-disc flex-col gap-1.5 pl-5 text-[12.5px] leading-relaxed text-ink-300">
                {SPECIALIST.useWhen.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-3.5">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink-50">
                <AlertTriangle size={14} className="text-warn" /> Stay with the normal model for
              </p>
              <ul className="mt-1.5 flex list-disc flex-col gap-1.5 pl-5 text-[12.5px] leading-relaxed text-ink-300">
                {SPECIALIST.skipWhen.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
          {SPECIALIST.notes.map((n) => (
            <Note key={n}>{n}</Note>
          ))}
        </section>

        <section>
          <SectionTitle
            title="Other piano recordings (no answer key)"
            sub="For recordings without a key-by-key record we compare the normal model with the piano-specialist model (the original Python version of the high-accuracy piano model). On the answer-key pieces above it scores 94–99 %, so high agreement is a good sign — but it is a second opinion, not the truth (it is weaker on pianos, rooms and styles unlike its training data, such as the jazz cover). For the same reason these rows say nothing about the high-accuracy option itself: compared with its own model it would always agree."
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

        <SheetReaderSection />

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
              'Choose the right detection preset when importing: Piano solo, Full song or Sensitive (fast or very soft playing). For solo piano on a computer, pick “High-accuracy piano model” when you can wait a few minutes.',
              'For songs with a singer, keep “Separate vocals & drums” on: the right hand then follows the singer.',
              'Use the cleanest recording you can — less reverb, crowd noise and background music means better notes.',
              'In the Studio, blend in the original recording (Sound tab → Original recording) to hear differences.',
              'Re-tune detection in the Notes tab — it re-runs in seconds without re-analyzing the audio.',
              'Fix remaining mistakes in Edit mode; your edits are saved per difficulty level.',
              'Have a MIDI file? Import that instead — it’s exact.',
              'Printed piano music? A PDF or photo can be read too — check the notes afterwards.',
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
                  <th className="px-4 py-2.5 font-medium">License</th>
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
              <Heart size={13} /> Credits &amp; licenses
            </Link>
            <a href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer" className="text-accent-400 hover:text-accent-300">
              {SOURCE_CODE_LABEL}
            </a>
            <Link to="/import" className="text-accent-400 hover:text-accent-300">
              Import a song
            </Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
