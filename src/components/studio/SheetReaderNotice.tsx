import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, PencilRuler, X } from 'lucide-react';
import type { Song } from '../../lib/music/types';
import { useStudio } from '../../state/studioStore';
import { useSettings } from '../../state/settingsStore';
import { Badge, Button, IconButton, Modal } from '../ui';
import { isTouchDevice } from '../../lib/wakeLock';

/** Songs read from a PDF or photo by a sheet-music reader (the Quick one is Beta): the notes are its estimate. */
export const readFromSheet = (song: Pick<Song, 'source'>): boolean => song.source.kind === 'score' && !!song.source.reader;

export const readerWhat = (song: Pick<Song, 'source'>): string => (song.source.reader === 'photo' ? 'a photo' : 'a PDF');

/** Read by the quick reader (Beta; also every song read before there was a choice), not the accurate one. */
export const readByBeta = (song: Pick<Song, 'source'>): boolean => readFromSheet(song) && song.source.sheetReader !== 'accurate';

/** songs whose notice was closed in this visit (it comes back next time the app is opened) */
const dismissed = new Set<string>();

/** The tips: what the reader gets wrong and how to fix it in Edit mode. */
function TipsModal({ open, onClose, song }: { open: boolean; onClose: () => void; song: Song }) {
  const setEditMode = useStudio((s) => s.setEditMode);
  const setSheet = useSettings((s) => s.setSheet);
  const [touch] = useState(isTouchDevice);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Check the notes"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            icon={<PencilRuler size={15} />}
            onClick={() => {
              setSheet({ view: 'roll' });
              setEditMode(true);
              onClose();
            }}
          >
            Start editing
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4 text-[13px] leading-relaxed text-ink-200">
        {readByBeta(song) ? (
          <p>
            These notes were read from {readerWhat(song)} by the Quick sheet-music reader, which is still in <b className="text-warn">Beta</b>. Most notes are
            usually right, but some mistakes are normal.
          </p>
        ) : (
          <p>
            These notes were read from {readerWhat(song)} by the Accurate sheet-music reader. Nearly all notes are usually right, but a wrong rhythm, a
            missing sharp or flat or a note in the wrong hand can still happen.
          </p>
        )}
        <div>
          <p className="font-medium text-ink-50">Compare with your page</p>
          <ul className="mt-1 list-disc pl-5">
            <li>Choose Hard and the Sheet music view, then follow along on your printed page, line by line.</li>
            <li>Look out for wrong rhythms (notes too long or too short), a missing sharp or flat, and notes in the wrong hand.</li>
          </ul>
        </div>
        <div>
          <p className="font-medium text-ink-50">Fix mistakes in Edit mode</p>
          {touch ? (
            <ul className="mt-1 list-disc pl-5">
              <li>Tap Edit (the pencil), then tap a note to select it.</li>
              <li>Drag a note to move it; drag its end to make it longer or shorter.</li>
              <li>The buttons above the notes: the arrows move the note up or down, L and R set the hand, the bin removes it, and the curved arrow undoes.</li>
              <li>Adding missing notes is easier on a computer (double-click).</li>
              <li>Your changes are saved for the level you are on (Easy, Medium or Hard).</li>
            </ul>
          ) : (
            <ul className="mt-1 list-disc pl-5">
              <li>Click Edit (the pencil), then click a note to select it.</li>
              <li>Drag a note to move it; drag its end to make it longer or shorter; double-click to add one.</li>
              <li>↑ / ↓ move the selected note by a semitone; L and R set the hand; Delete removes it; Ctrl+Z undoes.</li>
              <li>Your changes are saved for the level you are on (Easy, Medium or Hard).</li>
            </ul>
          )}
        </div>
        <p className="text-[12.5px] text-ink-300">
          A whole line wrong? Try a sharper, evenly lit photo with the corners set tightly, or the PDF if you have one{readByBeta(song) ? ', or read it again with the Accurate reader' : ''}.{' '}
          <Link to="/accuracy#sheet-reader" className="text-accent-400 hover:text-accent-300" onClick={onClose}>
            How accurate is it?
          </Link>
        </p>
      </div>
    </Modal>
  );
}

/** Header badge for read songs: opens the tips. */
export function SheetReaderBadge({ song }: { song: Song }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring rounded-md"
        title={`Read from ${readerWhat(song)} by the ${readByBeta(song) ? 'Quick sheet-music reader (Beta)' : 'Accurate sheet-music reader'} — check the notes`}
      >
        <span className="whitespace-nowrap">
          <Badge tone="warn">{readByBeta(song) ? 'Sheet music · Beta' : `Read from ${song.source.reader === 'photo' ? 'photo' : 'PDF'}`}</Badge>
        </span>
      </button>
      <TipsModal open={open} onClose={() => setOpen(false)} song={song} />
    </>
  );
}

/** A strip under the Studio header: read from sheet music (Beta), check the notes; links to the tips. */
export function SheetReaderNotice({ song }: { song: Song }) {
  const [hidden, setHidden] = useState(() => dismissed.has(song.id));
  const [open, setOpen] = useState(false);
  if (!readFromSheet(song) || hidden) return null;
  return (
    <div className="flex items-center gap-2 border-b border-warn/25 bg-warn/10 px-3 py-1.5 text-[12.5px] text-ink-100 md:px-4" role="note" data-testid="sheet-reader-notice">
      <AlertTriangle size={15} className="shrink-0 text-warn" />
      <p className="min-w-0 flex-1">
        <span className="font-medium text-warn">Read from sheet music{readByBeta(song) ? ' (Beta)' : ''}</span> — check the notes against your page.{' '}
        <button type="button" onClick={() => setOpen(true)} className="focus-ring rounded font-medium text-accent-300 underline-offset-2 hover:underline">
          How to fix notes
        </button>
      </p>
      <IconButton
        size="sm"
        label="Hide this note"
        onClick={() => {
          dismissed.add(song.id);
          setHidden(true);
        }}
      >
        <X size={15} />
      </IconButton>
      <TipsModal open={open} onClose={() => setOpen(false)} song={song} />
    </div>
  );
}
