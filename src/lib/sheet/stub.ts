/**
 * Stand-in for jsPDF's optional helpers (html2canvas, canvg, DOMPurify; see vite.config.ts). jsPDF
 * only loads them from doc.html() and addSvgAsImage(), which Piano2Vision never calls, so the
 * site doesn't ship them.
 */
function unavailable(): never {
  throw new Error('Not included in Piano2Vision.');
}
export default unavailable;
export const Canvg = unavailable;
