import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { importBusy, useImport } from '../../state/importStore';
import { discardInterrupted, findInterruptedImport, interruptedNotice } from '../../state/interruptedImport';
import { toast, useToasts, type ToastAction } from '../../state/toastStore';
import { saveBlobAs } from '../../lib/saveBlob';

/**
 * Once per page load: if the previous page died mid-import (see state/interruptedImport.ts), say so
 * and offer Try again / Discard (and Save recording for recordings). Renders nothing itself; the
 * notice is a toast that stays until it is answered.
 */
export function InterruptedImportNotice() {
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    void findInterruptedImport().then((rec) => {
      if (!alive || !rec) return;
      const n = interruptedNotice(rec);
      const actions: ToastAction[] = [];
      if (n.canRetry) {
        actions.push({
          label: 'Try again',
          variant: 'primary',
          onClick: () => {
            if (importBusy(useImport.getState().job)) {
              toast.info('Another import is running', 'Try again once it has finished.');
              return false;
            }
            navigate(rec.kind === 'capture' ? '/import?tab=record' : '/import');
            void useImport.getState().resumePending(rec);
          },
        });
      }
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
