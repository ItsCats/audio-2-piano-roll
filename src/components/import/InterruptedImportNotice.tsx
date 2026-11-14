import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { crashChecksDone, importBusy, resumeBlend, resumeTranscriber, useImport, type PendingWithTranscriber } from '../../state/importStore';
import { discardInterrupted, findInterruptedImport, interruptedNotice, stillInterrupted } from '../../state/interruptedImport';
import { toast, useToasts, type ToastAction } from '../../state/toastStore';
import { saveBlobAs } from '../../lib/saveBlob';
import { watchDatabaseBlocked } from '../../lib/storage/db';

/**
 * Once per page load: if the previous page died mid-import (see state/interruptedImport.ts), say so
 * and offer Try again / Discard (and Save recording for recordings). Renders nothing itself; the
 * notice is a toast that stays until it is answered.
 */
export function InterruptedImportNotice() {
  const navigate = useNavigate();
  // after an update, a tab still running the previous version keeps the library closed to this one
  useEffect(() => {
    let shown: number | null = null;
    const off = watchDatabaseBlocked((blocked) => {
      if (blocked && shown === null) {
        shown = useToasts
          .getState()
          .push(
            { kind: 'warn', title: 'Piano2Vision is open in another tab', body: 'Close or reload the other tab to open your library here (the app was updated).' },
            0,
          );
      } else if (!blocked && shown !== null) {
        useToasts.getState().dismiss(shown);
        shown = null;
      }
    });
    return () => {
      off();
      if (shown !== null) useToasts.getState().dismiss(shown);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    void Promise.all([findInterruptedImport(), crashChecksDone()]).then(([rec]) => {
      if (!alive || !rec) return;
      // (after the crash checks: a record whose high-accuracy run took the tab down is resumed with the fast model)
      const n = interruptedNotice(rec, resumeTranscriber(rec as PendingWithTranscriber), undefined, resumeBlend(rec as PendingWithTranscriber));
      const actions: ToastAction[] = [];
      const resume =
        (opts?: { reader: 'accurate' }): ToastAction['onClick'] =>
        async () => {
          if (importBusy(useImport.getState().job)) {
            toast.info('Another import is running', 'Try again once it has finished.');
            return false;
          }
          if (!(await stillInterrupted(rec.id))) {
            toast.info('Already taken care of', 'This import was restarted or discarded in another tab.');
            return;
          }
          if (importBusy(useImport.getState().job)) return false;
          navigate(rec.kind === 'capture' ? '/import?tab=record' : rec.kind === 'score' ? '/import?tab=midi' : '/import');
          void useImport.getState().resumePending(rec, opts);
        };
      if (n.canRetry) actions.push({ label: n.retryLabel ?? 'Try again', variant: 'primary', onClick: resume() });
      // the accurate sheet-music reader on a computer: once more with it, in its low-memory mode
      if (n.canRetry && n.retryAccurateLabel) actions.push({ label: n.retryAccurateLabel, onClick: resume({ reader: 'accurate' }) });
      if (n.canSave && rec.blob) {
        const blob = rec.blob;
        actions.push({ label: 'Save recording', onClick: () => (saveBlobAs(blob, rec.fileName), false) });
      }
      actions.push({ label: 'Discard', variant: 'ghost', onClick: () => void discardInterrupted(rec.id) });
      useToasts.getState().push({ kind: 'warn', title: n.title, body: n.body, actions }, 0);
    });
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
