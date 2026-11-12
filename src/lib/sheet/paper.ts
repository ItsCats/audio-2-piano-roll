export type Paper = 'a4' | 'letter';

/** Paper size for 'auto': Letter in the US, Canada, Mexico and the Philippines, A4 elsewhere. */
export function defaultPaper(locale = typeof navigator !== 'undefined' ? navigator.language : 'en-GB'): Paper {
  return /^(en-US|en-CA|es-MX|fil-PH|en-PH)$/i.test(locale) ? 'letter' : 'a4';
}
