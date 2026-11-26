// 自编自演：几种空竹哨声音色 + 几首伴奏曲目，全部用代码合成 AudioBuffer。
// 伴奏带有确定的 BPM/和弦（expected），但 App 仍会走真实 analyzeBuffer 分析。

import { midiToFreq } from './theory';

export interface DemoTrackDef {
  id: string;
  title: string;
  style: string;
  bpm: number;
  beatsPerBar: 4;
  bars: number;
  chords: { root: number; pc: number; minor?: boolean }[]; // pc 根音音级
  expectedChordLabels: string[];
  keyRoot: number;
  keyMode: 'major' | 'minor';
  buffer: AudioBuffer;
}

interface DemoTrackInput extends Omit<DemoTrackDef, 'buffer'> {
  seed: number;
  style: 'festive' | 'moon' | 'fast';
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================= 空竹哨声 ================= */

export interface WhistleOptions {
  id: string;
  name: string;
  desc: string;
  durationSec: number;
  baseMidi: number;
  /** 旋律滑音段 [起始拍, 结束拍, 起始midi, 结束midi] */
  glides: [number, number, number, number][];
  bpm?: number;
  harmonics?: number[];
  wind?: number;
  bright?: number;
  seed?: number;
  tosses?: [number, number][]; // 抛接空白区间（秒）
}

export function renderWhistle(ctx: BaseAudioContext, o: WhistleOptions): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(o.durationSec * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(o.seed ?? 7);
  const bpm = o.bpm ?? 108;
  const beat = 60 / bpm;
  const harms = o.harmonics ?? [1, 0.55, 0.3, 0.16, 0.08];
  const windAmt = o.wind ?? 0.08;
  const bright = o.bright ?? 1;

  // 由 glides 构造任意时刻 midi（段间保持）
  const midiAt = (t: number): number => {
    const b = t / beat;
    for (const [b0, b1, m0, m1] of o.glides) {
      if (b >= b0 && b <= b1) {
        const u = (b - b0) / Math.max(1e-6, b1 - b0);
        const e = u * u * (3 - 2 * u); // smoothstep
        return m0 + (m1 - m0) * e;
      }
    }
    // 找最近段端点
    let last = o.baseMidi;
    for (const [b0, b1, , m1] of o.glides) {
      if (b >= b1) last = m1;
    }
    return last;
  };

  // 抛接空白包络
  const tossEnv = (t: number): number => {
    if (!o.tosses) return 1;
    for (const [s, e] of o.tosses) {
      if (t >= s && t <= s + 0.18) return 1 - (t - s) / 0.18; // 快速收
      if (t > s + 0.18 && t < e - 0.12) return 0;
      if (t >= e - 0.12 && t <= e + 0.05) return Math.min(1, (t - (e - 0.12)) / 0.17); // 自然进
    }
    return 1;
  };

  let phase = 0;
  let lpWind = 0;
  let lpWind2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const m = midiAt(t);
    // 吹奏颤音 + 旋转呜唔
    const vib = 1 + 0.005 * Math.sin(2 * Math.PI * 5.6 * t);
    const f = midiToFreq(m) * vib;
    phase += (2 * Math.PI * f) / sr;
    let s = 0;
    for (let h = 1; h <= harms.length; h++) {
      s += harms[h - 1] * Math.sin(h * phase + (h > 1 ? 0.3 * h : 0));
    }
    s *= 0.2;
    // 旋转幅度调制（空竹特色“呜——唔”）
    const am = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4.4 * t + 1.2));
    s *= am;

    // 风噪 / 气流
    const w = rnd() * 2 - 1;
    lpWind += 0.06 * (w - lpWind);
    lpWind2 += 0.4 * (w - lpWind2);
    const windSig = (lpWind * 1.5 + lpWind2 * 0.22 + w * 0.1) * windAmt * (0.7 + 0.3 * am);

    const env = tossEnv(t);
    // 句头轻音头
    d[i] = (s + windSig * bright) * env;
  }
  // 整体淡入淡出防爆
  const fade = Math.floor(0.02 * sr);
  for (let i = 0; i < fade; i++) {
    d[i] *= i / fade;
    d[n - 1 - i] *= i / fade;
  }
  return buf;
}

