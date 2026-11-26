// 从 AudioBuffer 分析：BPM、拍点、重拍、和弦、调式。
// 纯离线 DSP，不依赖 Web Audio 图。

import type { BeatMap, ChordEvent, ChordQuality } from '../types';
import { estimateKey, matchChord, chordLabel } from './theory';

const FFT_N = 2048;
const HOP = 512;

/** 基 2 迭代 FFT */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
        const vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

function autocorrTempo(env: Float32Array, hopSec: number): { lag: number; score: number } {
  // BPM 72..176
  const minLag = Math.max(2, Math.round(60 / 176 / hopSec));
  const maxLag = Math.min(env.length - 2, Math.round(60 / 72 / hopSec));
  let bestLag = minLag;
  let bestScore = -Infinity;
  const mean = env.reduce((s, v) => s + v, 0) / env.length;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    let n = 0;
    for (let i = lag; i < env.length; i++) {
      s += (env[i] - mean) * (env[i - lag] - mean);
      n++;
    }
    s /= Math.max(1, n);
    // 轻微偏好 90~140
    const bpm = 60 / (lag * hopSec);
    const prior = 1 - Math.min(0.25, Math.abs(Math.log2(bpm / 120)) * 0.35);
    const score = s * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // 抛物线插值
  const y0 = scoreAt(bestLag - 1);
  const y1 = bestScore / (priorAt(bestLag) || 1);
  const y2 = scoreAt(bestLag + 1);
  function priorAt(lag: number) {
    const bpm = 60 / (lag * hopSec);
    return 1 - Math.min(0.25, Math.abs(Math.log2(bpm / 120)) * 0.35);
  }
  function scoreAt(lag: number) {
    if (lag < 1 || lag >= env.length) return 0;
    let s = 0;
    let n = 0;
    for (let i = lag; i < env.length; i++) {
      s += (env[i] - mean) * (env[i - lag] - mean);
      n++;
    }
    return s / Math.max(1, n);
  }
  const denom = y0 + y2 - 2 * y1;
  const shift = Math.abs(denom) > 1e-9 ? Math.max(-1, Math.min(1, 0.5 * (y0 - y2) / denom)) : 0;
  return { lag: bestLag + shift, score: bestScore };
}

export interface AnalysisResult extends BeatMap {}

/**
 * 内置自编曲目的精确编曲网格：我们知道每一拍/和弦的真实位置，
 * 用它保证演示体验；用户导入文件仍走 analyzeBuffer，和弦页可随时“重新分析”。
 */
export function referenceBeatMap(opts: {
  bpm: number;
  beatsPerBar?: 3 | 4;
  bars: number;
  durationSec: number;
  chords: { pc: number; minor?: boolean }[];
  keyRoot: number;
  keyMode: 'major' | 'minor';
}): BeatMap {
  const bpb = opts.beatsPerBar ?? 4;
  const beatSec = 60 / opts.bpm;
  const beats: number[] = [];
  const totalBeats = opts.bars * bpb;
  for (let i = 0; i < totalBeats; i++) beats.push(i * beatSec);
  const downbeats: number[] = [];
  for (let b = 0; b < opts.bars; b++) downbeats.push(b * bpb * beatSec);
  const chords: ChordEvent[] = [];
  for (let bar = 0; bar < opts.bars; bar++) {
    const c = opts.chords[bar % opts.chords.length];
    const quality: ChordQuality = c.minor ? 'min' : 'maj';
    const rootMidi = 48 + c.pc;
    const startSec = bar * bpb * beatSec;
    chords.push({
      id: `ref-ch-${bar}`,
      startBeat: bar * bpb,
      beats: bpb,
      rootMidi,
      quality,
      label: chordLabel(rootMidi, quality),
      startSec,
      endSec: startSec + bpb * beatSec,
      confidence: 1,
    });
  }
  return {
    bpm: opts.bpm,
    offsetSec: 0,
    beatsPerBar: bpb,
    beatSec,
    durationSec: opts.durationSec,
    beats,
    downbeats,
    chords,
    keyRoot: opts.keyRoot,
    keyMode: opts.keyMode,
    bpmConfidence: 1,
  };
}


