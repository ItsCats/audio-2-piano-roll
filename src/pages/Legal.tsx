/**
 * Privacy (/privacy), Terms (/terms) and Copyright (/copyright). Plain language, specific to what the
 * code actually does: keep these pages true when a feature changes what is downloaded, stored or sent,
 * and move LEGAL_LAST_UPDATED (src/lib/site.ts) forward when the text changes.
 */
import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { cn } from '../components/ui';
import { SOURCE_CODE_URL } from '../lib/credits';
import { CONTACT_EMAIL, CONTACT_URL, COPYRIGHT_EMAIL, LEGAL_LAST_UPDATED, SITE_NAME, SITE_PROCESSING_HOST } from '../lib/site';

export type LegalPageId = 'privacy' | 'terms' | 'copyright';

const PAGES: { id: LegalPageId; label: string }[] = [
  { id: 'privacy', label: 'Privacy' },
  { id: 'terms', label: 'Terms' },
  { id: 'copyright', label: 'Copyright' },
];

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-400 underline-offset-2 hover:text-accent-300 hover:underline">
      {children}
    </a>
  );
}

function In({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-accent-400 underline-offset-2 hover:text-accent-300 hover:underline">
      {children}
    </Link>
  );
}

function Part({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="text-[17px] font-semibold tracking-tight text-ink-50">{title}</h2>
      <div className="mt-2 flex flex-col gap-2.5 text-[14px] leading-relaxed text-ink-200">{children}</div>
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1.5 pl-5 marker:text-ink-400">{children}</ul>;
}

/** How to reach us: e-mail (when the site has an address) and the public issue tracker. */
function Contact({ email, privateNote }: { email: string; privateNote: string }) {
  return (
    <>
      {email && (
        <p>
          E-mail:{' '}
          <a href={`mailto:${email}`} className="text-accent-400 underline-offset-2 hover:text-accent-300 hover:underline">
            {email}
          </a>
        </p>
      )}
      <p>
        {email ? 'Or open' : 'Open'} an issue on GitHub: <Ext href={CONTACT_URL}>{CONTACT_URL.replace(/^https:\/\//, '')}</Ext>. Issues are public, so
        don’t put private details there{email ? ': e-mail us instead.' : `. ${privateNote}`}
      </p>
    </>
  );
}

function Privacy() {
  return (
    <>
      <p className="text-[15px] leading-relaxed text-ink-100">
        The short version: {SITE_NAME} has no accounts, no ads and no analytics. Your music stays on your device.
      </p>

      <Part title="What stays on your device">
        <p>
          The songs you import, your microphone recordings, sheet music files and photos, your library, your edits and your settings are processed
          and saved in this browser on this device (in the browser’s own storage, called IndexedDB and local storage).{' '}
          {SITE_PROCESSING_HOST ? 'They are not uploaded to us, except audio sent to our processing server (see below).' : 'They are not uploaded to us.'}
        </p>
        <p>
          The AI that listens to the music and writes out the notes runs inside your browser too. We can’t see your songs, and we can’t get them back
          for you if they are deleted. To keep a copy or move a song to another device, use <b>Export → Project file</b>.
        </p>
      </Part>

      <Part title="What your browser downloads">
        <p>
          The first time they are needed, your browser downloads the app, the AI models (note detection, voice and drum separation, the high-accuracy
          piano model and the sheet-music reader) and the piano sounds, all from this site. It keeps them so they don’t have to download again. The
          fonts are part of the app; no outside font or script services are used.
        </p>
      </Part>

      <Part title="What can leave your device">
        <List>
          <li>
            <b>Hosting.</b> This site is hosted by Netlify. Like any website, its servers see your IP address, your browser type and which pages and
            files are requested, and keep this in logs for a limited time to run and protect the service. See{' '}
            <Ext href="https://www.netlify.com/privacy/">Netlify’s privacy policy</Ext>. Your songs are not part of these requests.
          </li>
          {SITE_PROCESSING_HOST ? (
            <li>
              <b>Our processing server.</b> This site uses a processing server at <b>{SITE_PROCESSING_HOST}</b> for some imports, unless you enter
              another address in <b>Settings → Processing server</b>. When you import audio, the page checks that the server is online, so it sees
              your IP address. The audio you choose to separate (this can be a file or a recording) is sent to that server to be
              processed.
            </li>
          ) : (
            <li>
              <b>A processing server, only if one is set.</b> It is off unless a server address appears in <b>Settings → Processing server</b>. If
              one is set, the audio you choose to separate is sent to that server. The person who runs that server
              can see it, and their rules apply.
            </li>
          )}
          <li>
            <b>Links you open.</b> Links to GitHub, to the projects on the Credits page and to other sites open those sites, which have their own
            privacy policies.
          </li>
        </List>
      </Part>

      <Part title="Cookies and tracking">
        <p>
          {SITE_NAME} sets no tracking cookies, has no analytics or ads, and has no accounts or sign-in. It uses your browser’s storage only to save
          your songs and settings.
        </p>
      </Part>

      <Part title="Microphone, MIDI keyboard and computer sound">
        <p>
          The microphone, a MIDI keyboard and recording another tab’s sound (<b>Import → Computer sound</b>) are only used when you press the button for them, and your browser asks for
          permission first.{' '}
          {SITE_PROCESSING_HOST
            ? 'The keys you play stay on your device. A recording you import is handled like any other audio: on your device, unless you choose to separate it on the processing server (see above).'
            : 'The sound and the keys you play are handled on your device and are not sent anywhere.'}
        </p>
      </Part>

      <Part id="delete" title="Deleting your data">
        <List>
          <li>
            One song: open <In to="/library">My Library</In> and delete it.
          </li>
          <li>
            Everything: clear this site’s data in your browser’s settings (for example in Chrome: the icon left of the address → Site settings →
            Delete data; on iPhone: Settings → Apps → Safari → Advanced → Website Data). This can’t be undone.
          </li>
        </List>
        <p>
          Browsers can also clear a site’s storage on their own, for example when the device is low on space, or Safari when you haven’t used the
          site for a while. Export project files of songs you want to keep.
        </p>
      </Part>

      <Part title="Children">
        <p>
          {SITE_NAME} doesn’t ask anyone for their name, e-mail address or other personal details, whatever their age.
        </p>
      </Part>

      <Part title="Changes">
        <p>
          If anything here changes, for example if we ever add a way to count visits, we will update this page before the change goes live and change
          the date at the top.
        </p>
      </Part>

      <Part title="Contact">
        <Contact email={CONTACT_EMAIL} privateNote="If you need to tell us something privately, say so in the issue and we’ll reply with a private way to reach us." />
      </Part>
    </>
  );
}

function Terms() {
  return (
    <>
      <p className="text-[15px] leading-relaxed text-ink-100">
        By using {SITE_NAME} you agree to these terms. They are short, so please read them.
      </p>

      <Part title="A free tool, provided as is">
        <p>
          {SITE_NAME} is free. It is provided “as is”, without any warranty: it may have bugs, lose data, change or stop at any time. As far as the law
          allows, we are not responsible for any loss that comes from using it, including lost songs or recordings. Keep project files of work you
          care about.
        </p>
        <p>
          The source code is free software under the <Ext href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public License</Ext>,
          version 3 or later, which also comes without warranty: <Ext href={SOURCE_CODE_URL}>source code</Ext>.
        </p>
      </Part>

      <Part id="sharing" title="Your music, and what you share">
        <List>
          <li>Only import music, recordings, videos and sheet music you have the right to use.</li>
          <li>Practising with a song on your own device is fine.</li>
          <li>
            Publishing what you make (a video, sheet music, a MIDI or MusicXML file) from someone else’s song may need permission from the people who
            own it, such as the songwriter or music publisher, and the record label if the original recording is mixed in.
          </li>
          <li>You are responsible for what you publish and where.</li>
        </List>
      </Part>

      <Part id="recording" title="Recording from other sites and apps">
        <p>
          Check the terms of the website or app you’re playing from (for example a social media app) before you record its audio, with{' '}
          <b>Computer sound</b>, a screen recording or the microphone. Many of them don’t allow it. Only record music you have the rights to use.{' '}
          {SITE_NAME} is not made by, affiliated with or endorsed by any of them.
        </p>
      </Part>

      <Part title="AI results can be wrong">
        <p>
          The notes, the hands, the separated voice and drums, and sheet music read from a PDF or photo are AI estimates. Notes can be missing, extra
          or wrong. Check them before you rely on them. See <In to="/accuracy">how accurate it is</In>.
        </p>
      </Part>

      <Part title="Using the site fairly">
        <p>
          Don’t use {SITE_NAME} for anything illegal, to get around copy protection, or to attack or overload the site.
        </p>
      </Part>

      <Part title="Other people’s work">
        <p>
          The AI models, piano sounds, fonts and libraries in {SITE_NAME} were made by other people and keep their own licences. See the{' '}
          <In to="/credits">Credits</In> page.
        </p>
      </Part>

      <Part title="Changes">
        <p>We may update these terms. The date at the top shows the latest version; using the site after a change means you accept it.</p>
      </Part>

      <Part title="Contact">
        <Contact email={CONTACT_EMAIL} privateNote="If you need to tell us something privately, say so in the issue and we’ll reply with a private way to reach us." />
      </Part>
    </>
  );
}

function Copyright() {
  return (
    <>
      <p className="text-[15px] leading-relaxed text-ink-100">How to tell us about a copyright problem.</p>

      <Part title="We don’t host what people import">
        <p>
          {SITE_NAME} doesn’t store anyone’s songs, recordings, videos or sheet music on its servers. Everything people import stays in their own
          browser, and there is no public gallery or sharing on this site. So we can’t remove a video or file that someone published somewhere else:
          please report it on the site where it was published, using that site’s copyright form.
        </p>
      </Part>

      <Part title="What this site does host">
        <p>
          The app itself, the AI models, the piano sounds, the fonts and a demo piece (J. S. Bach’s Prelude in C major, which is in the public
          domain). Everything we use from others is listed with its licence on the <In to="/credits">Credits</In> page.
        </p>
      </Part>

      <Part title="Reporting a problem">
        <p>If you think something this site hosts uses your work without permission, or a credit is wrong or missing, tell us:</p>
        <List>
          <li>your name and how to reach you;</li>
          <li>which work is yours;</li>
          <li>where it is on this site (the page address or file);</li>
          <li>that you believe in good faith the use isn’t allowed, and that what you tell us is accurate and you are the owner or allowed to act for them.</li>
        </List>
        <p>We’ll look at it as soon as we can, remove or fix it if it’s a problem, and reply to you.</p>
      </Part>

      <Part title="Contact">
        <Contact
          email={COPYRIGHT_EMAIL}
          privateNote="To send a copyright notice privately, say so in the issue (no personal details needed) and we’ll reply with a private way to send it."
        />
      </Part>
    </>
  );
}

const TITLES: Record<LegalPageId, string> = { privacy: 'Privacy', terms: 'Terms of use', copyright: 'Copyright' };

export default function LegalPage({ page }: { page: LegalPageId }) {
  const { hash } = useLocation();
  // links such as /terms#sharing: the page loads lazily, after the browser looked for the anchor
  useEffect(() => {
    if (hash.length > 1) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [page, hash]);
  return (
    // keyed: switching between the three pages starts at the top
    <div key={page} className="h-full overflow-y-auto">
      <article className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-8 sm:px-5 md:px-10">
        <header>
          <nav className="flex flex-wrap gap-2" aria-label="Site policies">
            {PAGES.map((p) => (
              <NavLink
                key={p.id}
                to={`/${p.id}`}
                className={({ isActive }) =>
                  cn(
                    'focus-ring rounded-lg px-3 py-1.5 text-[13px] font-medium',
                    isActive ? 'bg-ink-750 text-ink-50 shadow-[inset_0_0_0_1px_var(--color-ink-700)]' : 'bg-ink-800 text-ink-300 hover:text-ink-100',
                  )
                }
              >
                {p.label}
              </NavLink>
            ))}
          </nav>
          <h1 className="mt-5 text-[28px] font-semibold tracking-tight text-ink-50 md:text-[32px]">{TITLES[page]}</h1>
          <p className="mt-1 text-[12.5px] text-ink-400">Last updated {LEGAL_LAST_UPDATED}</p>
        </header>
        {page === 'privacy' ? <Privacy /> : page === 'terms' ? <Terms /> : <Copyright />}
      </article>
    </div>
  );
}
