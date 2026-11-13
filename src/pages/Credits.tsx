import { Link } from 'react-router-dom';
import { ExternalLink, Heart, Sparkles } from 'lucide-react';
import { CREDITS, INSPIRATION, ORIGINAL_WORK, SOURCE_CODE_LABEL, SOURCE_CODE_URL } from '../lib/credits';
import { Badge } from '../components/ui';

export default function CreditsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-5 py-8 md:px-10">
        <header>
          <p className="text-[12px] font-semibold tracking-[0.14em] text-accent-400 uppercase">Credits</p>
          <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-ink-50 md:text-[32px]">Made possible by</h1>
          <p className="mt-3 max-w-3xl text-[14.5px] leading-relaxed text-ink-300">
            Piano2Vision is built on AI models, piano recordings, fonts and open-source software shared by other people. Thank you to everyone
            below. Each item links to its project and licence.
          </p>
          <nav className="mt-4 flex flex-wrap gap-2" aria-label="Sections">
            {CREDITS.map((g) => (
              <a key={g.id} href={`#${g.id}`} className="focus-ring rounded-lg bg-ink-800 px-2.5 py-1 text-[12px] text-ink-200 hover:bg-ink-750 hover:text-ink-50">
                {g.title}
              </a>
            ))}
          </nav>
        </header>

        {CREDITS.map((g) => (
          <section key={g.id} id={g.id} className="scroll-mt-6">
            <h2 className="text-[13px] font-semibold tracking-wide text-ink-200">{g.title}</h2>
            {g.intro && <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-ink-400">{g.intro}</p>}
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {g.items.map((c) => (
                <article key={c.name} className="panel flex flex-col gap-1.5 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <a href={c.url} target="_blank" rel="noopener noreferrer" className="focus-ring group inline-flex items-center gap-1.5 rounded text-[14.5px] font-semibold text-ink-50 hover:text-accent-300">
                      {c.name}
                      <ExternalLink size={13} className="text-ink-400 group-hover:text-accent-300" />
                    </a>
                    {c.licenseUrl ? (
                      <a href={c.licenseUrl} target="_blank" rel="noopener noreferrer" className="focus-ring rounded-md" title="Read the licence">
                        <Badge tone="accent">{c.license}</Badge>
                      </a>
                    ) : (
                      <Badge>{c.license}</Badge>
                    )}
                  </div>
                  <p className="text-[13px] leading-relaxed text-ink-200">{c.use}</p>
                  <p className="text-[12px] leading-relaxed text-ink-400">By {c.author}</p>
                  {c.note && <p className="text-[12px] leading-relaxed text-ink-400 italic">{c.note}</p>}
                </article>
              ))}
            </div>
          </section>
        ))}

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink-50">
            <Heart size={16} className="text-accent-400" /> Design inspiration
          </h2>
          <ul className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed text-ink-300">
            {INSPIRATION.map((i) => (
              <li key={i.name}>
                <b className="font-semibold text-ink-100">{i.name}</b> — {i.text}
              </li>
            ))}
          </ul>
        </section>

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink-50">
            <Sparkles size={16} className="text-accent-400" /> Made for Piano2Vision
          </h2>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-ink-300">
            {ORIGINAL_WORK.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>

        <footer className="flex flex-col gap-2 border-t border-ink-800 pt-5 text-[12px] leading-relaxed text-ink-400">
          <p className="flex items-center gap-1.5">
            <Heart size={13} className="text-accent-400" /> Found something missing or credited wrongly? Please let us know and we’ll fix it.
          </p>
          <p>
            Piano2Vision is free software under the GNU Affero General Public License, version 3 or later:{' '}
            <a href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer" className="text-accent-400 hover:text-accent-300">
              {SOURCE_CODE_LABEL}
            </a>
            . The models, piano sounds, fonts and libraries above keep their own licences.
          </p>
          <p>
            Piano2Vision is not affiliated with YouTube, Spotify, Google, ByteDance, Rousseau or any other project or person listed here. You are responsible for having
            the rights to the music you import. See also{' '}
            <Link to="/accuracy" className="text-accent-400 hover:text-accent-300">
              how accurate is it?
            </Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