export function buildWhistlePresets(ctx: BaseAudioContext): { id: string; name: string; desc: string; buffer: AudioBuffer }[] {
  return [
    {
      id: 'whistle-clear',
      name: '清亮高空哨',
      desc: '基音饱满、滑动利落，适合入门跟唱',
      buffer: renderWhistle(ctx, {
        id: 'whistle-clear', name: '清亮高空哨', desc: '', durationSec: 26, baseMidi: 76, bpm: 120,
        harmonics: [1, 0.5, 0.26, 0.12], wind: 0.05, seed: 11,
        glides: [
          [0, 2, 76, 76], [2, 4, 76, 79], [4, 6, 79, 81], [6, 8, 81, 79],
          [9, 11, 79, 84], [11, 13, 84, 83], [13, 16, 83, 76],
          [18, 20, 76, 74], [20, 22, 74, 79], [22, 26, 79, 76],
        ],
        tosses: [[7.6, 9.2], [15.6, 17.6]],
      }),
    },
    {
      id: 'whistle-deep',
      name: '浑厚双轮嗡',
      desc: '中低频丰富、呜唔起伏大',
      buffer: renderWhistle(ctx, {
        id: 'whistle-deep', name: '浑厚双轮嗡', desc: '', durationSec: 28, baseMidi: 64, bpm: 96,
        harmonics: [1, 0.8, 0.55, 0.34, 0.2, 0.1], wind: 0.09, bright: 0.8, seed: 23,
        glides: [
          [0, 3, 64, 64], [3, 6, 64, 67], [6, 9, 67, 65], [9, 12, 65, 62],
          [13, 16, 62, 64], [16, 19, 64, 69], [19, 23, 69, 67], [23, 28, 67, 64],
        ],
        tosses: [[12.2, 13.4]],
      }),
    },
    {
      id: 'whistle-slide',
      name: '花哨急转滑音',
      desc: '大跨度连续滑音，考验拉音保留度',
      buffer: renderWhistle(ctx, {
        id: 'whistle-slide', name: '花哨急转滑音', desc: '', durationSec: 24, baseMidi: 72, bpm: 132,
        harmonics: [1, 0.62, 0.34, 0.2, 0.12, 0.06], wind: 0.07, seed: 37,
        glides: [
          [0, 1.5, 72, 84], [1.5, 3, 84, 67], [3, 4.5, 67, 79], [4.5, 6, 79, 72],
          [7, 9, 72, 86], [9, 11, 86, 70], [11, 13, 70, 76],
          [14, 16, 76, 88], [16, 18, 88, 74], [18, 24, 74, 72],
        ],
        tosses: [[6.2, 7.0], [13.2, 14.0]],
      }),
    },
    {
      id: 'whistle-windy',
      name: '大风天现场',
      desc: '强气流风噪，检验抗风噪跟踪',
      buffer: renderWhistle(ctx, {
        id: 'whistle-windy', name: '大风天现场', desc: '', durationSec: 26, baseMidi: 74, bpm: 112,
        harmonics: [1, 0.45, 0.22, 0.1], wind: 0.22, bright: 1.2, seed: 51,
        glides: [
          [0, 3, 74, 76], [3, 6, 76, 72], [6, 9, 72, 79], [9, 12, 79, 74],
          [13, 16, 74, 81], [16, 19, 81, 77], [19, 23, 77, 74], [23, 26, 74, 74],
        ],
        tosses: [[12.2, 13.0]],
      }),
    },
  ];
}

/* ================= 伴奏乐曲 ================= */

interface SeqCtx {
  sr: number;
  L: Float32Array;
  R: Float32Array;
  bpm: number;
  beat: number;
  rnd: () => number;
}

function addTone(s: SeqCtx, tSec: number, durSec: number, freq: number, amp: number, type: 'sine' | 'tri' | 'saw' = 'tri', detune = 0) {
  const i0 = Math.floor(tSec * s.sr);
  const n = Math.floor(durSec * s.sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / s.sr;
    ph += (2 * Math.PI * freq * (1 + detune)) / s.sr;
    let v: number;
    if (type === 'sine') v = Math.sin(ph);
    else if (type === 'tri') v = (2 / Math.PI) * Math.asin(Math.sin(ph));
    else {
      // 轻锯齿（6 谐波限制，减少混叠）
      v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(h * ph) / h;
      v *= 0.6;
    }
    const env = Math.min(1, i / (0.012 * s.sr)) * Math.exp(-3.2 * (i / n));
    const smp = v * amp * env;
    const idx = i0 + i;
    if (idx >= 0 && idx < s.L.length) {
      s.L[idx] += smp;
      s.R[idx] += smp;
    }
  }
}

