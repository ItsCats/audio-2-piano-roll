/** "Help and shortcuts" for editing the sheet music: touch gestures, keys and how edits behave. */
import { Modal } from '../../ui';
import { SHEET_SHORTCUTS } from '../../../state/sheetKeys';
import { useCompactSheetUi, useSheetUi } from '../../../state/sheetUi';

const TOUCH: [string, string][] = [
  ['Tap a note', 'Select it. Tap the same spot again to switch between notes that sit close together'],
  ['Swipe', 'Scroll the music (a swipe never moves or adds notes)'],
  ['Pinch', 'Make the music bigger or smaller'],
  ['Press and hold a note', 'More actions: select the chord or the bar, fingering, hands, delete'],
  ['More', 'Taps add notes to the selection, or take them out'],
  ['Add, then tap the staff', 'Place a note at that pitch (Undo in the message takes it back)'],
  ['Notes · Marks · Bar', 'Fix notes; add fingering, dynamics, slurs, pedal and words; change key, time or tempo'],
];

const TIPS = [
  'Edits change the level shown (“Editing: Hard”). On Hard, “Copy fixes to Easy & Medium” rebuilds the easier levels with your fixes and markings.',
  'The piano roll, playback, MIDI, audio and video exports all use the edited notes.',
  'Staccato, accents, dynamics and hairpins change how the notes play. Slurs, words and fingering only change the page.',
  'A tempo mark changes the playback speed only in songs without a recording or hand video.',
  'Repeats are written out: edit each time through.',
  'Undo (Ctrl/⌘+Z, or the arrow in the tools) takes back any edit, including loudness changes.',
];

export function SheetHelp() {
  const open = useSheetUi((s) => s.help);
  const set = useSheetUi((s) => s.set);
  const touch = useCompactSheetUi();
  const touchList = (
    <section key="touch">
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-400 uppercase">On a phone or tablet</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
        {TOUCH.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-medium text-ink-100">{k}</dt>
            <dd className="text-ink-300">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
  const keyList = (
    <section key="keys">
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-400 uppercase">Mouse and keyboard</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]" data-testid="sheet-help-keys">
        {SHEET_SHORTCUTS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="rounded-md border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-ink-100">{k}</kbd>
            </dt>
            <dd className="text-ink-300">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
  return (
    <Modal open={open} onClose={() => set({ help: false })} title="Editing the sheet music">
      <div className="flex flex-col gap-5 px-5 py-4" data-testid="sheet-help">
        {touch ? [touchList, keyList] : [keyList, touchList]}
        <section>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-400 uppercase">Good to know</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-ink-300">
            {TIPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}
