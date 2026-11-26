/*
 * 空竹和鸣 · 实时音高 / 拉音 / 和声 AudioWorklet
 * ------------------------------------------------------------------
 * 三件事都在音频线程完成：
 *   1) 抗风噪音高跟踪：高通 + YIN 差分 + FFT 谐波证据裁决八度 +
 *      速度预测连续性 + 5 点中值，杜绝风噪里的八度乱跳
 *   2) 向当前和弦音按“力度”在音分域线性拉音（一半力度保留滑音轮廓）
 *   3) 三个声部：主声部(拉音) + 三度和声 + 五度和声
 *
 * 变调采用“音高周期对齐的双读头交叉淡化”延迟线（类实时 PSOLA）：
 * 两个读头相距整数个基音周期、跳转跨度也是整数周期，对近周期哨声
 * 相位对齐，从根上减少镶边/金属声。断声时冻结最后两个周期做循环
 * 衰减，抛起空竹也有自然收尾。
 *
 * 该文件刻意使用纯 JS（AudioWorklet 加载独立 worklet 脚本），
 * 其余界面 / 效果链 / 录制 / 分析全部是 TypeScript。
 */

/* global registerProcessor, AudioWorkletProcessor, sampleRate, currentFrame */

const SR = (typeof sampleRate === 'number' && sampleRate) || 48000;

// 音高搜索范围：低沉“嗡”到尖锐哨音
const F_MIN = 150;
const F_MAX = 2600;
const TAU_MIN = Math.max(2, Math.floor(SR / F_MAX));
const TAU_MAX = Math.min(512, Math.ceil(SR / F_MIN) + 2);

const ANALYSIS_N = 1024; // YIN/FFT 帧长（2 的幂）
const YIN_HALF = ANALYSIS_N >> 1;
const HOP = 256; // 约 5.3ms 检测一次

const RING_BITS = 14;
const RING_SIZE = 1 << RING_BITS;
const RING_MASK = RING_SIZE - 1;

const HANG_SAMPLES = Math.floor(0.12 * SR);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}
function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

/* ---------------- 音高同步双读头变调声部 ---------------- */

class ShiftVoice {
  constructor() {
    this.d = 200 + Math.random() * 400;
    this.shiftCents = 0;
    this.primed = false;
    // 断声循环收尾
    this.loop = false;
    this.loopStart = 0;
    this.loopLen = 0;
    this.phase = 0;
    this.loopMix = 0;
  }

  reset() {
    this.primed = false;
    this.shiftCents = 0;
    this.loop = false;
    this.loopMix = 0;
  }

  startRelease(anchorW, period) {
    if (this.loop) return;
    const pInt = Math.max(16, Math.round(period));
    this.loopLen = pInt * 2;
    this.xf = pInt; // 交叉淡化恰好一个周期，两段相位对齐
    // 从“最后良好位置”往前取 2 个完整周期
    this.loopStart = anchorW - this.loopLen - 32;
    this.phase = 0;
    this.loop = true;
    this.loopMix = 0.35; // 快速淡入，避免停顿也避免跳变
  }

  cancelRelease() {
    this.loop = false; // loopMix 平滑回 0，扫描头一直没停
  }

  render(ring, w, ratio, period, gate, out, i) {
    const targetCents = 1200 * Math.log2(Math.max(0.25, Math.min(4, ratio)));
    if (!this.primed) {
      this.shiftCents = targetCents;
      this.primed = true;
    } else {
      this.shiftCents += (targetCents - this.shiftCents) * this.alpha;
    }
    const r = Math.pow(2, this.shiftCents / 1200);

    // ---- 常规双读头扫描 ----
    this.d += 1 - r;
    const sep = clamp(Math.round(2 * period), 32, 760);
    const L = sep * 2;
    const D0 = 56;

    let span = this.d - D0;
    span = ((span % L) + L) % L;
    this.d = D0 + span;
    const x = span / L;
    const g1 = 1 - 2 * Math.abs(x - 0.5);
    let span2 = span + L * 0.5;
    if (span2 >= L) span2 -= L;
    const x2 = span2 / L;
    const g2 = 1 - 2 * Math.abs(x2 - 0.5);

    const base = w - 1;
    const ys = g1 * readCubic(ring, RING_MASK, base - (D0 + span))
             + g2 * readCubic(ring, RING_MASK, base - (D0 + span2));

    // ---- 断声循环颗粒 ----
    let yl = ys;
    if (this.loop) {
      this.phase += r;
      if (this.phase >= this.loopLen) this.phase %= this.loopLen;
      const xf = this.xf || Math.min(40, this.loopLen >> 1);
      const ph = this.phase;
      if (ph < xf) {
        const k = ph / xf;
        const head = readCubic(ring, RING_MASK, this.loopStart + ph);
        const tail = readCubic(ring, RING_MASK, this.loopStart + this.loopLen - xf + ph);
        yl = head * k + tail * (1 - k);
      } else {
        yl = readCubic(ring, RING_MASK, this.loopStart + ph);
      }
    }
    const mixTarget = this.loop ? 1 : 0;
    this.loopMix += (mixTarget - this.loopMix) * (1 - Math.exp(-1 / (SR * 0.018)));
    const y = ys * (1 - this.loopMix) + yl * this.loopMix;

    out[i] = y * gate;
  }
}

