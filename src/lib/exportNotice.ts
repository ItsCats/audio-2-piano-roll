/**
 * A one-time copyright reminder, shown the first time someone exports a song (video, MIDI, sheet
 * music PDF, MusicXML or WAV). It stays until closed and is never shown again in this browser.
 */
import { useToasts } from '../state/toastStore';

/** localStorage key (new; set once the notice has been shown) */
export const EXPORT_NOTICE_KEY = 'piano2vision-export-notice-seen';

export const EXPORT_NOTICE_TITLE = 'Before you share it';
export const EXPORT_NOTICE_TEXT = 'Practicing is fine. Publishing an arrangement of someone else’s song may need permission.';

export function exportNoticeSeen(): boolean {
  try {
    return localStorage.getItem(EXPORT_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Shows the reminder if this browser hasn't seen it yet; returns whether it was shown. */
export function showExportNoticeOnce(): boolean {
  if (exportNoticeSeen()) return false;
  try {
    localStorage.setItem(EXPORT_NOTICE_KEY, '1');
  } catch {
    /* storage blocked: the reminder may show again next time, which is harmless */
  }
  useToasts.getState().push(
    {
      kind: 'info',
      title: EXPORT_NOTICE_TITLE,
      body: EXPORT_NOTICE_TEXT,
      actions: [
        { label: 'Got it', variant: 'secondary', onClick: () => {} },
        {
          label: 'Learn more',
          variant: 'ghost',
          // a new tab, so a running export isn't interrupted
          onClick: () => void window.open('/terms#sharing', '_blank', 'noopener'),
        },
      ],
    },
    0,
  );
  return true;
}
