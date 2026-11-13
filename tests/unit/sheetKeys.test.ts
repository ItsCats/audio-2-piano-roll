import { describe, expect, it } from 'vitest';
import { sheetKeyAction, type SheetKeyLike } from '../../src/state/sheetKeys';
import { shouldHandleGlobalKey } from '../../src/state/studioKeys';

const k = (code: string, o: Partial<SheetKeyLike> = {}): SheetKeyLike => ({ code, key: '', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });

describe('sheet edit keys', () => {
  it('maps pitch, time, length and hand keys', () => {
    expect(sheetKeyAction(k('ArrowUp'), true)).toEqual({ type: 'pitch', kind: 'step', dir: 1 });
    expect(sheetKeyAction(k('ArrowDown', { shiftKey: true }), true)).toEqual({ type: 'pitch', kind: 'octave', dir: -1 });
    expect(sheetKeyAction(k('ArrowUp', { altKey: true }), true)).toEqual({ type: 'pitch', kind: 'semi', dir: 1 });
    expect(sheetKeyAction(k('ArrowUp'), false)).toBeNull();
    expect(sheetKeyAction(k('ArrowRight'), true)).toEqual({ type: 'move', dir: 1, beat: false });
    expect(sheetKeyAction(k('ArrowLeft', { shiftKey: true }), true)).toEqual({ type: 'move', dir: -1, beat: true });
    expect(sheetKeyAction(k('ArrowLeft'), false)).toEqual({ type: 'seek', dir: -1, small: false });
    expect(sheetKeyAction(k('ArrowRight', { altKey: true }), true)).toEqual({ type: 'selectNext', dir: 1 });
    expect(sheetKeyAction(k('BracketRight'), true)).toEqual({ type: 'length', step: 1 });
    expect(sheetKeyAction(k('Period'), true)).toEqual({ type: 'dot' });
    expect(sheetKeyAction(k('Digit3', { altKey: true }), true)).toEqual({ type: 'triplet' });
    expect(sheetKeyAction(k('Digit3'), true)).toBeNull(); // finger 3 (later), never the triplet
    expect(sheetKeyAction(k('KeyH'), true)).toEqual({ type: 'hand', hand: 'toggle' });
    expect(sheetKeyAction(k('KeyT'), true)).toEqual({ type: 'tie' });
    expect(sheetKeyAction(k('KeyN'), false)).toEqual({ type: 'addMode' });
    expect(sheetKeyAction(k('KeyQ'), true)).toEqual({ type: 'quantize' });
  });
  it('maps undo, redo and select all; leaves Space, F and E alone', () => {
    expect(sheetKeyAction(k('KeyZ', { ctrlKey: true }), false)).toEqual({ type: 'undo' });
    expect(sheetKeyAction(k('KeyZ', { metaKey: true, shiftKey: true }), false)).toEqual({ type: 'redo' });
    expect(sheetKeyAction(k('KeyY', { ctrlKey: true }), false)).toEqual({ type: 'redo' });
    expect(sheetKeyAction(k('KeyA', { ctrlKey: true }), false)).toEqual({ type: 'selectAll' });
    for (const c of ['Space', 'KeyF', 'KeyE', 'Home']) expect(sheetKeyAction(k(c), true)).toBeNull();
  });
  it('typing in a text field is never a shortcut', () => {
    const input = { closest: (sel: string) => (sel.includes('input') ? {} : null) };
    expect(shouldHandleGlobalKey({ defaultPrevented: false, target: input as unknown as EventTarget })).toBe(false);
  });
});