function readCubic(R, mask, pos) {
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const xm1 = R[(i0 - 1) & mask];
  const x0 = R[i0 & mask];
  const x1 = R[(i0 + 1) & mask];
  const x2 = R[(i0 + 2) & mask];
  const a0 = -0.5 * xm1 + 1.5 * x0 - 1.5 * x1 + 0.5 * x2;
  const a1 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const a2 = -0.5 * xm1 + 0.5 * x1;
  return ((a0 * frac + a1) * frac + a2) * frac + x0;
}

/* ---------------- 处理器 ---------------- */

class DiaboloProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'strength', defaultValue: 1.0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'retuneSec', defaultValue: 0.05, minValue: 0.01, maxValue: 0.7, automationRate: 'k-rate' },
      { name: 'gateDb', defaultValue: -52, minValue: -80, maxValue: -24, automationRate: 'k-rate' },
      { name: 'windSuppression', defaultValue: 0.65, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.sr = SR;

    this.ring = new Float32Array(RING_SIZE);
    this.w = 0;
    this.dcX1 = 0;
    this.dcY1 = 0;

    this.hpX1 = 0;
    this.hpY1 = 0;
    this.hpA = 1 / (1 + 2 * Math.PI * 170 / this.sr);
    this.hpRing = new Float32Array(ANALYSIS_N);
    this.hpW = 0;

    this.diff = new Float32Array(TAU_MAX + 2);
    this.cmnd = new Float32Array(TAU_MAX + 2);
    this.frame = new Float32Array(ANALYSIS_N);

    this.fftRe = new Float32Array(ANALYSIS_N);
    this.fftIm = new Float32Array(ANALYSIS_N);
    this.hann = new Float32Array(ANALYSIS_N);
    for (let i = 0; i < ANALYSIS_N; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (ANALYSIS_N - 1));
    }

    this.midiSmooth = 0;
    this.midiVel = 0;
    this.haveTrack = false;
    this.median = [];
    this.rawCount = 0;
    this.lowConfCount = 0;

    this.periodSmooth = this.sr / 660;
    this.confidence = 0;
    this.rms = 0;
    this.blockRms = 0.01;
    this.noiseFloor = 0.004;

    this.voiced = false;
    this.hangover = 0;
    this.lossCount = 0;
    this.releasing = false;
    this.gate = 0;
    this.lastGoodW = 0;
    this.lastGoodPeriod = this.sr / 660;

    this.chordMidis = [60, 64, 67];
    this.scalePC = [0, 2, 4, 5, 7, 9, 11];
    this.harmonyMode = 'diatonic';
    this.targetMidi = 60;
    this.h3Midi = 64;
    this.h5Midi = 67;
    this.haveTarget = false;
    this.chordDirty = true;

    /** @type {{absFrame:number, midis:number[], scalePC?:number[], mode?:string}[]} */
    this.events = [];

    this.voiceLead = new ShiftVoice();
    this.voice3 = new ShiftVoice();
    this.voice5 = new ShiftVoice();
    this.lastLeadRatio = 1;
    this.lastR3 = 1;
    this.lastR5 = 1;

    this.sinceDetect = 0;
    this.sinceMsg = 0;
    this.blockCount = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'chordNow') {
      this.setChord(msg.midis, msg.scalePC, msg.mode);
    } else if (msg.type === 'schedule') {
      // 采样级定时换和弦：events:[{t(AudioContext 秒), midis, scalePC, mode}]
      this.events = (msg.events || [])
        .map((ev) => ({
          absFrame: Math.round((ev.t || 0) * this.sr),
          midis: ev.midis,
          scalePC: ev.scalePC,
          mode: ev.mode,
        }))
        .sort((a, b) => a.absFrame - b.absFrame);
    } else if (msg.type === 'clearSchedule') {
      this.events.length = 0;
    } else if (msg.type === 'reset') {
      this.haveTrack = false;
      this.haveTarget = false;
      this.median.length = 0;
      this.gate = 0;
      this.voiced = false;
      this.releasing = false;
      this.events.length = 0;
      this.voiceLead.reset();
      this.voice3.reset();
      this.voice5.reset();
    }
  }

  setChord(midis, scalePC, mode) {
    if (Array.isArray(midis) && midis.length) this.chordMidis = midis.slice();
    if (Array.isArray(scalePC) && scalePC.length === 7) this.scalePC = scalePC.slice();
    if (mode === 'diatonic' || mode === 'chord') this.harmonyMode = mode;
    this.chooseTargets();
    // 若跟踪还没建立，等第一个稳定音高后按真实音区重选最近和弦音
    this.chordDirty = !this.haveTrack;
  }

  chooseTargets() {
    const ref = this.haveTrack ? this.midiSmooth : this.targetMidi || 69;
    let best = this.chordMidis[0];
    let bestD = Infinity;
    for (const m of this.chordMidis) {
      const d = Math.abs(m - ref);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    this.targetMidi = best;
    this.haveTarget = true;

    const T = best;
    const pc = ((Math.round(T) % 12) + 12) % 12;
    const deg = Math.max(0, this.scalePC.indexOf(pc));
    const pc3 = this.scalePC[(deg + 2) % 7];
    const pc5 = this.scalePC[(deg + 4) % 7];
    this.h3Midi = nearestAbovePC(T, pc3);
    this.h5Midi = nearestAbovePC(T, pc5);

    if (this.harmonyMode === 'chord') {
      this.h3Midi = nearestInList(this.chordMidis, T + 3.5);
      this.h5Midi = nearestInList(this.chordMidis, T + 7);
    }
  }

  process(inputs, outputs, parameters) {
    this.blockCount++;
    const input = inputs && inputs[0] && inputs[0][0];
    const outL = outputs[0] && outputs[0][0];
    const out3 = outputs[1] && outputs[1][0];
    const out5 = outputs[2] && outputs[2][0];
    if (!outL) return true;
    const n = outL.length;

    const strength = parameters.strength ? parameters.strength[0] : 1;
    const retuneSec = parameters.retuneSec ? parameters.retuneSec[0] : 0.05;
    const gateDb = parameters.gateDb ? parameters.gateDb[0] : -52;
    const wind = parameters.windSuppression ? parameters.windSuppression[0] : 0.65;
    const alpha = 1 - Math.exp(-1 / (this.sr * Math.max(0.012, retuneSec)));
    this.voiceLead.alpha = alpha;
    this.voice3.alpha = alpha;
    this.voice5.alpha = alpha;

    const gateLin = Math.pow(10, gateDb / 20);
    const effGate = Math.max(gateLin, this.noiseFloor * (1.5 + wind * 1.0));
    const signalOk = this.blockRms >= effGate;
    const pitchOk = this.confidence >= 0.42;
    const instantOk = signalOk && pitchOk && this.haveTrack;

    const blockStartFrame = typeof currentFrame === 'number' ? currentFrame : this.blockCount * n;

    let rmsAcc = 0;

    for (let i = 0; i < n; i++) {
      const f = blockStartFrame + i;
      while (this.events.length && this.events[0].absFrame <= f) {
        const ev = this.events.shift();
        this.setChord(ev.midis, ev.scalePC, ev.mode);
        this.port.postMessage({ type: 'chordApplied', t: ev.absFrame / this.sr });
      }

      const raw = input ? input[i] || 0 : 0;

      const dc = raw - this.dcX1 + 0.9975 * this.dcY1;
      this.dcX1 = raw;
      this.dcY1 = dc;
      this.ring[this.w & RING_MASK] = dc;
      this.w++;
      rmsAcc += dc * dc;

      const hp = this.hpA * (this.hpY1 + dc - this.hpX1);
      this.hpX1 = dc;
      this.hpY1 = hp;
      this.hpRing[this.hpW] = hp;
      this.hpW = (this.hpW + 1) % ANALYSIS_N;

      this.sinceDetect++;
      if (this.sinceDetect >= HOP) {
        this.sinceDetect = 0;
        this.runDetection();
      }

      // ---- 有声 / 断声收尾状态机 ----
      if (instantOk) {
        this.lossCount = 0;
        this.voiced = true;
        this.hangover = HANG_SAMPLES;
        if (this.releasing) {
          this.releasing = false;
          this.voiceLead.cancelRelease();
          this.voice3.cancelRelease();
          this.voice5.cancelRelease();
        }
      } else {
        this.lossCount++;
        // 丢失约 2 个块即从“最后良好样本”冻结周期做自然衰减
        if (this.voiced && !this.releasing && this.lossCount > 190) {
          this.releasing = true;
          const w0 = this.lastGoodW || this.w;
          const p = this.lastGoodPeriod || this.periodSmooth;
          this.voiceLead.startRelease(w0, p);
          this.voice3.startRelease(w0, p);
          this.voice5.startRelease(w0, p);
        }
        this.hangover--;
        if (this.hangover <= 0) this.voiced = false;
      }

      let gateTarget;
      if (this.releasing) gateTarget = 0;
      else if (this.voiced) gateTarget = 1;
      else gateTarget = 0;
      const gA = gateTarget === 1
        ? 1 - Math.exp(-1 / (this.sr * 0.022))
        : 1 - Math.exp(-1 / (this.sr * 0.085));
      this.gate += (gateTarget - this.gate) * gA;
      if (gateTarget === 0 && this.gate < 0.0006) this.gate = 0;

      // 没目标时按当前音选一次；和弦先于跟踪到达时在这里按真实音区重选
      if (this.chordDirty && this.haveTrack) { this.chooseTargets(); this.chordDirty = false; }
      if (!this.haveTarget && this.haveTrack) this.chooseTargets();

      // ---- 三个声部目标变调比 ----
      let leadRatio = 1;
      let r3 = 1;
      let r5 = 1;
      if (this.haveTrack && this.haveTarget) {
        const m = this.midiSmooth;
        leadRatio = Math.pow(2, (strength * (this.targetMidi - m)) / 12);
        r3 = Math.pow(2, (this.h3Midi - m) / 12);
        r5 = Math.pow(2, (this.h5Midi - m) / 12);
        this.lastLeadRatio = leadRatio;
        this.lastR3 = r3;
        this.lastR5 = r5;
      } else {
        // 丢跟踪后的收尾里保持最后音高，避免尾巴下坠
        leadRatio = this.lastLeadRatio;
        r3 = this.lastR3;
        r5 = this.lastR5;
      }

      const period = this.periodSmooth;
      this.voiceLead.render(this.ring, this.w, leadRatio, period, this.gate, outL, i);
      if (out3) this.voice3.render(this.ring, this.w, r3, period, this.gate, out3, i);
      if (out5) this.voice5.render(this.ring, this.w, r5, period, this.gate, out5, i);
    }

    this.blockRms = Math.sqrt(rmsAcc / n);
    this.rms = this.rms * 0.8 + this.blockRms * 0.2;
    // 只在低置信度（确实是风噪/气声而非哨音）时学习噪声底；
    // 向下快速跟踪、向上缓慢，避免起唱时把哨声学进门限。
    if (this.confidence < 0.35) {
      const target = Math.max(this.blockRms, 1e-4);
      const a = target < this.noiseFloor ? 0.25 : 0.008;
      this.noiseFloor += (target - this.noiseFloor) * a;
      this.noiseFloor = clamp(this.noiseFloor, 0.0002, 0.05);
    }
    // 记录最后一个“真正有哨声”的块尾位置，供断声循环收尾取样本
    if (this.blockRms >= effGate && this.confidence >= 0.5 && this.haveTrack) {
      this.lastGoodW = this.w;
      this.lastGoodPeriod = this.periodSmooth;
    }

    this.sinceMsg++;
    if (this.sinceMsg >= 3) {
      this.sinceMsg = 0;
      this.port.postMessage({
        type: 'pitch',
        t: (blockStartFrame + n) / this.sr,
        midi: this.haveTrack ? this.midiSmooth : null,
        freq: this.haveTrack ? midiToFreq(this.midiSmooth) : null,
        confidence: this.confidence,
        rms: this.rms,
        gate: this.gate,
        voiced: this.voiced,
        target: this.haveTarget ? this.targetMidi : null,
        h3: this.h3Midi,
        h5: this.h5Midi,
      });
    }
    return true;
  }

  /* ---------------- YIN + FFT 谐波裁决 + 抗八度 ---------------- */

  runDetection() {
    if (this.w < ANALYSIS_N) return; // 先填满帧，杜绝启动误锁

    const N = ANALYSIS_N;
    const start = this.hpW;
    const x = this.hpRing;
    const fr = this.frame;
    for (let i = 0; i < N; i++) fr[i] = x[(start + i) % N];

    let sumSq = 0;
    for (let i = 0; i < N; i++) sumSq += fr[i] * fr[i];
    if (sumSq / N < 1e-7) {
      this.confidence *= 0.6;
      return;
    }

    // YIN 差分 + 累积均值归一化
    let running = 0;
    this.cmnd[0] = 1;
    let bestTau = -1;
    let bestVal = Infinity;
    for (let tau = 1; tau <= TAU_MAX; tau++) {
      let d = 0;
      for (let j = 0; j < YIN_HALF; j++) {
        const dd = fr[j] - fr[j + tau];
        d += dd * dd;
      }
      this.diff[tau] = d;
      running += d;
      this.cmnd[tau] = running > 0 ? (d * tau) / running : 1;
      if (tau >= TAU_MIN && this.cmnd[tau] < bestVal) {
        bestVal = this.cmnd[tau];
        bestTau = tau;
      }
    }

    // 第一个低于阈值的局部谷（YIN 首选最短周期）
    const thr = 0.16;
    let tauEst = -1;
    for (let tau = TAU_MIN + 1; tau < TAU_MAX; tau++) {
      if (this.cmnd[tau] < thr && this.cmnd[tau] <= this.cmnd[tau - 1] && this.cmnd[tau] <= this.cmnd[tau + 1]) {
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) tauEst = bestTau;
    if (tauEst < TAU_MIN || tauEst > TAU_MAX - 1) return;

    // 候选集合：首选 + 八度族 + 显著局部谷
    const tauCands = [];
    const addTau = (tau) => {
      if (tau < TAU_MIN || tau > TAU_MAX - 1) return;
      const r = parabolicTau(this.cmnd, tau);
      const ri = Math.round(r);
      for (const ex of tauCands) if (Math.abs(ex.tauInt - ri) <= 2) return;
      tauCands.push({ tau: r, tauInt: ri, q: clamp(this.cmnd[ri], 0, 1) });
    };
    addTau(tauEst);
    addTau(tauEst * 2);
    addTau(Math.round(tauEst / 2));
    for (let tau = TAU_MIN + 2; tau < TAU_MAX - 2; tau++) {
      if (
        this.cmnd[tau] < 0.32 &&
        this.cmnd[tau] <= this.cmnd[tau - 1] &&
        this.cmnd[tau] < this.cmnd[tau + 1] &&
        this.cmnd[tau] < this.cmnd[tau - 2] &&
        this.cmnd[tau] < this.cmnd[tau + 2]
      ) {
        addTau(tau);
      }
    }
    if (!tauCands.length) return;

    // FFT 幅度谱（加 Hann）
    const re = this.fftRe;
    const im = this.fftIm;
    for (let i = 0; i < N; i++) {
      re[i] = fr[i] * this.hann[i];
      im[i] = 0;
    }
    fft(re, im);

    const magAt = (freq) => {
      const bin = (freq * N) / this.sr;
      if (bin < 1 || bin > N / 2 - 2) return 0;
      const i0 = bin | 0;
      const frac = bin - i0;
      const m0 = Math.sqrt(re[i0] * re[i0] + im[i0] * im[i0]);
      const m1 = Math.sqrt(re[i0 + 1] * re[i0 + 1] + im[i0 + 1] * im[i0 + 1]);
      return m0 + (m1 - m0) * frac;
    };

    // 谐波堆叠分：裁决 1/2 倍周期歧义
    const HW = [1, 0.85, 0.7, 0.55, 0.42, 0.32, 0.24, 0.18];
    let maxHarm = 1e-9;
    for (const c of tauCands) {
      const f = this.sr / c.tau;
      let hs = 0;
      let ws = 0;
      for (let h = 1; h <= 8; h++) {
        const ff = f * h;
        if (ff > this.sr / 2.3) break;
        hs += HW[h - 1] * magAt(ff);
        ws += HW[h - 1];
      }
      c.harm = hs / ws;
      if (c.harm > maxHarm) maxHarm = c.harm;
      c.midi = freqToMidi(f);
    }
    for (const c of tauCands) c.relHarm = c.harm / maxHarm;

    // 选择：跟踪后以连续性为主（±3 半音内有可靠候选就不出圈），
    // 捕获时让谐波证据和 YIN 质量共同决定八度。
    let chosen = null;
    if (this.haveTrack) {
      const pred = this.midiSmooth + this.midiVel;
      const near = tauCands.filter((c) => Math.abs(c.midi - pred) < 3.2);
      const goodNear = near.filter((c) => c.q < 0.24);
      const pool = goodNear.length ? goodNear : tauCands;
      let bestScore = Infinity;
      for (const c of pool) {
        const dist = Math.abs(c.midi - pred);
        const cont = 0.5 * (1 - Math.exp(-dist / 5)); // 有界，最多 0.5
        const score = c.q * 1.2 + (1 - c.relHarm) * 0.3 + (pool === tauCands ? cont : 0);
        if (score < bestScore) {
          bestScore = score;
          chosen = c;
        }
      }
    } else {
      let bestScore = Infinity;
      for (const c of tauCands) {
        const score = c.q * 1.1 + (1 - c.relHarm) * 0.6;
        if (score < bestScore) {
          bestScore = score;
          chosen = c;
        }
      }
    }
    if (!chosen) return;

    this.lastBest = { tau: chosen.tau, midi: chosen.midi, clarity: 1 - chosen.q };
    this.confidence += (1 - chosen.q - this.confidence) * 0.5;

    this.median.push(chosen.midi);
    if (this.median.length > 5) this.median.shift();
    this.rawCount++;
    const med = median(this.median);

    if (!this.haveTrack) {
      if (this.median.length >= 3) {
        const a = this.median[this.median.length - 3];
        const b = this.median[this.median.length - 1];
        if (Math.abs(a - b) < 1.4) {
          this.haveTrack = true;
          this.midiSmooth = med;
          this.midiVel = 0;
        }
      }
    } else {
      const newVel = clamp(med - this.midiSmooth, -2.5, 2.5);
      this.midiVel += (newVel - this.midiVel) * 0.35;
      const fast = Math.abs(newVel);
      const a = fast > 0.5 ? 0.6 : 0.42;
      this.midiSmooth += (med - this.midiSmooth) * a;
      if (this.confidence < 0.12) this.lowConfCount++;
      else this.lowConfCount = 0;
      if (this.lowConfCount > 48) {
        this.haveTrack = false;
        this.median.length = 0;
        this.lowConfCount = 0;
      }
    }

    if (this.haveTrack) {
      const targetPeriod = this.sr / midiToFreq(this.midiSmooth);
      this.periodSmooth += (targetPeriod - this.periodSmooth) * 0.35;
    }
  }
}

/* 基 2 迭代 FFT（原地） */
function fft(re, im) {
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

function parabolicTau(cmnd, tau) {
  if (tau <= 1 || tau >= TAU_MAX - 1) return tau;
  const x0 = cmnd[tau - 1];
  const x1 = cmnd[tau];
  const x2 = cmnd[tau + 1];
  const denom = x0 + x2 - 2 * x1;
  if (Math.abs(denom) < 1e-12) return tau;
  const shift = (0.5 * (x0 - x2)) / denom;
  return tau + clamp(shift, -1, 1);
}

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) * 0.5;
}

function nearestAbovePC(midiBelow, pc) {
  const base = Math.ceil(midiBelow);
  for (let k = 0; k <= 12; k++) {
    const m = base + k;
    if (((m % 12) + 12) % 12 === pc) return m;
  }
  return base + 7;
}

function nearestInList(list, targetMidi) {
  let best = list[0];
  let bd = Infinity;
  for (const m of list) {
    const d = Math.abs(m - targetMidi);
    if (d < bd) {
      bd = d;
      best = m;
    }
    for (const oct of [12, -12]) {
      const mm = m + oct;
      const dd = Math.abs(mm - targetMidi);
      if (dd < bd) {
        bd = dd;
        best = mm;
      }
    }
  }
  return best;
}

try {
  registerProcessor('diabolo-processor', DiaboloProcessor);
} catch {
  // 在 Node 测试沙箱外被误加载时忽略
}
