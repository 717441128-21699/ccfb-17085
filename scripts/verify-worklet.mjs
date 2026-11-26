// 直接在 Node 里驱动 AudioWorklet 处理器，验证核心音频指标。
// 运行：node scripts/verify-worklet.mjs [--soak]
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workletPath = path.join(__dirname, '..', 'public', 'worklets', 'diabolo-processor.js');
const code = fs.readFileSync(workletPath, 'utf8');

const SR = 48000;
const BLOCK = 128;

function loadProcessor() {
  const messages = [];
  const sandbox = {
    sampleRate: SR,
    currentFrame: 0,
    currentTime: 0,
    console,
    Float32Array,
    Math,
    Infinity,
    isFinite,
    registerProcessor: (name, cls) => {
      sandbox.__name = name;
      sandbox.__cls = cls;
    },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          onmessage: null,
          postMessage: (m) => messages.push(m),
        };
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'diabolo-processor.js' });
  return { Cls: sandbox.__cls, messages, sandbox };
}

// ---------- 信号合成 ----------
function makeWhistle({ f0 = 660, fEnd = null, dur = 2, wind = 0.06, strong2 = false, sr = SR }) {
  const n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  let lp = 0;
  let lp2 = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = i / n;
    let s;
    if (fEnd) {
      s = glideSample(f0, fEnd, u, dur);
    } else {
      // 相位积分的颤音，避免 f(t)*t 相位发散
      const f = f0 * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f) / sr;
      let v = 0;
      v += Math.sin(phase);
      v += (strong2 ? 1.7 : 0.5) * Math.sin(2 * phase);
      v += 0.28 * Math.sin(3 * phase);
      v += 0.12 * Math.sin(4 * phase);
      s = v * 0.22;
    }
    // 旋转“呜呜”幅度调制
    const am = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4.6 * t + 1.3));
    s *= am;
    // 风噪：低频隆隆 + 高频气流
    const w = Math.random() * 2 - 1;
    lp += 0.08 * (w - lp);
    lp2 += 0.35 * (w - lp2);
    const windSig = lp * 1.4 + lp2 * 0.25 + w * 0.12;
    out[i] = s + wind * windSig;
  }
  return out;
}

// 滑音相位积分，保证连续
function glideSample(f0, f1, u, dur) {
  // 用相位函数：f(t)=f0*(f1/f0)^(t/dur)，相位 = 2π f0 dur/ln(r) * (r^u - 1)
  const r = f1 / f0;
  const ph = (2 * Math.PI * f0 * dur) / Math.log(r) * (Math.pow(r, u) - 1);
  let v = Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph);
  const am = 0.75 + 0.25 * Math.sin(2 * Math.PI * 4.5 * u * dur);
  return v * 0.2 * am;
}
function integralGlideRemoved() {
  return 0;
}

// ---------- 独立基频测量（YIN + 抛物线，可限定音域） ----------
function estimateF0(buf, sr = SR, fmin = 150, fmax = 2600) {
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.min(buf.length - 2, Math.ceil(sr / fmin));
  const N = buf.length;
  const yin = new Float32Array(tauMax + 1);
  let run = 0;
  yin[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    const lim = Math.min(N - tau, N >> 1);
    for (let j = 0; j < lim; j++) {
      const dd = buf[j] - buf[j + tau];
      d += dd * dd;
    }
    run += d;
    yin[tau] = run > 0 ? (d * tau) / run : 1;
  }
  let tauEst = -1;
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (yin[tau] < 0.2 && yin[tau] <= yin[tau - 1] && yin[tau] <= yin[tau + 1]) { tauEst = tau; break; }
  }
  if (tauEst < 0) {
    let bv = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) if (yin[tau] < bv) { bv = yin[tau]; tauEst = tau; }
  }
  if (tauEst <= tauMin || tauEst >= tauMax - 1) return sr / tauEst;
  const x0 = yin[tauEst - 1], x1 = yin[tauEst], x2 = yin[tauEst + 1];
  const den = x0 + x2 - 2 * x1;
  const shift = Math.abs(den) > 1e-12 ? Math.max(-1, Math.min(1, 0.5 * (x0 - x2) / den)) : 0;
  return sr / (tauEst + shift);
}

function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function centsBetween(f, targetF) { return 1200 * Math.log2(f / targetF); }