function addKick(s: SeqCtx, tSec: number, amp = 0.9) {
  const i0 = Math.floor(tSec * s.sr);
  const n = Math.floor(0.22 * s.sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f = 130 * Math.exp(-28 * u) + 46;
    ph += (2 * Math.PI * f) / s.sr;
    const env = Math.exp(-9 * u);
    const smp = Math.sin(ph) * amp * env;
    if (i0 + i < s.L.length) { s.L[i0 + i] += smp; s.R[i0 + i] += smp; }
  }
}

function addNoiseHit(s: SeqCtx, tSec: number, dur: number, amp: number, hp: number, lp: number, pan = 0) {
  const i0 = Math.floor(tSec * s.sr);
  const n = Math.floor(dur * s.sr);
  let lpH = 0, lpL = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const w = s.rnd() * 2 - 1;
    lpH += 0.9 * (w - lpH); // 粗高通
    const hpSig = w - lpH * hp;
    lpL += lp * (hpSig - lpL);
    const env = Math.exp(-14 * u);
    const smp = lpL * amp * env;
    const idx = i0 + i;
    if (idx < s.L.length) {
      s.L[idx] += smp * (1 - pan * 0.5);
      s.R[idx] += smp * (1 + pan * 0.5);
    }
  }
}

function addCrash(s: SeqCtx, tSec: number, amp = 0.5) {
  addNoiseHit(s, tSec, 0.9, amp, 1, 0.55, 0.2);
}
function addHat(s: SeqCtx, tSec: number, open = false, amp = 0.22) {
  addNoiseHit(s, tSec, open ? 0.22 : 0.05, amp, 1, 0.85, 0.35);
}
function addSnare(s: SeqCtx, tSec: number) {
  addNoiseHit(s, tSec, 0.18, 0.5, 1, 0.5, -0.15);
  addTone(s, tSec, 0.12, 190, 0.25, 'tri');
}

