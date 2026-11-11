/** Web MIDI input: device detection, note on/off and sustain pedal (CC64). */
export interface MidiDevice {
  id: string;
  name: string;
  manufacturer: string;
  state: 'connected' | 'disconnected';
}

export type MidiInputEvent =
  | { type: 'noteon'; midi: number; velocity: number; device: string }
  | { type: 'noteoff'; midi: number; device: string }
  | { type: 'pedal'; down: boolean; device: string };

type Listener = (e: MidiInputEvent) => void;

export const midiSupported = (): boolean => typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

class MidiInputManager {
  private access: MIDIAccess | null = null;
  private listeners = new Set<Listener>();
  private deviceListeners = new Set<(d: MidiDevice[]) => void>();
  devices: MidiDevice[] = [];
  error: string | null = null;

  async enable(): Promise<MidiDevice[]> {
    if (!midiSupported()) throw new Error('Web MIDI is not supported in this browser (try Chrome, Edge or Firefox).');
    if (!this.access) {
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (e) {
        this.error = (e as Error).message;
        throw new Error(`MIDI access was denied: ${(e as Error).message}`);
      }
      this.access.onstatechange = () => this.refresh();
    }
    this.refresh();
    return this.devices;
  }

  get enabled(): boolean {
    return this.access !== null;
  }

  private refresh() {
    if (!this.access) return;
    this.devices = [];
    this.access.inputs.forEach((input) => {
      input.onmidimessage = (msg) => this.handle(msg, input.name ?? input.id);
      this.devices.push({
        id: input.id,
        name: input.name ?? 'MIDI device',
        manufacturer: input.manufacturer ?? '',
        state: input.state,
      });
    });
    for (const l of this.deviceListeners) l(this.devices);
  }

  private handle(msg: MIDIMessageEvent, device: string) {
    const d = msg.data;
    if (!d || d.length < 2) return;
    const status = d[0] & 0xf0;
    const a = d[1];
    const b = d.length > 2 ? d[2] : 0;
    let ev: MidiInputEvent | null = null;
    if (status === 0x90 && b > 0) ev = { type: 'noteon', midi: a, velocity: b / 127, device };
    else if (status === 0x80 || (status === 0x90 && b === 0)) ev = { type: 'noteoff', midi: a, device };
    else if (status === 0xb0 && a === 64) ev = { type: 'pedal', down: b >= 64, device };
    if (ev) for (const l of this.listeners) l(ev);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onDevices(l: (d: MidiDevice[]) => void): () => void {
    this.deviceListeners.add(l);
    return () => this.deviceListeners.delete(l);
  }
  /** Inject events from the on-screen / computer keyboard so practice works without hardware. */
  emit(e: MidiInputEvent) {
    for (const l of this.listeners) l(e);
  }
}

export const midiInput = new MidiInputManager();

/** Computer keyboard → MIDI (two rows like a piano: A W S E D F T G Y H U J K O L P ;). */
export const QWERTY_MAP: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};
