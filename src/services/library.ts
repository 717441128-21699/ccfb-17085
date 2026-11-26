// 启动音频引擎 + 构建演示曲/哨声音色 + 分析节拍和弦
import { engine } from '../audio/engine';
import { store } from '../state/store';
import { buildDemoTracks, buildWhistlePresets } from '../audio/demoSounds';
import { analyzeBuffer, referenceBeatMap } from '../audio/analysis';
import type { Track, WhistlePreset } from '../types';

let booting: Promise<void> | null = null;

export function bootLibrary(): Promise<void> {
  if (booting) return booting;
  booting = (async () => {
    store.toast('正在启动音频引擎并合成演示音源…', 'info', 2000);
    const ctx = await engine.ensure();

    const whistles: WhistlePreset[] = buildWhistlePresets(ctx).map((w) => {
      engine.registerDemoWhistle(w.id, w.buffer);
      return { id: w.id, name: w.name, desc: w.desc, buffer: w.buffer };
    });
    store.set({ whistles });

    const defs = buildDemoTracks(ctx);
    const tracks: Track[] = [];
    for (const d of defs) {
      // 自编演示曲使用精确编曲网格；“重新分析”会改跑真实分析器
      const beatmap = referenceBeatMap({
        bpm: d.bpm,
        beatsPerBar: d.beatsPerBar,
        bars: d.bars,
        durationSec: d.buffer.duration,
        chords: d.chords,
        keyRoot: d.keyRoot,
        keyMode: d.keyMode,
      });
      tracks.push({
        id: d.id,
        title: d.title,
        kind: 'demo',
        buffer: d.buffer,
        beatmap,
        expected: { bpm: d.bpm, chords: d.expectedChordLabels },
      });
    }
    store.setTracks(tracks);
    if (!store.state.currentTrackId && tracks[0]) store.selectTrack(tracks[0].id);
    const t = store.currentTrack();
    if (t) engine.loadTrack(t);

    store.set({ booted: true, ctxReady: true });
    store.toast('就绪：可导入伴奏，或直接用演示曲与演示哨声', 'ok');
  })().catch((err) => {
    booting = null;
    store.toast(`音频启动失败：${err?.message ?? err}`, 'err', 6000);
    throw err;
  });
  return booting;
}

export async function importAudioFile(file: File): Promise<Track> {
  const ctx = await engine.ensure();
  const arr = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(arr);
  const beatmap = await analyzeBuffer(buffer, 4);
  const track: Track = {
    id: `file-${Date.now()}`,
    title: file.name.replace(/\.[^.]+$/, ''),
    kind: 'file',
    buffer,
    beatmap,
    fileName: file.name,
  };
  store.addTrack(track);
  engine.loadTrack(track);
  return track;
}
