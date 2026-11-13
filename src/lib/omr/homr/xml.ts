/**
 * A minimal element tree (the parts of Python's xml.etree.ElementTree homr's MusicXML writer and
 * the page merging use), serialised like ElementTree.tostring.
 */
export class El {
  attrs: [string, string][] = [];
  children: El[] = [];
  text: string | null = null;
  constructor(
    public tag: string,
    attrs: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.push([k, v]);
  }

  get(k: string, d: string | null = null): string | null {
    const a = this.attrs.find(([x]) => x === k);
    return a ? a[1] : d;
  }

  set(k: string, v: string): void {
    const a = this.attrs.find(([x]) => x === k);
    if (a) a[1] = v;
    else this.attrs.push([k, v]);
  }

  removeAttr(k: string): void {
    this.attrs = this.attrs.filter(([x]) => x !== k);
  }

  sub(tag: string, attrs: Record<string, string> = {}, text?: string): El {
    const e = new El(tag, attrs);
    if (text !== undefined) e.text = text;
    this.children.push(e);
    return e;
  }

  append(e: El): void {
    this.children.push(e);
  }

  insert(i: number, e: El): void {
    this.children.splice(i, 0, e);
  }

  remove(e: El): void {
    const i = this.children.indexOf(e);
    if (i < 0) throw new Error('ValueError: list.remove(x): x not in list');
    this.children.splice(i, 1);
  }

  /** find('a') / find('a/b'): the first matching descendant along the path */
  find(path: string): El | null {
    let cur: El[] = [this];
    for (const part of path.split('/')) {
      const next: El[] = [];
      for (const c of cur) for (const ch of c.children) if (ch.tag === part) next.push(ch);
      if (!next.length) return null;
      cur = next;
    }
    return cur[0];
  }

  findall(tag: string): El[] {
    return this.children.filter((c) => c.tag === tag);
  }

  findtext(tag: string, d = ''): string {
    const e = this.find(tag);
    return e ? (e.text ?? '') : d;
  }

  /** all descendants (and self) with the tag, document order */
  iter(tag: string): El[] {
    const out: El[] = [];
    const walk = (e: El) => {
      if (e.tag === tag) out.push(e);
      e.children.forEach(walk);
    };
    walk(this);
    return out;
  }

  toString(): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const attr = (s: string) => esc(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
    const a = this.attrs.map(([k, v]) => ` ${k}="${attr(v)}"`).join('');
    if (!this.children.length && (this.text === null || this.text === '')) return `<${this.tag}${a} />`;
    return `<${this.tag}${a}>${this.text ? esc(this.text) : ''}${this.children.map((c) => c.toString()).join('')}</${this.tag}>`;
  }
}

/** Parse our own serialisation back (the page merging works on the pages' trees; DOMParser where available). */
export function serialize(root: El): string {
  return `<?xml version='1.0' encoding='UTF-8'?>\n${root.toString()}`;
}
