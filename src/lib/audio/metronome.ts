/** Metronome click: a short pitched blip with a fast exponential decay (accented on downbeats). */
export function scheduleClick(ctx: BaseAudioContext, dest: AudioNode, time: number, accent: boolean, volume: number): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(volume * (accent ? 0.5 : 0.32), time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.08);
  osc.onended = () => g.disconnect();
}
