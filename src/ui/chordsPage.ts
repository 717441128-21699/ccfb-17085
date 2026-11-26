// 页面 2：和弦拍点（波形 + 拍点/重拍/和弦标注 + 编辑）
import { h } from '../ui/dom';
import { store } from '../state/store';
import { engine } from '../audio/engine';
import { bootLibrary } from '../services/library';
import { analyzeBuffer } from '../audio/analysis';
import { NOTE_NAMES, chordLabel } from '../audio/theory';
import type { ChordQuality, Track } from '../types';

const QUALITIES: ChordQuality[] = ['maj', 'min', 'dim', 'aug', '7', 'maj7', 'min7'];
const Q_LABEL: Record<ChordQuality, string> = { maj: '大三', min: '小三', dim: '减', aug: '增', '7': '属7', maj7: '大7', min7: '小7' };

export function createChordsPage(): { el: HTMLElement; destroy(): void } {
  let track: Track | null = store.currentTrack();
  let raf = 0;
  const unsubs: Array<() => void> = [];

  const trackSelect = h('select', { class: 'select' }) as HTMLSelectElement;
  function fillTracks() {
    trackSelect.replaceChildren();
    for (const t of store.state.tracks) {
      trackSelect.appendChild(h('option', { value: t.id }, t.title) as HTMLOptionElement);
    }
    if (track) trackSelect.value = track.id;
  }
  trackSelect.addEventListener('change', () => {
    const t = store.state.tracks.find((x) => x.id === trackSelect.value) ?? null;
    if (t) { track = t; store.selectTrack(t.id); engine.loadTrack(t); buildChordEditor(); }
  });

  const canvas = h('canvas', { class: 'wave-canvas' }) as HTMLCanvasElement;
  const canvasWrap = h('div', { class: 'wave-wrap' }, canvas);
  canvas.addEventListener('click', async (e) => {
    if (!track) return;
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const sec = u * track.beatmap.durationSec;
    await bootLibrary();
    engine.seek(sec);
  });

  const timeLabel = h('span', { class: 'time-label mono' }, '0:00 / 0:00');
  const beatLamp = h('div', { class: 'beat-lamp' }, '–');
  const bpmInput = h('input', { type: 'number', min: '60', max: '180', step: '0.5', class: 'input bpm-input' }) as HTMLInputElement;
  const keyLabel = h('span', { class: 'key-label badge gold' }, '–');

  const playBtn = h('button', { class: 'btn primary' }, '▶ 播放');
  playBtn.addEventListener('click', async () => {
    await bootLibrary();
    if (!store.currentTrack() && track) { store.selectTrack(track.id); engine.loadTrack(track); }
    if (engine.playing) engine.pause();
    else await engine.play();
  });
  const stopBtn = h('button', { class: 'btn' }, '■');
  stopBtn.addEventListener('click', () => engine.stop());

  function syncTransportBtn() { playBtn.textContent = engine.playing ? '⏸ 暂停' : '▶ 播放'; }
  unsubs.push(engine.subscribe(syncTransportBtn));

  const nudge = (ms: number) => {
    if (!track) return;
    const d = ms / 1000;
    const bm = track.beatmap;
    bm.offsetSec += d;
    for (const b of bm.beats) { /* 直接整体平移 */ }
    shiftArr(bm.beats, d);
    shiftArr(bm.downbeats, d);
    for (const c of bm.chords) { c.startSec += d; c.endSec += d; }
    draw();
    buildChordEditor();
    if (engine.playing) void engine.play(engine.currentBufferTime());
  };

  bpmInput.addEventListener('change', () => {
    if (!track) return;
    const bpm = Math.max(60, Math.min(190, parseFloat(bpmInput.value) || track.beatmap.bpm));
    regrid(track, bpm);
    buildChordEditor();
    if (engine.playing) void engine.play(engine.currentBufferTime());
  });

  const controls = h('div', { class: 'transport card' },
    playBtn, stopBtn, timeLabel, beatLamp,
    h('div', { class: 'spacer' }),
    h('label', { class: 'ctl' }, 'BPM', bpmInput),
    h('button', { class: 'btn small', onclick: () => nudge(-20) }, '拍点 −20ms'),
    h('button', { class: 'btn small', onclick: () => nudge(20) }, '+20ms'),
    keyLabel,
  );

  const chordEditor = h('div', { class: 'chord-editor' });
  function buildChordEditor() {
    chordEditor.replaceChildren();
    if (!track) return;
    bpmInput.value = String(track.beatmap.bpm);
    keyLabel.textContent = `调：${NOTE_NAMES[track.beatmap.keyRoot]} ${track.beatmap.keyMode === 'major' ? '大调' : '小调'}`;
    track.beatmap.chords.forEach((c, idx) => {
      const rootSel = h('select', { class: 'select small' }) as HTMLSelectElement;
      NOTE_NAMES.forEach((n, pc) => {
        const o = h('option', { value: String(pc) }, n) as HTMLOptionElement;
        if (((c.rootMidi % 12) + 12) % 12 === pc) o.selected = true;
        rootSel.appendChild(o);
      });
      const qSel = h('select', { class: 'select small' }) as HTMLSelectElement;
      QUALITIES.forEach((q) => {
        const o = h('option', { value: q }, Q_LABEL[q]) as HTMLOptionElement;
        if (c.quality === q) o.selected = true;
        qSel.appendChild(o);
      });
      const apply = () => {
        c.rootMidi = 48 + parseInt(rootSel.value);
        c.quality = qSel.value as ChordQuality;
        c.label = chordLabel(c.rootMidi, c.quality);
        if (engine.playing) void engine.play(engine.currentBufferTime());
      };
      rootSel.addEventListener('change', apply);
      qSel.addEventListener('change', apply);
      chordEditor.appendChild(h('div', { class: 'chord-row' },
        h('span', { class: 'bar-num' }, `第 ${idx + 1} 小节`),
        rootSel, qSel,
        h('span', { class: 'chord-preview' }, c.label),
        h('span', { class: 'conf' }, `置信 ${(c.confidence * 100).toFixed(0)}%`),
      ));
    });
  }

  const el = h('div', { class: 'page chords-page' },
    h('div', { class: 'page-head' },
      h('h1', null, '和弦 · 拍点'),
      h('div', { class: 'head-right' }, trackSelect,
        h('button', {
          class: 'btn small',
          onclick: async () => { await bootLibrary(); if (track) { track.beatmap = await analyzeBuffer(track.buffer, 4); buildChordEditor(); store.toast('已重新分析', 'ok'); } },
        }, '重新分析')),
    ),
    controls,
    h('section', { class: 'panel' },
      h('div', { class: 'legend' },
        h('span', null, '🟥 重拍/小节首拍'), h('span', null, '🟦 普通拍点'), h('span', null, '🟨 和弦区间')),
      canvasWrap,
    ),
    h('section', { class: 'panel' }, h('h2', null, '和弦进行（可修正，实时生效）'), chordEditor),
  );

  fillTracks();
  buildChordEditor();

  // 波形峰值
  let peaks: { min: Float32Array; max: Float32Array } | null = null;
  function computePeaks() {
    if (!track) return;
    const data = track.buffer.getChannelData(0);
    const buckets = 1600;
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const per = Math.floor(data.length / buckets);
    for (let b = 0; b < buckets; b++) {
      let mn = 1, mx = -1;
      const s = b * per;
      for (let i = 0; i < per; i += 8) { const v = data[s + i] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
      min[b] = mn; max[b] = mx;
    }
    peaks = { min, max };
  }
  computePeaks();

  function draw() {
    if (!track) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvasWrap.clientWidth || 800;
    const hgt = 220;
    if (canvas.width !== Math.floor(w * dpr)) { canvas.width = Math.floor(w * dpr); canvas.height = hgt * dpr; canvas.style.height = `${hgt}px`; canvas.style.width = `${w}px`; }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const bm = track.beatmap;
    const dur = bm.durationSec;
    const X = (t: number) => (t / dur) * w;

    // 和弦区间
    for (const c of bm.chords) {
      g.fillStyle = 'rgba(240, 180, 60, 0.10)';
      g.fillRect(X(c.startSec), 0, Math.max(2, X(c.endSec) - X(c.startSec)), hgt);
      g.fillStyle = 'rgba(245, 200, 90, 0.9)';
      g.font = '600 13px system-ui';
      g.fillText(c.label, X(c.startSec) + 6, 20);
    }

    // 波形
    if (peaks) {
      g.fillStyle = 'rgba(120, 170, 255, 0.55)';
      const bw = w / peaks.max.length;
      const mid = hgt / 2 + 14;
      for (let i = 0; i < peaks.max.length; i++) {
        const y1 = mid + peaks.min[i] * hgt * 0.36;
        const y2 = mid + peaks.max[i] * hgt * 0.36;
        g.fillRect(i * bw, y1, Math.max(1, bw * 0.8), y2 - y1);
      }
    }

    // 普通拍
    g.strokeStyle = 'rgba(90, 160, 255, 0.55)';
    g.lineWidth = 1;
    for (const t of bm.beats) { g.beginPath(); g.moveTo(X(t), 28); g.lineTo(X(t), hgt); g.stroke(); }
    // 重拍
    g.strokeStyle = 'rgba(255, 92, 92, 0.95)';
    g.lineWidth = 2;
    for (const t of bm.downbeats) { g.beginPath(); g.moveTo(X(t), 28); g.lineTo(X(t), hgt); g.stroke(); }

    // 播放头
    const cur = engine.currentBufferTime();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X(cur), 0); g.lineTo(X(cur), hgt); g.stroke();

    const tr = engine.getTransport();
    timeLabel.textContent = `${fmt(cur)} / ${fmt(dur)}`;
    beatLamp.textContent = tr.beatInBar ? `第 ${tr.beatInBar} 拍` : '–';
    beatLamp.dataset.accent = String(tr.beatInBar === 1);
    syncTransportBtn();
  }

  const loop = () => { draw(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);

  const unsubStore = store.subscribe(() => {
    const nt = store.currentTrack();
    if (nt && nt.id !== track?.id) { track = nt; fillTracks(); computePeaks(); buildChordEditor(); }
  });

  return {
    el,
    destroy() { cancelAnimationFrame(raf); unsubStore(); unsubs.forEach((f) => f()); },
  };
}

function shiftArr(a: number[], d: number) { for (let i = 0; i < a.length; i++) a[i] += d; }

function regrid(track: Track, bpm: number) {
  const bm = track.beatmap;
  bm.bpm = bpm;
  bm.beatSec = 60 / bpm;
  const bpb = bm.beatsPerBar;
  const start = bm.offsetSec;
  bm.beats = [];
  for (let t = start, i = 0; t < bm.durationSec; t += bm.beatSec, i++) bm.beats.push(t);
  bm.downbeats = bm.beats.filter((_, i) => i % bpb === 0);
  bm.chords.forEach((c, i) => {
    c.startBeat = i * bpb;
    c.beats = bpb;
    c.startSec = start + i * bpb * bm.beatSec;
    c.endSec = c.startSec + bpb * bm.beatSec;
  });
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}