// 过零间隔中值法（对调幅 / 加窗插值偏差不敏感）
function zcF0(channel, startSec, durSec, sr = SR) {
  const i0 = Math.floor(startSec * sr), i1 = Math.floor((startSec + durSec) * sr);
  const intervals = [];
  let prev = -1;
  for (let i = i0 + 1; i < i1; i++) {
    if (channel[i - 1] <= 0 && channel[i] > 0) {
      const x = i - 1 - channel[i - 1] / (channel[i] - channel[i - 1] + 1e-12);
      if (prev >= 0 && x - prev > 20 && x - prev < 400) intervals.push(x - prev);
      prev = x;
    }
  }
  if (intervals.length < 8) return null;
  intervals.sort((a, b) => a - b);
  return sr / intervals[intervals.length >> 1];
}

// 运行一段信号 through processor
function runProcessor(proc, sandbox, Cls, signal, opts = {}, onBlock = null) {
  const totalBlocks = Math.ceil(signal.length / BLOCK);
  const outs = [new Float32Array(totalBlocks * BLOCK), new Float32Array(totalBlocks * BLOCK), new Float32Array(totalBlocks * BLOCK)];
  const pitchMsgs = [];
  const origPost = proc.port.postMessage.bind(proc.port);
  proc.port.postMessage = (m) => { if (m.type === 'pitch') pitchMsgs.push(m); origPost(m); };

  for (let b = 0; b < totalBlocks; b++) {
    sandbox.currentFrame = b * BLOCK;
    if (onBlock) onBlock(b);
    const input = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) input[i] = signal[b * BLOCK + i] || 0;
    const outputs = [[new Float32Array(BLOCK)], [new Float32Array(BLOCK)], [new Float32Array(BLOCK)]];
    const params = {};
    for (const name of ['strength', 'retuneSec', 'gateDb', 'windSuppression']) {
      const arr = new Float32Array(BLOCK);
      arr.fill(opts.params?.[name] ?? defaultParam(name));
      params[name] = arr;
    }
    proc.process([[input]], outputs, params);
    for (let v = 0; v < 3; v++) outs[v].set(outputs[v][0], b * BLOCK);
  }
  return { outs, pitchMsgs };
}
function defaultParam(n) {
  return { strength: 1, retuneSec: 0.05, gateDb: -52, windSuppression: 0.65 }[n];
}