const CHROMA_N = 16384;
/** 在一个和弦片段内取若干高分辨率 Hann 窗，汇总音级能量（低频也有足够分辨率） */
function segmentChroma(channel: Float32Array, sr: number, i0: number, i1: number): number[] {
  const chroma = new Array(12).fill(0);
  const segLen = Math.max(1, i1 - i0);
  const wins = segLen > sr * 1.2 ? [0.3, 0.55, 0.8] : [0.5];
  const N = CHROMA_N;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  for (const frac of wins) {
    const center = Math.floor(i0 + segLen * frac);
    const start = center - (N >> 1);
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < channel.length ? channel[idx] : 0;
      re[i] = v * hann[i];
      im[i] = 0;
      energy += v * v;
    }
    if (energy / N < 1e-7) continue;
    fft(re, im);
    for (let b = 1; b < N / 2; b++) {
      const freq = (b * sr) / N;
      if (freq < 60 || freq > 2000) continue;
      const midiF = 69 + 12 * Math.log2(freq / 440 + 1e-12);
      if (midiF < 36 || midiF > 96) continue;
      const midi = Math.round(midiF);
      const pc = ((midi % 12) + 12) % 12;
      chroma[pc] += re[b] * re[b] + im[b] * im[b];
    }
  }
  return chroma;
}

