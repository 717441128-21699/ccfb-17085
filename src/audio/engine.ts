// 音频引擎：AudioContext 图、AudioWorklet 挂载、效果链、拍点调度、录制。
// 单例 engine，UI 直接调用。

import type { BeatFxMode, FxSettings, PitchSnapshot, Take, Track, TransportState } from '../types';
import { expandChordMidis, scalePitchClasses } from './theory';

const WORKLET_URL = `${import.meta.env.BASE_URL}worklets/diabolo-processor.js`;

type Listener = () => void;

const DEFAULT_SETTINGS: FxSettings = {
  source: 'mic',
  micReady: false,
  strength: 1,
  retuneMs: 50,
  gateDb: -52,
  wind: 0.65,
  h3: 0.8,
  h5: 0.72,
  harmonyMode: 'diatonic',
  beatFx: 'both',
  fxAmount: 0.5,
  echoBeats: 0.75,
  whistleGain: 0.95,
  accompGain: 0.9,
  master: 0.95,
  monitoring: true,
};

class AudioEngine {
  ctx: AudioContext | null = null;
  worklet: AudioWorkletNode | null = null;
  settings: FxSettings = { ...DEFAULT_SETTINGS };
  pitch: PitchSnapshot = {
    midi: null, freq: null, confidence: 0, rms: 0, gate: 0, voiced: false, target: null, h3: 64, h5: 67,
  };

  track: Track | null = null;
  playing = false;
  takes: Take[] = [];

  private inputBus!: GainNode;
  private windHp!: BiquadFilterNode;
  private leadGain!: GainNode;
  private g3!: GainNode;
  private g5!: GainNode;
  private vibDelay!: DelayNode;
  private vibLfo!: OscillatorNode;
  private vibDepth!: GainNode;
  private whistleBus!: GainNode;
  private echoSend!: GainNode;
  private echoDelay!: DelayNode;
  private echoFb!: GainNode;
  private echoLp!: BiquadFilterNode;
  private echoReturn!: GainNode;
  private acctGain!: GainNode;
  private comp!: DynamicsCompressorNode;
  private masterGain!: GainNode;
  private monitorGain!: GainNode;
  private recDest!: MediaStreamAudioDestinationNode;
  private analyser!: AnalyserNode;

  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private demoNode: AudioBufferSourceNode | null = null;
  private demoPresetId: string | null = null;

  private srcNode: AudioBufferSourceNode | null = null;
  private startCtxTime = 0;
  private startOffset = 0;
  private pausedOffset = 0;

  private schedTimer: number | null = null;
  private nextAccent = 0;
  private listeners = new Set<Listener>();

  private recorder: MediaRecorder | null = null;
  private recChunks: BlobPart[] = [];
  private recStartCtx = 0;
  private recResolveStop: (() => void) | null = null;