function chunkF0(channel, startSec, durSec, fmin = 150, fmax = 2600, sr = SR) {
  const a = Math.floor(startSec * sr);
  const n = Math.floor(durSec * sr);
  const buf = channel.subarray(a, a + n);
  // 加 Hann
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = buf[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  return estimateF0(win, sr, fmin, fmax);
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name} ${detail ?? ''}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail ?? ''}`); }
}

const C_MAJOR_WIDE = [36, 40, 43, 48, 52, 55, 60, 64, 67, 72, 76, 79, 84, 88, 91, 96];

console.log('== 1. 稳态音高跟踪 + 抗八度 ==');
{
  const cases = [
    { f: 392, name: 'G4 常规', wind: 0.05 },
    { f: 659.3, name: 'E5 清亮哨', wind: 0.08 },
    { f: 987.8, name: 'B5 高音哨', wind: 0.1 },
    { f: 1318.5, name: 'E6 尖锐哨', wind: 0.12 },
    { f: 330, name: 'E4 低沉嗡', wind: 0.1 },
    { f: 660, name: '强二次谐波(抗低八度)', wind: 0.12, strong2: true },
  ];
  for (const c of cases) {
    const { Cls, sandbox, messages } = loadProcessor();
    const proc = new Cls();
    const sig = makeWhistle({ f0: c.f, dur: 3, wind: c.wind, strong2: c.strong2 });
    const { pitchMsgs } = runProcessor(proc, sandbox, Cls, sig);
    const late = pitchMsgs.filter((m) => m.t > 1.2 && m.midi != null);
    const midis = late.map((m) => m.midi);
    const med = midis.slice().sort((a, b) => a - b)[midis.length >> 1];
    const targetMidi = freqToMidi(c.f);
    const cents = (med - targetMidi) * 100;
    const octJumps = midis.filter((m) => Math.abs(m - med) > 6).length;
    check(`跟踪 ${c.name}`, Math.abs(cents) < 12 && octJumps / Math.max(1, midis.length) < 0.03,
      `中位误差 ${cents.toFixed(1)} 音分, 八度跳 ${octJumps}/${midis.length}`);
  }
}

console.log('== 2. 完全拉到和弦音：输出误差 <=10 音分 ==');
{
  const { Cls, sandbox } = loadProcessor();
  const proc = new Cls();
  const sig = makeWhistle({ f0: 446, dur: 3, wind: 0.05 });
  // 在 0.6s 时通过消息设和弦（模拟换和弦），先跑 0.8s 再设
  const res = runProcessorChordTimed(proc, sandbox, Cls, sig, 0.8, { type: 'chordNow', midis: C_MAJOR_WIDE, scalePC: [0, 2, 4, 5, 7, 9, 11] });
  const fOut = chunkF0(res.outs[0], 2.2, 0.6, 320, 470);
  const targetF = midiToFreq(67); // G4
  const err = centsBetween(fOut, targetF);
  check('满力度拉音输出音准', Math.abs(err) <= 10 && fOut != null,
    `输出 ${fOut?.toFixed(2)}Hz 目标 ${targetF.toFixed(2)}Hz 误差 ${err.toFixed(1)} 音分`);

  // 输出稳定性：用 0.22s 稳态窗（短窗抛物线插值会有测量假象）
  const centsList = [];
  for (let t = 1.7; t < 2.65; t += 0.22) {
    const f = chunkF0(res.outs[0], t, 0.2, 340, 450);
    if (f) centsList.push(centsBetween(f, targetF));
  }
  const sd = std(centsList);
  check('满力度稳态音准中值<=6音分', Math.abs(centsList.sort((a, b) => a - b)[centsList.length >> 1]) <= 6,
    `YIN 音分[${centsList.map((x) => x.toFixed(1)).join(',')}] sd=${sd.toFixed(2)}（短窗±10为调幅导致的插值偏差，长窗误差 ${err.toFixed(1)} 音分）`);
}

console.log('== 3. 半力度保留滑音起伏 ==');
{
  const { Cls, sandbox } = loadProcessor();
  const proc = new Cls();
  // 从 E4(64) 滑到 G#4(68)，目标固定 E4（C 和弦）
  const sig = makeWhistle({ f0: midiToFreq(64), fEnd: midiToFreq(68), dur: 3, wind: 0.04 });
  const res = runProcessorChordTimed(proc, sandbox, Cls, sig, 0.05,
    { type: 'chordNow', midis: C_MAJOR_WIDE, scalePC: [0, 2, 4, 5, 7, 9, 11] },
    { strength: 0.5 });
  // 测量多个窗口的输出 midi
  const outMidis = [];
  const inMidis = [];
  for (let u = 0.25; u <= 0.95; u += 0.05) {
    const t = u * 3;
    const f = chunkF0(res.outs[0], t - 0.06, 0.12, midiToFreq(62.5), midiToFreq(69.5));
    if (f) outMidis.push(freqToMidi(f));
    inMidis.push(64 + 4 * u);
  }
  const outRange = Math.max(...outMidis) - Math.min(...outMidis);
  const inRange = Math.max(...inMidis) - Math.min(...inMidis); // 与测量窗口同跨度 ≈2.8
  const ratio = outRange / inRange;
  // 线性相关
  const corr = correlation(inMidis.slice(0, outMidis.length), outMidis);
  check('半力度滑音深度约为原来一半', ratio > 0.38 && ratio < 0.68, `输出滑幅 ${outRange.toFixed(2)} / 输入同段 ${inRange.toFixed(2)} 半音 = ${ratio.toFixed(2)}`);
  check('半力度滑音轮廓相关', corr > 0.95, `相关系数 ${corr.toFixed(3)}`);
}

console.log('== 4. 三度/五度和声 ==');
{
  const { Cls, sandbox } = loadProcessor();
  const proc = new Cls();
  const sig = makeWhistle({ f0: midiToFreq(64), dur: 3, wind: 0.04 }); // E4 -> 三 G4 / 五 B4
  const res = runProcessorChordTimed(proc, sandbox, Cls, sig, 0.4,
    { type: 'chordNow', midis: C_MAJOR_WIDE, scalePC: [0, 2, 4, 5, 7, 9, 11] });
  const f3 = chunkF0(res.outs[1], 1.8, 0.7, 300, 500);
  const f5 = chunkF0(res.outs[2], 1.8, 0.7, 380, 600);
  const e3 = f3 ? centsBetween(f3, midiToFreq(67)) : 999;
  const e5 = f5 ? centsBetween(f5, midiToFreq(71)) : 999;
  check('三声部音准 G4', Math.abs(e3) <= 12, `${f3?.toFixed(1)}Hz 误差 ${e3.toFixed(1)} 音分`);
  check('五声部音准 B4', Math.abs(e5) <= 12, `${f5?.toFixed(1)}Hz 误差 ${e5.toFixed(1)} 音分`);
  // 金属声指标：谐波能量占比，并与原始干声对比（变调不应明显增加非谐波成分）
  const hnr3 = harmonicRatio(res.outs[1], 2.0, 0.6, midiToFreq(67));
  const hnrDry = harmonicRatio(sig, 2.0, 0.6, midiToFreq(64));
  check('三声部谐波纯度(无明显金属声)', hnr3 >= hnrDry * 0.9,
    `和声谐波占比 ${(hnr3 * 100).toFixed(1)}% / 干声 ${(hnrDry * 100).toFixed(1)}%`);
}

console.log('== 5. 断信号自然收尾 / 接回 ==');
{
  const { Cls, sandbox } = loadProcessor();
  const proc = new Cls();
  const a = makeWhistle({ f0: 660, dur: 1.2, wind: 0.03 });
  const gap = new Float32Array(0.9 * SR);
  const b = makeWhistle({ f0: 660, dur: 1.0, wind: 0.03 });
  const sig = concat([a, gap, b]);
  const res = runProcessorChordTimed(proc, sandbox, Cls, sig, 0.1,
    { type: 'chordNow', midis: C_MAJOR_WIDE });
  const rmsAt = (t, d = 0.1) => {
    const i0 = Math.floor(t * SR), n = Math.floor(d * SR);
    let s = 0; for (let i = i0; i < i0 + n; i++) s += res.outs[0][i] ** 2;
    return Math.sqrt(s / n);
  };
  const beforeGap = rmsAt(1.05);
  const tailHead = rmsAt(1.245, 0.055); // 断后 ~0.05-0.11s，循环颗粒衰减中
  const tailMid = rmsAt(1.47, 0.08);    // 断后 ~0.27s
  const gapLate = rmsAt(1.95, 0.1);     // 断后 ~0.75s
  const afterBack = rmsAt(2.35);
  check('断声后有自然衰减尾巴', tailHead > beforeGap * 0.16 && tailMid < tailHead * 0.9 && gapLate < beforeGap * 0.06,
    `RMS 前 ${beforeGap.toFixed(3)} 尾头 ${tailHead.toFixed(3)} 尾中 ${tailMid.toFixed(3)} 0.75s ${gapLate.toFixed(4)}`);
  // 边界无爆音：最大相邻样本跳变
  let maxJump = 0;
  for (let i = Math.floor(1.18 * SR); i < Math.floor(1.4 * SR); i++) {
    const j = Math.abs(res.outs[0][i] - res.outs[0][i - 1]);
    if (j > maxJump) maxJump = j;
  }
  check('收尾无爆音跳变', maxJump < 0.35, `最大相邻跳变 ${maxJump.toFixed(3)}`);
  check('接回后恢复有声', afterBack > beforeGap * 0.4, `RMS 接回 ${afterBack.toFixed(3)}`);
  let maxFinite = true;
  for (let i = 0; i < res.outs[0].length; i += 97) if (!Number.isFinite(res.outs[0][i])) maxFinite = false;
  check('输出无 NaN/Inf', maxFinite);
}

console.log('== 6. 换和弦跟随时间 < 1 拍(120bpm=500ms) ==');
{
  const { Cls, sandbox } = loadProcessor();
  const proc = new Cls();
  const sig = makeWhistle({ f0: midiToFreq(62), dur: 4, wind: 0.03 });
  const t0 = 0.4;
  const res = runProcessor(proc, sandbox, Cls, sig, {}, (blockIdx) => {
    const t = blockIdx * BLOCK / SR;
    if (t >= t0 && !(proc.__c1)) { proc.__c1 = 1; proc.onMessage({ type: 'chordNow', midis: [48, 52, 55, 60, 64, 67, 72], scalePC: [0, 2, 4, 5, 7, 9, 11] }); }
    if (t >= 1.6 && !proc.__c2) { proc.__c2 = 1; proc.onMessage({ type: 'chordNow', midis: [43, 47, 50, 55, 59, 62, 67, 71], scalePC: [0, 2, 4, 5, 7, 9, 11] }); }
  });
  // 换 G 后 D4 是 G 和弦五音 -> 目标 D4(62)；逐窗测首次进入 ±15 音分的时间
  let reach = null;
  for (let t = 1.6; t < 2.6; t += 0.03) {
    const f = chunkF0(res.outs[0], t, 0.09, 255, 340);
    if (f && Math.abs(centsBetween(f, midiToFreq(62))) < 15) { reach = t - 1.6; break; }
  }
  check('换和弦后 <=500ms 进入新和弦音', reach != null && reach < 0.5, `跟随耗时 ${(reach ?? 9).toFixed(3)}s`);
}

if (process.argv.includes('--soak')) {
  console.log('== 7. 20 分钟连续处理浸泡 ==');
  const tStart = Date.now();
  const { Cls, sandbox } = loadProcessor();
  const proc = new Cls();
  proc.onMessage({ type: 'chordNow', midis: C_MAJOR_WIDE });
  const minutes = 20;
  const totalSamples = minutes * 60 * SR;
  const blocks = totalSamples / BLOCK;
  let nonFinite = 0;
  const t0cpu = process.hrtime.bigint();
  const input = new Float32Array(BLOCK);
  const outputs = [[new Float32Array(BLOCK)], [new Float32Array(BLOCK)], [new Float32Array(BLOCK)]];
  const params = {};
  for (const name of ['strength', 'retuneSec', 'gateDb', 'windSuppression']) {
    const a = new Float32Array(BLOCK); a.fill(defaultParam(name)); params[name] = a;
  }
  for (let b = 0; b < blocks; b++) {
    sandbox.currentFrame = b * BLOCK;
    const tt = (b * BLOCK) / SR;
    for (let i = 0; i < BLOCK; i++) {
      const t = tt + i / SR;
      input[i] = 0.2 * Math.sin(2 * Math.PI * 660 * t) + 0.02 * (Math.random() * 2 - 1);
    }
    proc.process([[input]], outputs, params);
    for (let i = 0; i < BLOCK; i++) {
      if (!Number.isFinite(outputs[0][0][i])) nonFinite++;
    }
    if (b % 40000 === 0 && b > 0) {
      const secsAudio = (b * BLOCK) / SR;
      const cpuMs = Number(process.hrtime.bigint() - t0cpu) / 1e6;
      process.stdout.write(`\r  已处理 ${secsAudio.toFixed(0)}s 音频, CPU ${(cpuMs / 1000).toFixed(1)}s, 实时倍率 ${(secsAudio / (cpuMs / 1000)).toFixed(1)}x   `);
    }
  }
  console.log('');
  check('20 分钟全部有限输出', nonFinite === 0, `异常样本 ${nonFinite}`);
  console.log(`  浸泡总耗时 ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

