/**
 * A small, dependency-free XML reader for score files (MusicXML, MuseScore). Runs the same in the
 * browser, in a worker and in Node tests (no DOMParser). It builds a plain element tree and
 * ignores what scores don't need: the DOCTYPE (no external entities are ever loaded), processing
 * instructions, comments and namespaces (prefixes are kept as part of the name).
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text directly inside this element (entities decoded, not trimmed). */
  text: string;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[e] ?? m;
  });
}

export class XmlError extends Error {}

/** Parses an XML document and returns its root element. Throws XmlError on malformed input. */
export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      if (stack.length > 1) top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i && stack.length > 1) top.text += decodeEntities(src.slice(i, lt));
    const c = src[lt + 1];
    if (c === '!') {
      if (src.startsWith('<!--', lt)) {
        const e = src.indexOf('-->', lt + 4);
        i = e < 0 ? n : e + 3;
      } else if (src.startsWith('<![CDATA[', lt)) {
        const e = src.indexOf(']]>', lt + 9);
        if (stack.length > 1) top.text += src.slice(lt + 9, e < 0 ? n : e);
        i = e < 0 ? n : e + 3;
      } else {
        // <!DOCTYPE …> possibly with an internal subset in [ … ]: skipped (no entity expansion)
        let j = lt + 2;
        let depth = 0;
        while (j < n) {
          const ch = src[j];
          if (ch === '[') depth++;
          else if (ch === ']') depth--;
          else if (ch === '>' && depth <= 0) break;
          j++;
        }
        i = j + 1;
      }
      continue;
    }
    if (c === '?') {
      const e = src.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '/') {
      const e = src.indexOf('>', lt + 2);
      if (e < 0) throw new XmlError('Unexpected end of file.');
      const name = src.slice(lt + 2, e).trim();
      if (stack.length <= 1) throw new XmlError(`Unexpected closing tag </${name}>.`);
      const open = stack.pop()!;
      if (open.name !== name) throw new XmlError(`Mismatched tags <${open.name}> and </${name}>.`);
      i = e + 1;
      continue;
    }
    // start tag: name, attributes (quoted values may contain '>')
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(lt + 1, j);
    if (!name) throw new XmlError('Malformed tag.');
    const el: XmlElement = { name, attrs: {}, children: [], text: '' };
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) throw new XmlError('Unexpected end of file.');
      if (src[j] === '>') {
        j++;
        break;
      }
      if (src[j] === '/' && src[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const a0 = j;
      while (j < n && !/[\s=/>]/.test(src[j])) j++;
      const an = src.slice(a0, j);
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] !== '=') {
        if (!an) throw new XmlError(`Malformed attribute in <${name}>.`);
        el.attrs[an] = '';
        continue;
      }
      j++;
      while (j < n && /\s/.test(src[j])) j++;
      const q = src[j];
      if (q !== '"' && q !== "'") throw new XmlError(`Unquoted attribute in <${name}>.`);
      const e = src.indexOf(q, j + 1);
      if (e < 0) throw new XmlError('Unexpected end of file.');
      el.attrs[an] = decodeEntities(src.slice(j + 1, e));
      j = e + 1;
    }
    top.children.push(el);
    if (!selfClosing) stack.push(el);
    i = j;
  }
  if (stack.length > 1) throw new XmlError(`The file ends inside <${stack[stack.length - 1].name}>.`);
  const docRoot = root.children[0];
  if (!docRoot) throw new XmlError('The file is empty.');
  return docRoot;
}

// ---------------------------------------------------------------- helpers

export const child = (el: XmlElement | undefined, name: string): XmlElement | undefined => el?.children.find((c) => c.name === name);
export const childrenNamed = (el: XmlElement | undefined, name: string): XmlElement[] => (el ? el.children.filter((c) => c.name === name) : []);
/** Trimmed text of a child element ('' when missing). */
export const childText = (el: XmlElement | undefined, name: string): string => child(el, name)?.text.trim() ?? '';
/** Number in a child element (NaN when missing). */
export const childNum = (el: XmlElement | undefined, name: string): number => {
  const t = childText(el, name);
  return t ? Number(t) : NaN;
};
/** All descendants with this name, depth first in document order. */
export function descendants(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
/** All text inside an element and its descendants. */
export function deepText(el: XmlElement): string {
  return el.text + el.children.map(deepText).join('');
}

/**
 * Text of a score file's bytes: UTF-8 (default), UTF-16 with a byte-order mark, or the encoding
 * named in the XML declaration (e.g. ISO-8859-1 from older exporters).
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  // UTF-16 without a BOM: '<' followed by a zero byte (or the other way round)
  if (bytes[0] === 0x3c && bytes[1] === 0) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0 && bytes[1] === 0x3c) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const m = /encoding\s*=\s*["']([A-Za-z0-9_.:-]+)["']/.exec(head);
  const enc = m?.[1].toLowerCase();
  // Real UTF-16 was caught above (BOM or zero bytes); a UTF-16 label on 8-bit text is wrong, so
  // it is read as UTF-8, like browsers do.
  if (enc && enc !== 'utf-8' && enc !== 'utf8' && !enc.startsWith('utf-16') && enc !== 'ucs-2' && enc !== 'unicode') {
    try {
      return new TextDecoder(enc).decode(bytes);
    } catch {
      /* unknown label: fall back to UTF-8 */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}
