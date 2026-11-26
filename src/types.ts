// 共享类型定义

export type PageId = 'import' | 'chords' | 'fx' | 'record';

export type ChordQuality = 'maj' | 'min' | 'dim' | 'aug' | '7' | 'maj7' | 'min7';

export interface ChordEvent {
  id: string;
  /** 相对于节拍网格的起始拍 */
  startBeat: number;
  /** 持续拍数 */
  beats: number;
  rootMidi: number; // 根音 midi（含八度信息，通常取 48~60 区间）
  quality: ChordQuality;
  label: string;
  startSec: number;
  endSec: number;
  confidence: number;
}

export interface BeatMap {
  bpm: number;
  /** 第一拍在音频缓冲中的时间（秒） */
  offsetSec: number;
  beatsPerBar: 3 | 4;
  beatSec: number;
  durationSec: number;
  /** 所有拍点的缓冲时间 */
  beats: number[];
  /** 重拍（小节首拍）时间 */
  downbeats: number[];
  chords: ChordEvent[];
  keyRoot: number; // 0..11
  keyMode: 'major' | 'minor';
  bpmConfidence: number;
  analyzedAt?: string;
}

export interface Track {
  id: string;
  title: string;
  kind: 'demo' | 'file';
  buffer: AudioBuffer;
  beatmap: BeatMap;
  fileName?: string;
  /** 演示曲目的真实参数，仅自检用 */
  expected?: { bpm: number; chords: string[] };
}

export interface WhistlePreset {
  id: string;
  name: string;
  desc: string;
  buffer: AudioBuffer;
}

export type BeatFxMode = 'off' | 'vibrato' | 'echo' | 'both';
export type HarmonyMode = 'diatonic' | 'chord';
export type InputSource = 'mic' | string; // 'mic' 或哨声 preset id

export interface FxSettings {
  source: InputSource;
  micReady: boolean;
  strength: number; // 0..1 拉音力度
  retuneMs: number;
  gateDb: number;
  wind: number; // 0..1 风噪抑制
  h3: number; // 三度音量 0..1
  h5: number; // 五度音量
  harmonyMode: HarmonyMode;
  beatFx: BeatFxMode;
  fxAmount: number; // 0..1
  echoBeats: 0.5 | 0.75 | 1;
  whistleGain: number;
  accompGain: number;
  master: number;
  monitoring: boolean;
}

export interface PitchSnapshot {
  midi: number | null;
  freq: number | null;
  confidence: number;
  rms: number;
  gate: number;
  voiced: boolean;
  target: number | null;
  h3: number;
  h5: number;
}

export interface Take {
  id: string;
  url: string;
  blob: Blob;
  mime: string;
  startedAt: number;
  durationSec: number;
  size: number;
  name: string;
}

export interface TransportState {
  playing: boolean;
  currentSec: number;
  durationSec: number;
  bpm: number;
  currentBeat: number; // 全局拍序号（浮点）
  beatInBar: number;
}
