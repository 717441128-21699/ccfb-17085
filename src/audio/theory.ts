// 乐理工具：音名、和弦、音阶、midi/频率

import type { ChordQuality } from '../types';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
export function freqToMidi(f: number): number {
  return 69 + 12 * Math.log2(f / 440);
}
export function midiName(m: number): string {
  const pc = ((Math.round(m) % 12) + 12) % 12;
  const oct = Math.floor(Math.round(m) / 12) - 1;
  return `${NOTE_NAMES[pc]}${oct}`;
}
export function pcName(pc: number): string {
  return NOTE_NAMES[((pc % 12) + 12) % 12];
}

// 和弦结构（相对根音的半音）
export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
};

export const QUALITY_SYMBOL: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
};

export function chordLabel(rootMidi: number, q: ChordQuality): string {
  return `${pcName(rootMidi)}${QUALITY_SYMBOL[q]}`;
}

export function chordPitchClasses(rootMidi: number, q: ChordQuality): number[] {
  const rootPc = ((rootMidi % 12) + 12) % 12;
  return CHORD_INTERVALS[q].map((i) => (rootPc + i) % 12);
}

/** 跨多个八度展开和弦音，供 worklet 选最近目标 */
export function expandChordMidis(rootMidi: number, q: ChordQuality, lo = 36, hi = 96): number[] {
  const pcs = chordPitchClasses(rootMidi, q);
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) {
    if (pcs.includes(((m % 12) + 12) % 12)) out.push(m);
  }
  return out;
}

// 大调音阶 / 自然小调
export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

export function scalePitchClasses(rootPc: number, mode: 'major' | 'minor'): number[] {
  const intervals = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const r = ((rootPc % 12) + 12) % 12;
  return intervals.map((i) => (r + i) % 12);
}

/** Krumhansl 调式判断用的音级轮廓 */
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function estimateKey(chroma: number[]): { root: number; mode: 'major' | 'minor' } {
  let best = { root: 0, mode: 'major' as 'major' | 'minor', score: -Infinity };
  for (let root = 0; root < 12; root++) {
    for (const mode of ['major', 'minor'] as const) {
      const prof = mode === 'major' ? KS_MAJOR : KS_MINOR;
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += chroma[(root + i) % 12] * prof[i];
      if (dot > best.score) best = { root, mode, score: dot };
    }
  }
  return { root: best.root, mode: best.mode };
}

/** 24 个大小三和弦模板匹配，返回最佳和弦 */
export function matchChord(chroma: number[]): { root: number; quality: 'maj' | 'min'; score: number } {
  const norm = chroma.map((v) => v + 1e-6);
  let best = { root: 0, quality: 'maj' as 'maj' | 'min', score: -Infinity };
  for (let root = 0; root < 12; root++) {
    for (const q of ['maj', 'min'] as const) {
      const tpl = new Array(12).fill(0);
      tpl[root] = 1;
      tpl[(root + (q === 'maj' ? 4 : 3)) % 12] = 0.8;
      tpl[(root + 7) % 12] = 0.9;
      let dot = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < 12; i++) {
        dot += norm[i] * tpl[i];
        a += norm[i] * norm[i];
        b += tpl[i] * tpl[i];
      }
      const cos = dot / (Math.sqrt(a) * Math.sqrt(b));
      if (cos > best.score) best = { root, quality: q, score: cos };
    }
  }
  return best;
}
