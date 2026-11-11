/** 16-bit PCM WAV writer that accepts audio in chunks (keeps memory bounded for long songs). */
export class WavWriter {
  private parts: BlobPart[] = [];
  private frames = 0;
  constructor(
    private sampleRate: number,
    private channels = 2,
  ) {}

  append(buffer: AudioBuffer, fromFrame = 0, toFrame = buffer.length): void {
    const n = Math.max(0, toFrame - fromFrame);
    const out = new Int16Array(n * this.channels);
    const chans = Array.from({ length: this.channels }, (_, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) {
        const v = Math.max(-1, Math.min(1, chans[c][fromFrame + i]));
        out[i * this.channels + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    this.parts.push(out.buffer);
    this.frames += n;
  }

  finish(): Blob {
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const dataBytes = this.frames * this.channels * 2;
    const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    w(0, 'RIFF');
    v.setUint32(4, 36 + dataBytes, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, this.channels, true);
    v.setUint32(24, this.sampleRate, true);
    v.setUint32(28, this.sampleRate * this.channels * 2, true);
    v.setUint16(32, this.channels * 2, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, dataBytes, true);
    return new Blob([header, ...this.parts], { type: 'audio/wav' });
  }
}
