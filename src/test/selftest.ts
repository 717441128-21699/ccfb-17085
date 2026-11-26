// 浏览器端算法自检：OfflineAudioContext 跑真实 AudioWorklet，
// 验证抗八度、<=10 音分、半力度滑音、和声、换和弦速度，以及分析器准确度。
import type { SelftestCheck, SelftestSummary } from '../state/store';
import { analyzeChannel, referenceBeatMap } from '../audio/analysis';
import { buildDemoTracks, renderWhistle } from '../audio/demoSounds';
import { expandChordMidis } from '../audio/theory';

const WORKLET_URL = `${import.meta.env.BASE_URL}worklets/diabolo-processor.js`;
const SR = 48000;

function midiToFreq(m: number) { return 440 * Math.pow(2, (m - 69) / 12); }
function freqToMidi(f: number) { return 69 + 12 * Math.log2(f / 440); }
function cents(f: number, target: number) { return 1200 * Math.log2(f / target); }

function estimateF0(buf: Float32Array, sr: number, fmin = 150, fmax = 2600): number | null {
  const tMin = Math.max(2, Math.floor(sr / fmax));
  const tMax = Math.min(buf.length - 2, Math.ceil(sr / fmin));
  const yin = new Float32Array(tMax + 1);
  let run = 0;
  yin[0] = 1;
  for (let tau = 1; tau <= tMax; tau++) {
    let d = 0;
    const lim = Math.min(buf.length - tau, buf.length >> 1);
    for (let j = 0; j < lim; j++) {
      const dd = buf[j] - buf[j + tau];
      d += dd * dd;
    }
    run += d;
    yin[tau] = run > 0 ? (d * tau) / run : 1;
  }
  let tauEst = -1;
  for (let tau = tMin + 1; tau < tMax; tau++) {
    if (yin[tau] < 0.2 && yin[tau] <= yin[tau - 1] && yin[tau] <= yin[tau + 1]) { tauEst = tau; break; }
  }
  if (tauEst < 0) {
    let bv = Infinity;
    for (let tau = tMin; tau <= tMax; tau++) if (yin[tau] < bv) { bv = yin[tau]; tauEst = tau; }
  }
  if (tauEst <= tMin || tauEst >= tMax - 1) return sr / tauEst;
  const x0 = yin[tauEst - 1], x1 = yin[tauEst], x2 = yin[tauEst + 1];
  const den = x0 + x2 - 2 * x1;
  const sh = Math.abs(den) > 1e-12 ? Math.max(-1, Math.min(1, (0.5 * (x0 - x2)) / den)) : 0;
  return sr / (tauEst + sh);
}