  workletReady = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    this.listeners.forEach((f) => f());
  }

  async ensure(): Promise<AudioContext> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);

    this.worklet = new AudioWorkletNode(ctx, 'diabolo-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 3,
      outputChannelCount: [1, 1, 1],
    });
    this.worklet.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === 'pitch') {
        this.pitch = {
          midi: m.midi, freq: m.freq, confidence: m.confidence, rms: m.rms, gate: m.gate,
          voiced: m.voiced, target: m.target, h3: m.h3, h5: m.h5,
        };
      }
    };
    this.workletReady = true;

    // 输入：wind 高通 -> worklet
    this.inputBus = ctx.createGain();
    this.windHp = ctx.createBiquadFilter();
    this.windHp.type = 'highpass';
    this.windHp.frequency.value = 90 + this.settings.wind * 240;
    this.windHp.Q.value = 0.7;
    this.inputBus.connect(this.windHp);
    this.windHp.connect(this.worklet);

    // 三个声部
    this.leadGain = ctx.createGain();
    this.g3 = ctx.createGain();
    this.g5 = ctx.createGain();
    this.worklet.connect(this.leadGain, 0);
    this.worklet.connect(this.g3, 1);
    this.worklet.connect(this.g5, 2);

    const voiceMix = ctx.createGain();
    this.leadGain.connect(voiceMix);
    this.g3.connect(voiceMix);
    this.g5.connect(voiceMix);

    // 颤音：LFO 调制 delayTime，重拍时推大 depth
    this.vibDelay = ctx.createDelay(0.05);
    this.vibDelay.delayTime.value = 0.006;
    this.vibLfo = ctx.createOscillator();
    this.vibLfo.frequency.value = 5.6;
    this.vibDepth = ctx.createGain();
    this.vibDepth.gain.value = 0;
    this.vibLfo.connect(this.vibDepth);
    this.vibDepth.connect(this.vibDelay.delayTime);
    this.vibLfo.start();
    voiceMix.connect(this.vibDelay);

    this.whistleBus = ctx.createGain();
    this.whistleBus.gain.value = this.settings.whistleGain;
    this.vibDelay.connect(this.whistleBus);

    // 回声：重拍时给 send 一个脉冲
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0.0001;
    this.echoDelay = ctx.createDelay(2);
    this.echoDelay.delayTime.value = 0.36;
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0.36;
    this.echoLp = ctx.createBiquadFilter();
    this.echoLp.type = 'lowpass';
    this.echoLp.frequency.value = 2600;
    this.echoReturn = ctx.createGain();
    this.echoReturn.gain.value = 0.5;
    this.whistleBus.connect(this.echoSend);
    this.echoSend.connect(this.echoDelay);
    this.echoDelay.connect(this.echoLp);
    this.echoLp.connect(this.echoFb);
    this.echoFb.connect(this.echoDelay);
    this.echoLp.connect(this.echoReturn);

    // 伴奏
    this.acctGain = ctx.createGain();
    this.acctGain.gain.value = this.settings.accompGain;

    // 总线
    const mixBus = ctx.createGain();
    this.whistleBus.connect(mixBus);
    this.echoReturn.connect(mixBus);
    this.acctGain.connect(mixBus);

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    mixBus.connect(this.comp);

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.settings.master;
    this.comp.connect(this.masterGain);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.masterGain.connect(this.analyser);

    // 录制分支（不受监听开关影响）
    this.recDest = ctx.createMediaStreamDestination();
    this.masterGain.connect(this.recDest);

    // 监听分支（可关扬声器，录制继续）
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = this.settings.monitoring ? 1 : 0;
    this.masterGain.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination);

    this.applySettings(this.settings);
    // 给 worklet 一个跨八度的默认 C 和弦，避免未播放伴奏时目标音只在 C4 附近
    this.worklet.port.postMessage({
      type: 'chordNow',
      midis: expandChordMidis(60, 'maj', 36, 96),
      scalePC: scalePitchClasses(this.track?.beatmap.keyRoot ?? 0, this.track?.beatmap.keyMode ?? 'major'),
      mode: this.settings.harmonyMode,
    });
    return ctx;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser ?? null;
  }

  /* ---------------- 输入源 ---------------- */

  async enableMic(): Promise<void> {
    await this.ensure();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集');
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.micNode = this.ctx!.createMediaStreamSource(this.micStream);
    this.micNode.connect(this.inputBus);
    this.settings.micReady = true;
    this.setSource('mic');
    this.emit();
  }

  setSource(source: FxSettings['source']): void {
    this.settings.source = source;
    if (source === 'mic') {
      this.micNode?.connect(this.inputBus);
      try { this.demoNode?.stop(); } catch { /* noop */ }
      this.demoNode?.disconnect();
      this.demoNode = null;
      this.demoPresetId = null;
    } else {
      this.micNode?.disconnect();
      if (this.demoPresetId !== source) {
        try { this.demoNode?.stop(); } catch { /* noop */ }
        this.demoNode?.disconnect();
        this.demoNode = null;
        this.demoPresetId = source;
        // buffer 由 loadDemoWhistle 预先放入
        const buffer = this.demoBuffers.get(source);
        if (buffer && this.ctx) {
          const node = this.ctx.createBufferSource();
          node.buffer = buffer;
          node.loop = true;
          node.connect(this.inputBus);
          node.start();
          this.demoNode = node;
        }
      }
    }
    this.emit();
  }

  demoBuffers = new Map<string, AudioBuffer>();
  registerDemoWhistle(id: string, buffer: AudioBuffer) {
    this.demoBuffers.set(id, buffer);
  }

  /* ---------------- 设置 ---------------- */

  updateSettings(patch: Partial<FxSettings>): void {
    Object.assign(this.settings, patch);
    this.applySettings(patch);
    this.emit();
  }

  private applySettings(patch: Partial<FxSettings>): void {
    if (!this.ctx || !this.worklet) return;
    const t = this.ctx.currentTime;
    const setParam = (name: string, v: number) => {
      const p = this.worklet!.parameters.get(name);
      if (p) p.setTargetAtTime(v, t, 0.03);
    };
    if (patch.strength !== undefined) setParam('strength', patch.strength);
    if (patch.retuneMs !== undefined) setParam('retuneSec', patch.retuneMs / 1000);
    if (patch.gateDb !== undefined) setParam('gateDb', patch.gateDb);
    if (patch.wind !== undefined) {
      setParam('windSuppression', patch.wind);
      this.windHp.frequency.setTargetAtTime(90 + patch.wind * 240, t, 0.05);
    }
    if (patch.h3 !== undefined) this.g3.gain.setTargetAtTime(patch.h3, t, 0.03);
    if (patch.h5 !== undefined) this.g5.gain.setTargetAtTime(patch.h5, t, 0.03);
    if (patch.whistleGain !== undefined) this.whistleBus.gain.setTargetAtTime(patch.whistleGain, t, 0.03);
    if (patch.accompGain !== undefined) this.acctGain.gain.setTargetAtTime(patch.accompGain, t, 0.03);
    if (patch.master !== undefined) this.masterGain.gain.setTargetAtTime(patch.master, t, 0.03);
    if (patch.monitoring !== undefined) this.monitorGain.gain.setTargetAtTime(patch.monitoring ? 1 : 0, t, 0.02);
    if (patch.echoBeats !== undefined && this.track) {
      this.echoDelay.delayTime.setTargetAtTime(this.track.beatmap.beatSec * patch.echoBeats, t, 0.05);
    }
    if (patch.harmonyMode !== undefined && this.track) this.resendChordConfig();
  }

  /** 和声规则切换时，用当前和弦立刻重发 */
  private resendChordConfig(): void {
    if (!this.worklet || !this.track || !this.ctx) return;
    const bt = this.currentBufferTime();
    const chord = this.track.beatmap.chords.find((c) => bt >= c.startSec && bt < c.endSec)
      ?? this.track.beatmap.chords[0];
    if (!chord) return;
    const scalePC = scalePitchClasses(this.track.beatmap.keyRoot, this.track.beatmap.keyMode);
    this.worklet.port.postMessage({
      type: 'chordNow',
      midis: expandChordMidis(chord.rootMidi, chord.quality),
      scalePC,
      mode: this.settings.harmonyMode,
    });
  }

  /* ---------------- 伴奏传输 ---------------- */

  loadTrack(track: Track): void {
    this.stop();
    this.track = track;
    this.pausedOffset = 0;
    if (this.ctx && this.echoDelay) {
      this.echoDelay.delayTime.value = track.beatmap.beatSec * this.settings.echoBeats;
    }
    this.resendChordConfig();
    this.emit();
  }

  async play(offsetSec?: number): Promise<void> {
    await this.ensure();
    if (!this.track || !this.ctx) return;
    if (this.playing) this.pause();
    const offset = offsetSec ?? this.pausedOffset ?? 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.track.buffer;
    src.connect(this.acctGain);
    const when = this.ctx.currentTime + 0.09;
    this.startCtxTime = when;
    this.startOffset = offset;
    src.start(when, offset);
    this.srcNode = src;
    this.playing = true;
    src.onended = () => {
      // 自然播完（非手动 stop）
      if (this.srcNode === src) {
        this.playing = false;
        this.pausedOffset = 0;
        this.stopScheduler();
        this.worklet?.port.postMessage({ type: 'clearSchedule' });
        this.emit();
      }
    };

    // 采样级和弦时间表
    const bm = this.track.beatmap;
    const scalePC = scalePitchClasses(bm.keyRoot, bm.keyMode);
    const events = bm.chords
      .filter((c) => c.endSec > offset)
      .map((c) => ({
        t: when + Math.max(0, c.startSec - offset),
        midis: expandChordMidis(c.rootMidi, c.quality),
        scalePC,
        mode: this.settings.harmonyMode,
      }));
    this.worklet?.port.postMessage({ type: 'schedule', events });
    // 先立刻应用当前和弦，避免 90ms 空窗
    this.resendChordConfigAt(offset);

    // 重拍调度
    this.nextAccent = 0;
    const accents = this.accentTimes();
    while (this.nextAccent < accents.length && accents[this.nextAccent] < offset - 0.05) this.nextAccent++;
    this.startScheduler();
    this.emit();
  }

  private resendChordConfigAt(bt: number): void {
    if (!this.worklet || !this.track) return;
    const chord = this.track.beatmap.chords.find((c) => bt >= c.startSec && bt < c.endSec)
      ?? this.track.beatmap.chords[0];
    if (!chord) return;
    const scalePC = scalePitchClasses(this.track.beatmap.keyRoot, this.track.beatmap.keyMode);
    this.worklet.port.postMessage({
      type: 'chordNow',
      midis: expandChordMidis(chord.rootMidi, chord.quality),
      scalePC,
      mode: this.settings.harmonyMode,
    });
  }

  pause(): void {
    if (!this.ctx) return;
    if (this.playing) this.pausedOffset = this.currentBufferTime();
    try { this.srcNode?.stop(); } catch { /* noop */ }
    this.srcNode?.disconnect();
    this.srcNode = null;
    this.playing = false;
    this.stopScheduler();
    this.worklet?.port.postMessage({ type: 'clearSchedule' });
    this.emit();
  }

  stop(): void {
    this.pause();
    this.pausedOffset = 0;
    this.emit();
  }

  seek(sec: number): void {
    const wasPlaying = this.playing;
    this.pausedOffset = Math.max(0, Math.min(sec, this.track?.beatmap.durationSec ?? 0));
    if (wasPlaying) void this.play(this.pausedOffset);
    this.emit();
  }

  currentBufferTime(): number {
    if (!this.ctx || !this.playing) return this.pausedOffset;
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime);
  }

  getTransport(): TransportState {
    const bm = this.track?.beatmap;
    const cur = this.currentBufferTime();
    const beatSec = bm?.beatSec ?? 0.5;
    const beatFloat = bm ? cur / beatSec - (bm.offsetSec ?? 0) / beatSec : 0;
    // beats 数组第 0 拍已对齐重拍且时间≈offsetSec
    const beatIndex = bm ? nearestBeatIndex(bm.beats, cur) : -1;
    return {
      playing: this.playing,
      currentSec: cur,
      durationSec: bm?.durationSec ?? 0,
      bpm: bm?.bpm ?? 0,
      currentBeat: beatFloat,
      beatInBar: beatIndex >= 0 ? ((beatIndex % (bm?.beatsPerBar ?? 4)) + 1) : 0,
    };
  }

  /* ---------------- 重拍效果调度 ---------------- */

  /** 重拍时间（缓冲时间）：4/4 取第 1、3 拍，3/4 取第 1 拍 */
  accentTimes(): number[] {
    const bm = this.track?.beatmap;
    if (!bm) return [];
    const out: number[] = [];
    const bpb = bm.beatsPerBar;
    const strongOffsets = bpb === 4 ? [0, 2] : [0];
    for (let bar = 0; bar < bm.downbeats.length; bar++) {
      for (const off of strongOffsets) {
        const idx = bar * bpb + off;
        if (idx < bm.beats.length) out.push(bm.beats[idx]);
      }
    }
    return out.sort((a, b) => a - b);
  }

  private startScheduler(): void {
    this.stopScheduler();
    this.schedTimer = window.setInterval(() => this.scheduleLoop(), 25);
    this.scheduleLoop();
  }
  private stopScheduler(): void {
    if (this.schedTimer !== null) {
      clearInterval(this.schedTimer);
      this.schedTimer = null;
    }
  }

  private scheduleLoop(): void {
    if (!this.ctx || !this.track || !this.playing) return;
    const accents = this.accentTimes();
    const offset = this.startOffset;
    // 缓冲时间 -> AudioContext 时间
    const bufferToCtx = (bt: number) => this.startCtxTime + (bt - offset);
    const horizon = this.ctx.currentTime + 0.16;
    while (this.nextAccent < accents.length) {
      const bt = accents[this.nextAccent];
      const ct = bufferToCtx(bt);
      if (ct > horizon) break;
      if (ct >= this.ctx.currentTime - 0.05) this.triggerBeatFx(ct);
      this.nextAccent++;
    }
  }

  /** 在精确的 AudioContext 时间触发颤音/回声脉冲 */
  triggerBeatFx(t: number, mode?: BeatFxMode, amount?: number): void {
    if (!this.ctx) return;
    const fxMode = mode ?? this.settings.beatFx;
    const amt = amount ?? this.settings.fxAmount;
    const tt = Math.max(t, this.ctx.currentTime);

    if (fxMode === 'vibrato' || fxMode === 'both') {
      const peak = 0.00035 + amt * 0.00115; // 延迟调制深度（秒）
      const p = this.vibDepth.gain;
      p.cancelScheduledValues(tt);
      p.setValueAtTime(0.00001, tt);
      p.exponentialRampToValueAtTime(Math.max(0.00002, peak), tt + 0.022);
      p.exponentialRampToValueAtTime(0.00001, tt + 0.42);
    }
    if (fxMode === 'echo' || fxMode === 'both') {
      const peak = 0.22 + amt * 0.75;
      const g = this.echoSend.gain;
      g.cancelScheduledValues(tt);
      g.setValueAtTime(0.0001, tt);
      g.exponentialRampToValueAtTime(Math.max(0.001, peak), tt + 0.012);
      g.exponentialRampToValueAtTime(0.0001, tt + 0.4);
    }
    this.emitBeatPulse(tt);
  }

  /** 供 UI 对齐节拍闪光（返回相对当前时间的延时） */
  private beatListeners = new Set<(ctxTime: number) => void>();
  onBeat(fn: (ctxTime: number) => void) {
    this.beatListeners.add(fn);
    return () => this.beatListeners.delete(fn);
  }
  private emitBeatPulse(t: number) {
    this.beatListeners.forEach((fn) => fn(t));
  }

  /* ---------------- 录制 ---------------- */

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async startRecording(): Promise<void> {
    const ctx = await this.ensure();
    if (!this.recDest) throw new Error('录制总线未就绪');
    this.recChunks = [];
    const mime = pickMime();
    this.recorder = new MediaRecorder(this.recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recChunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const type = this.recorder?.mimeType || mime || 'audio/webm';
      const blob = new Blob(this.recChunks, { type });
      const durationSec = this.ctx ? Math.max(0.1, this.ctx.currentTime - this.recStartCtx) : 0;
      const d = new Date();
      const pad = (x: number) => String(x).padStart(2, '0');
      const take: Take = {
        id: `take-${Date.now()}`,
        url: URL.createObjectURL(blob),
        blob,
        mime: type,
        startedAt: Date.now(),
        durationSec,
        size: blob.size,
        name: `空竹和鸣_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
      };
      this.takes.unshift(take);
      this.recResolveStop?.();
      this.recResolveStop = null;
      this.emit();
    };
    this.recStartCtx = ctx.currentTime;
    this.recorder.start(250);
    this.emit();
  }

  stopRecording(): Promise<Take[]> {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        resolve(this.takes);
        return;
      }
      this.recResolveStop = () => resolve(this.takes);
      this.recorder.stop();
    });
  }

  deleteTake(id: string): void {
    const i = this.takes.findIndex((t) => t.id === id);
    if (i >= 0) {
      URL.revokeObjectURL(this.takes[i].url);
      this.takes.splice(i, 1);
      this.emit();
    }
  }
}

function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* noop */ }
  }
  return null;
}

function nearestBeatIndex(beats: number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(beats[lo - 1] - t) < Math.abs(beats[lo] - t)) return lo - 1;
  return lo;
}

export const engine = new AudioEngine();
