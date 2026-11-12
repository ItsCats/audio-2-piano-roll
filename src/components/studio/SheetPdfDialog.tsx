/** "Sheet music PDF" dialog: paper size, then the PDF is made in the page and downloaded. */
import { useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { Button, Modal, ProgressBar, Segmented } from '../ui';
import { useStudio } from '../../state/studioStore';
import { useSettings } from '../../state/settingsStore';
import { toast } from '../../state/toastStore';
import { downloadBlob, safeFileName } from '../../lib/export/downloads';
import { defaultPaper } from '../../lib/sheet/paper';

export function SheetPdfDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const song = useStudio((s) => s.song);
  const difficulty = useStudio((s) => s.difficulty);
  const paperSetting = useSettings((s) => s.sheet.paper);
  const setSheet = useSettings((s) => s.setSheet);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const paper = paperSetting === 'auto' ? defaultPaper() : paperSetting;

  const make = async () => {
    if (!song || busy) return;
    setBusy(true);
    setProgress(null);
    const ac = new AbortController();
    abortRef.current = ac;
    // let the dialog paint "Making the PDF…" before the heavy work starts
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const [{ buildSheet }, { makeSheetPdf }] = await Promise.all([import('../../lib/sheet'), import('../../lib/sheet/pdf')]);
      const { blob, pages } = await makeSheetPdf(buildSheet(song, difficulty), { title: song.title || 'Untitled', artist: song.artist }, paper, {
        signal: ac.signal,
        onProgress: (done, total) => setProgress(done / total),
      });
      downloadBlob(blob, `${safeFileName(song.title)} (${difficulty}).pdf`);
      toast.success('PDF ready', `${pages} ${pages === 1 ? 'page' : 'pages'}`);
      onClose();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      console.error(e);
      toast.error('Couldn’t make the PDF', (e as Error).message);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };
  const cancel = () => {
    abortRef.current?.abort();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={cancel}
      title="Sheet music PDF"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" icon={<FileText size={15} />} onClick={() => void make()} disabled={busy || !song?.arrangements[difficulty].notes.length}>
            Download PDF
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <p className="text-[13px] text-ink-300">
          The <span className="capitalize">{difficulty}</span> notes as printable sheet music, with your edits.
        </p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-100">Paper size</span>
          <Segmented<'a4' | 'letter'>
            ariaLabel="Paper size"
            value={paper}
            onChange={(v) => setSheet({ paper: v })}
            options={[
              { value: 'a4', label: 'A4' },
              { value: 'letter', label: 'Letter' },
            ]}
          />
        </div>
        {busy && (
          <div className="flex flex-col gap-2" aria-live="polite">
            <span className="text-[12.5px] text-ink-300">Making the PDF…</span>
            <ProgressBar value={progress} />
          </div>
        )}
      </div>
    </Modal>
  );
}