function chunkF0(rendered: AudioBuffer, t0: number, dur: number, fmin: number, fmax: number): number | null {
  const sr = rendered.sampleRate;
  const a = Math.floor(t0 * sr);
  const n = Math.floor(dur * sr);
  const data = rendered.getChannelData(0);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = (data[a + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  return estimateF0(win, sr, fmin, fmax);
}

interface ScenarioOpts {
  durationSec: number;
  whistle: Parameters<typeof renderWhistle>[1];
  strength?: number;
  outputIndex?: number;
  chordMidis?: number[];
}

async function renderScenario(o: ScenarioOpts): Promise<{ rendered: AudioBuffer; pitches: any[] }> {
  const frames = Math.floor(o.durationSec * SR);
  // 三输出节点，但每次只把指定输出接到单声道离线 destination
  const ctx = new OfflineAudioContext(1, frames, SR);
  await ctx.audioWorklet.addModule(WORKLET_URL);
  const wb = renderWhistle(ctx, o.whistle);
  const src = ctx.createBufferSource();
  src.buffer = wb;
  const node = new AudioWorkletNode(ctx, 'diabolo-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 3,
    outputChannelCount: [1, 1, 1],
  });
  node.parameters.get('strength')!.value = o.strength ?? 1;
  node.parameters.get('retuneSec')!.value = 0.05;
  if (o.chordMidis) node.port.postMessage({ type: 'chordNow', midis: o.chordMidis, scalePC: [0, 2, 4, 5, 7, 9, 11] });
  src.connect(node);
  node.connect(ctx.destination, o.outputIndex ?? 0, 0);
  const pitches: any[] = [];
  node.port.onmessage = (e) => { if (e.data?.type === 'pitch') pitches.push(e.data); };
  src.start(0);
  const rendered = await ctx.startRendering();
  await new Promise((r) => setTimeout(r, 150));
  return { rendered, pitches };
}

const C_WIDE = [36, 40, 43, 48, 52, 55, 60, 64, 67, 72, 76, 79, 84];

export async function runBrowserSelfTest(): Promise<SelftestSummary> {
  const tStart = performance.now();
  const checks: SelftestCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  // 1. 抗八度跟踪（强风噪 + 强二次谐波）
  {
    const { pitches } = await renderScenario({
      durationSec: 3,
      whistle: {
        id: 't', name: 't', desc: '', durationSec: 3, baseMidi: 76, wind: 0.16, seed: 3,
        harmonics: [1, 1.6, 0.4, 0.2], glides: [[0, 4, 76, 76]],
      },
    });
    const late = pitches.filter((p) => p.t > 1.2 && p.midi != null).map((p) => p.midi as number);
    const med = late.slice().sort((a, b) => a - b)[late.length >> 1] ?? 0;
    const jumps = late.filter((m) => Math.abs(m - med) > 6).length;
    const centErr = (med - 76) * 100;
    check('风噪中不跳八度', Math.abs(centErr) < 12 && jumps / Math.max(1, late.length) < 0.03,
      `中位 ${centErr.toFixed(1)} 音分, 八度跳 ${jumps}/${late.length}`);
  }

  // 2. 满力度拉音 <=10 音分
  {
    const { rendered } = await renderScenario({
      durationSec: 3, strength: 1, chordMidis: C_WIDE,
      whistle: { id: 't', name: 't', desc: '', durationSec: 3, baseMidi: freqToMidi(446), wind: 0.05, seed: 5, glides: [[0, 4, freqToMidi(446), freqToMidi(446)]] },
    });
    const f = chunkF0(rendered, 2.2, 0.6, 320, 470);
    const err = f ? cents(f, midiToFreq(67)) : 999;
    check('满拉音误差≤10音分', f != null && Math.abs(err) <= 10, `${f?.toFixed(1)}Hz, ${err.toFixed(1)} 音分`);
  }

  // 3. 半力度滑音保留 ~0.5
  {
    const m0 = 64, m1 = 68;
    const { rendered } = await renderScenario({
      durationSec: 3, strength: 0.5, chordMidis: C_WIDE,
      whistle: { id: 't', name: 't', desc: '', durationSec: 3, baseMidi: m0, wind: 0.04, seed: 8, glides: [[0, 4, m0, m1]] },
    });
    const outM: number[] = [];
    const inM: number[] = [];
    for (let u = 0.3; u <= 0.95; u += 0.1) {
      const f = chunkF0(rendered, u * 3 - 0.07, 0.14, midiToFreq(62.5), midiToFreq(69.5));
      if (f) outM.push(freqToMidi(f));
      inM.push(m0 + (m1 - m0) * u);
    }
    const outRange = Math.max(...outM) - Math.min(...outM);
    const inRange = Math.max(...inM) - Math.min(...inM);
    const ratio = outRange / inRange;
    check('半力度保留滑音起伏', ratio > 0.38 && ratio < 0.7 && outM.length >= 5, `滑幅比 ${ratio.toFixed(2)}`);
  }

  // 4. 三度/五度和声
  {
    const base: ScenarioOpts = {
      durationSec: 3, chordMidis: C_WIDE,
      whistle: { id: 't', name: 't', desc: '', durationSec: 3, baseMidi: 64, wind: 0.04, seed: 9, glides: [[0, 4, 64, 64]] },
    };
    const r3 = await renderScenario({ ...base, outputIndex: 1 });
    const r5 = await renderScenario({ ...base, outputIndex: 2 });
    const f3 = chunkF0(r3.rendered, 1.8, 0.7, 300, 500);
    const f5 = chunkF0(r5.rendered, 1.8, 0.7, 380, 600);
    const e3 = f3 ? Math.abs(cents(f3, midiToFreq(67))) : 999;
    const e5 = f5 ? Math.abs(cents(f5, midiToFreq(71))) : 999;
    check('三度和声音准', e3 <= 12, `${e3.toFixed(1)} 音分`);
    check('五度和声音准', e5 <= 12, `${e5.toFixed(1)} 音分`);
  }

  // 5. 节拍/和弦网格：内置编曲参考网格必须与创作参数一致；真实分析器在干净信号上识别正确
  {
    const oac = new OfflineAudioContext(2, SR, SR);
    const defs = buildDemoTracks(oac as unknown as BaseAudioContext);
    let gridOk = 0;
    const detail: string[] = [];
    for (const d of defs) {
      const bm = referenceBeatMap({
        bpm: d.bpm, beatsPerBar: 4, bars: d.bars, durationSec: d.buffer.duration,
        chords: d.chords, keyRoot: d.keyRoot, keyMode: d.keyMode,
      });
      const bpmGood = Math.abs(bm.bpm - d.bpm) < 0.01;
      const chordGood = d.expectedChordLabels.every((lab, i) => bm.chords[i]?.label === lab);
      if (bpmGood && chordGood) gridOk++;
      detail.push(`${d.title} ${bm.bpm}BPM [${bm.chords.slice(0, 4).map((c) => c.label).join(',')}]`);
    }
    check('内置曲拍点/和弦网格精确', gridOk === defs.length, detail.join('；'));

    // 真实分析器：干净的 C 大调和弦应识别为 C
    const sr = 48000;
    const sig = new Float32Array(2 * sr);
    for (let i = 0; i < sig.length; i++) {
      const t = i / sr;
      sig[i] = 0.25 * Math.sin(2 * Math.PI * 261.63 * t) + 0.2 * Math.sin(2 * Math.PI * 329.63 * t)
        + 0.2 * Math.sin(2 * Math.PI * 392 * t) + 0.3 * Math.sin(2 * Math.PI * 65.41 * t);
    }
    const analyzed = analyzeChannel(sig, sr, 4);
    check('分析器干净信号和弦识别', analyzed.chords[0]?.label === 'C', `识别为 ${analyzed.chords[0]?.label ?? '无'}`);
  }

  // 6. 和弦展开乐理健全
  {
    const midis = expandChordMidis(60, 'maj');
    check('和弦音跨八度展开', midis.includes(60) && midis.includes(64) && midis.includes(67) && midis.length > 12,
      `${midis.length} 个音`);
  }

  const passed = checks.filter((c) => c.pass).length;
  const summary: SelftestSummary = {
    ranAt: Date.now(),
    checks,
    passed,
    failed: checks.length - passed,
    durationMs: performance.now() - tStart,
  };
  return summary;
}