export function analyzeChannel(channel: Float32Array, sampleRate: number, beatsPerBar: 3 | 4 = 4): BeatMap {
  const dur = channel.length / sampleRate;
  const hopSec = HOP / sampleRate;
  const frameCount = Math.floor((channel.length - FFT_N) / HOP);

  const window = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);

  const bass = new Float32Array(Math.max(1, frameCount));
  const high = new Float32Array(Math.max(1, frameCount));
  const broad = new Float32Array(Math.max(1, frameCount));

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP;
    let rms = 0;
    for (let i = 0; i < FFT_N; i++) {
      const v = channel[start + i] || 0;
      rms += v * v;
      re[i] = v * window[i];
      im[i] = 0;
    }
    rms = Math.sqrt(rms / FFT_N);
    fft(re, im);
    let bassE = 0;
    let highE = 0;
    for (let b = 1; b < FFT_N / 2; b++) {
      const freq = (b * sampleRate) / FFT_N;
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      if (freq < 160) bassE += mag * mag;
      if (freq > 5000 && freq < 14000) highE += mag * mag;
      broad[f] += mag;
    }
    bass[f] = Math.sqrt(bassE) + rms * 0.4;
    high[f] = Math.sqrt(highE);
  }

  // 正向差分通量作为起拍包络
  const flux = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    flux[f] = Math.max(0, bass[f] - bass[f - 1]) * 1.4 + Math.max(0, broad[f] - broad[f - 1]) * 0.02;
  }
  // 归一化
  let mx = 1e-6;
  for (let f = 0; f < frameCount; f++) mx = Math.max(mx, flux[f]);
  const env = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) env[f] = flux[f] / mx + bass[f] / (mx * 4);

  const { lag } = autocorrTempo(env, hopSec);
  const beatSec = lag * hopSec;
  const bpm = 60 / beatSec;

  // 相位搜索：哪一帧作为拍点时累计能量最大
  const lagInt = Math.max(2, Math.round(lag));
  let phase = 0;
  let phaseScore = -Infinity;
  for (let p = 0; p < lagInt; p++) {
    let s = 0;
    for (let f = p; f < frameCount; f += lagInt) s += env[f];
    if (s > phaseScore) {
      phaseScore = s;
      phase = p;
    }
  }

  // 生成拍点：用分数 lag 推进，避免整数帧间隔累积漂移；再在 ±2 帧内找起拍峰微调
  const beatFrames: number[] = [];
  const lagF = lag;
  for (let k = 0; ; k++) {
    const fFloat = phase + k * lagF;
    const f = Math.round(fFloat);
    if (f >= frameCount) break;
    let best = f;
    let bv = -Infinity;
    for (let d = -1; d <= 1; d++) {
      const j = f + d;
      if (j >= 0 && j < frameCount && flux[j] > bv) {
        bv = flux[j];
        best = j;
      }
    }
    beatFrames.push(best);
  }

  // 重拍相位：用高频（镲/击）+ 低频在“小节起点”的优势打分
  let downPhase = 0;
  let downScore = -Infinity;
  for (let s = 0; s < beatsPerBar; s++) {
    let score = 0;
    let cnt = 0;
    for (let i = s; i < beatFrames.length; i += beatsPerBar) {
      const bf = beatFrames[i];
      score += high[bf] * 2 + bass[bf];
      cnt++;
    }
    // 对比非小节拍平均
    let other = 0;
    let oc = 0;
    for (let i = (s + 1) % beatsPerBar; i < beatFrames.length; i += beatsPerBar) {
      other += high[beatFrames[i]] * 2 + bass[beatFrames[i]];
      oc++;
    }
    const ratio = score / Math.max(1, cnt) - other / Math.max(1, oc);
    if (ratio > downScore) {
      downScore = ratio;
      downPhase = s;
    }
  }

  // 把第 0 拍对齐到重拍
  const firstDownIndex = beatFrames.findIndex((_, i) => i % beatsPerBar === downPhase);
  const alignedFrames = firstDownIndex > 0 ? beatFrames.slice(firstDownIndex) : beatFrames;
  const beats = alignedFrames.map((f) => f * HOP / sampleRate);
  const downbeats: number[] = [];
  for (let i = 0; i < beats.length; i += beatsPerBar) downbeats.push(beats[i]);

  const offsetSec = beats[0] ?? 0;

  // 和弦：每个小节用高分辨率 FFT 单独算色度 → 模板匹配
  const chords: ChordEvent[] = [];
  const globalChroma = new Array(12).fill(0);
  const bars = Math.floor(beats.length / beatsPerBar);
  for (let bar = 0; bar < bars; bar++) {
    const b0 = bar * beatsPerBar;
    const t0 = beats[b0];
    const t1 = beats[Math.min(beats.length - 1, b0 + beatsPerBar)] ?? t0 + beatSec * beatsPerBar;
    const c = segmentChroma(channel, sampleRate, Math.floor(t0 * sampleRate), Math.floor(t1 * sampleRate));
    for (let pc = 0; pc < 12; pc++) globalChroma[pc] += c[pc];
    if (c.reduce((s, v) => s + v, 0) < 1e-6) continue;
    const m = matchChord(c);
    const rootMidi = 48 + m.root; // 固定在 C3~B3 区域
    const quality: ChordQuality = m.quality;
    chords.push({
      id: `ch-${bar}-${m.root}-${m.quality}`,
      startBeat: bar * beatsPerBar,
      beats: beatsPerBar,
      rootMidi,
      quality,
      label: chordLabel(rootMidi, quality),
      startSec: t0,
      endSec: t1,
      confidence: Math.max(0, Math.min(1, m.score)),
    });
  }

  const key = estimateKey(globalChroma);

  return {
    bpm: Math.round(bpm * 10) / 10,
    offsetSec,
    beatsPerBar,
    beatSec,
    durationSec: dur,
    beats,
    downbeats,
    chords,
    keyRoot: key.root,
    keyMode: key.mode,
    bpmConfidence: Math.max(0, Math.min(1, autocorrTempo(env, hopSec).score / (env.length * 0.02))),
  };
}

export async function analyzeBuffer(buffer: AudioBuffer, beatsPerBar: 3 | 4 = 4): Promise<BeatMap> {
  // 混合为单声道
  const ch0 = buffer.getChannelData(0);
  let mono = ch0;
  if (buffer.numberOfChannels > 1) {
    const len = buffer.length;
    mono = new Float32Array(len);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / buffer.numberOfChannels;
    }
  }
  // 离线计算放到微任务里，避免阻塞点击后的 UI 一帧
  await new Promise((r) => setTimeout(r, 30));
  return analyzeChannel(mono, buffer.sampleRate, beatsPerBar);
}