function renderTrackBuffer(
  ctx: BaseAudioContext,
  def: DemoTrackInput,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const beat = 60 / def.bpm;
  const totalSec = def.bars * def.beatsPerBar * beat + 1.2;
  const len = Math.floor(totalSec * sr);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const s: SeqCtx = { sr, L, R, bpm: def.bpm, beat, rnd: mulberry32(def.seed) };

  const barLen = def.beatsPerBar * beat;
  for (let bar = 0; bar < def.bars; bar++) {
    const ch = def.chords[bar % def.chords.length];
    const rootMidi = 36 + ch.pc; // 低音区根音
    const chordMidis = [rootMidi + 12, rootMidi + 12 + (ch.minor ? 3 : 4), rootMidi + 19];
    const tBar = bar * barLen;
    const section = Math.floor(bar / def.chords.length);

    // 和弦垫/织体
    if (def.style === 'moon') {
      chordMidis.forEach((m) => addTone(s, tBar, barLen * 1.05, midiToFreq(m + 12), 0.12, 'sine'));
      addTone(s, tBar, barLen * 0.9, midiToFreq(rootMidi + 12), 0.1, 'tri');
    } else if (def.style === 'festive') {
      // 反拍短促和弦
      for (let b = 0; b < 4; b++) {
        if (b % 2 === 1) chordMidis.forEach((m) => addTone(s, tBar + b * beat, beat * 0.4, midiToFreq(m + 12), 0.16, 'tri'));
      }
    } else {
      for (let b = 0; b < 4; b += 0.5) {
        chordMidis.forEach((m) => addTone(s, tBar + b * beat, beat * 0.28, midiToFreq(m + 12), 0.12, 'saw'));
      }
    }

    // 贝斯
    const bassPat = def.style === 'fast' ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
      : def.style === 'festive' ? [0, 1, 2, 2.5, 3]
      : [0, 2];
    for (const b of bassPat) {
      addTone(s, tBar + b * beat, beat * (def.style === 'moon' ? 1.6 : 0.42), midiToFreq(rootMidi), 0.34, 'sine');
    }

    // 鼓
    if (def.style === 'festive') {
      for (let b = 0; b < 4; b++) addKick(s, tBar + b * beat, 0.85);
      addSnare(s, tBar + beat);
      addSnare(s, tBar + 3 * beat);
      for (let b = 0; b < 8; b++) addHat(s, tBar + (b * beat) / 2, false, b % 2 ? 0.12 : 0.2);
      addCrash(s, tBar, bar % 4 === 0 ? 0.5 : 0.18);
    } else if (def.style === 'fast') {
      for (let b = 0; b < 4; b++) { addKick(s, tBar + b * beat, 0.95); if (b === 2) addKick(s, tBar + (b + 0.5) * beat, 0.7); }
      addSnare(s, tBar + beat);
      addSnare(s, tBar + 3 * beat);
      for (let b = 0; b < 16; b++) addHat(s, tBar + (b * beat) / 4, false, b % 4 === 2 ? 0.2 : 0.12);
      addCrash(s, tBar, bar % 4 === 0 ? 0.55 : 0.15);
    } else {
      addKick(s, tBar, 0.7);
      addKick(s, tBar + 2 * beat, 0.55);
      for (let b = 0; b < 8; b++) addHat(s, tBar + (b * beat) / 2, false, 0.12);
      addNoiseHit(s, tBar + beat, 0.12, 0.22, 1, 0.7);
      addNoiseHit(s, tBar + 3 * beat, 0.12, 0.22, 1, 0.7);
      if (bar % 4 === 0) addCrash(s, tBar, 0.3);
    }

    // 五声音阶小旋律（节日/快板），用确定性随机
    if (def.style !== 'moon' || bar % 2 === 1) {
      const pent = ch.minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
      const hits = def.style === 'fast' ? 8 : 4;
      for (let k = 0; k < hits; k++) {
        if (s.rnd() < (section === 0 && bar < 2 ? 0.2 : 0.55)) continue;
        const b = (k * 4) / hits;
        const pc = pent[Math.floor(s.rnd() * pent.length)];
        const m = rootMidi + 24 + pc + 12;
        addTone(s, tBar + b * beat, beat * 0.5, midiToFreq(m), 0.14, 'tri');
      }
    }
  }

  // 总线：软削波 + 淡入淡出
  let peak = 0;
  for (let i = 0; i < len; i++) {
    L[i] = Math.tanh(L[i] * 0.85) * 0.8;
    R[i] = Math.tanh(R[i] * 0.85) * 0.8;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const norm = 0.9 / Math.max(0.2, peak);
  const fadeN = Math.floor(0.05 * sr);
  for (let i = 0; i < len; i++) {
    const f = Math.min(1, i / fadeN, (len - 1 - i) / fadeN);
    L[i] *= norm * f;
    R[i] *= norm * f;
  }
  return buf;
}

export function buildDemoTracks(ctx: BaseAudioContext): DemoTrackDef[] {
  const defs: DemoTrackInput[] = [
    {
      id: 'track-temple', title: '庙会欢歌', style: 'festive', bpm: 124, beatsPerBar: 4, bars: 24, seed: 101,
      keyRoot: 0, keyMode: 'major',
      chords: [{ root: 0, pc: 0 }, { root: 7, pc: 7 }, { root: 9, pc: 9, minor: true }, { root: 5, pc: 5 }],
      expectedChordLabels: ['C', 'G', 'Am', 'F'],
    },
    {
      id: 'track-moon', title: '月下抖嗡', style: 'moon', bpm: 92, beatsPerBar: 4, bars: 20, seed: 202,
      keyRoot: 9, keyMode: 'minor',
      chords: [{ root: 9, pc: 9, minor: true }, { root: 5, pc: 5 }, { root: 0, pc: 0 }, { root: 7, pc: 7 }],
      expectedChordLabels: ['Am', 'F', 'C', 'G'],
    },
    {
      id: 'track-fast', title: '炫技快板', style: 'fast', bpm: 142, beatsPerBar: 4, bars: 24, seed: 303,
      keyRoot: 2, keyMode: 'major',
      chords: [{ root: 2, pc: 2 }, { root: 9, pc: 9 }, { root: 11, pc: 11, minor: true }, { root: 7, pc: 7 }],
      expectedChordLabels: ['D', 'A', 'Bm', 'G'],
    },
  ];
  return defs.map((d) => ({
    ...d,
    buffer: renderTrackBuffer(ctx, d),
  }));
}