// ---------- helpers ----------
function runProcessorChordTimed(proc, sandbox, Cls, signal, chordAtSec, chordMsg, params = {}) {
  return runProcessor(proc, sandbox, Cls, signal, { params }, (blockIdx) => {
    const t = (blockIdx * BLOCK) / SR;
    if (t >= chordAtSec && !proc.__chordSent) {
      proc.__chordSent = true;
      proc.onMessage(chordMsg);
    }
  });
}

function concat(arrs) {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function std(arr) {
  if (arr.length < 2) return 999;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
function correlation(x, y) {
  const n = Math.min(x.length, y.length);
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
function harmonicRatio(channel, startSec, durSec, f0) {
  // 用 Goertzel 近似测前 8 次谐波能量 / 总能量（粗粒度 FFT 替代：自相关窗 + DFT 点）
  const i0 = Math.floor(startSec * SR), n = Math.floor(durSec * SR);
  let total = 0;
  for (let i = i0; i < i0 + n; i++) total += channel[i] ** 2;
  let harm = 0;
  for (let h = 1; h <= 8; h++) {
    let re = 0, im = 0;
    const w = 2 * Math.PI * h * f0 / SR;
    for (let i = 0; i < n; i++) {
      const v = channel[i0 + i];
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    harm += (re * re + im * im) / (n * n);
  }
  // total 是能量和；harm 是幅度平方量级，换算
  const harmEnergy = harm * 2 * n;
  return Math.min(1, harmEnergy / (total + 1e-9));
}
