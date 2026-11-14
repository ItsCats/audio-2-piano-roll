/**
 * In-app navigation for code outside React components (toast actions shown by the stores): the app
 * shell registers the router's navigate function; before that, a normal page load.
 */
let navigateFn: ((to: string) => void) | null = null;

export function setAppNavigate(fn: ((to: string) => void) | null): void {
  navigateFn = fn;
}

export function appNavigate(to: string): void {
  if (navigateFn) navigateFn(to);
  else if (typeof window !== 'undefined') window.location.assign(to);
}
