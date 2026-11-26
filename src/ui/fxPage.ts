// 页面 3：实时效果（音高跟踪表 + 拉音 + 和声 + 重拍效果）
import { h } from '../ui/dom';
import { store } from '../state/store';
import { engine } from '../audio/engine';
import { bootLibrary } from '../services/library';
import { midiName } from '../audio/theory';
import type { BeatFxMode, FxSettings } from '../types';

function sliderRow(opts: {
  label: string; value: number; min: number; max: number; step: number; unit?: string; id?: string;
  format?: (v: number) => string; onInput: (v: number) => void;
}) {
  const val = h('span', { class: 'slider-val mono' }, opts.format ? opts.format(opts.value) : String(opts.value));
  const input = h('input', {
    type: 'range', class: 'slider', id: opts.id, min: String(opts.min), max: String(opts.max), step: String(opts.step), value: String(opts.value),
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = opts.format ? opts.format(v) : `${v}${opts.unit ?? ''}`;
    opts.onInput(v);
  });
  return h('label', { class: 'slider-row' },
    h('span', { class: 'slider-label' }, opts.label),
    input, val,
  );
}

export function createFxPage(): { el: HTMLElement; destroy(): void } {
  const s = engine.settings;
  let raf = 0;
  const timeouts: number[] = [];
  const cleanups: Array<() => void> = [];
  const unsubBeat = engine.onBeat((ctxT) => {
    if (!engine.ctx) return;
    const ms = Math.max(0, (ctxT - engine.ctx.currentTime) * 1000);
    const id = window.setTimeout(() => {
      beatDot.classList.add('flash');
      beatDot2.classList.add('flash');
      window.setTimeout(() => { beatDot.classList.remove('flash'); beatDot2.classList.remove('flash'); }, 120);
    }, ms);
    timeouts.push(id);
  });

  /* ---- 输入源 ---- */
  const sourceSel = h('select', { class: 'select', id: 'fx-source' }) as HTMLSelectElement;
  function fillSources() {
    sourceSel.replaceChildren();
    sourceSel.appendChild(h('option', { value: 'mic' }, '🎤 领夹麦 / 麦克风'));
    for (const w of store.state.whistles) {
      sourceSel.appendChild(h('option', { value: w.id }, `🪈 演示哨声：${w.name}`));
    }
    sourceSel.value = s.source;
  }
  sourceSel.addEventListener('change', async () => {
    await bootLibrary();
    if (sourceSel.value === 'mic') {
      try { await engine.enableMic(); store.toast('麦克风已接入', 'ok'); }
      catch (e) { store.toast(`麦克风不可用：${(e as Error).message}`, 'err', 5000); sourceSel.value = 'whistle-clear'; engine.setSource('whistle-clear'); }
    } else {
      engine.setSource(sourceSel.value);
      store.toast(`正在输入演示哨声（循环）`, 'info', 1600);
    }
  });

  const micBtn = h('button', {
    class: 'btn', id: 'mic-btn',
    onclick: async () => {
      await bootLibrary();
      try { await engine.enableMic(); sourceSel.value = 'mic'; store.toast('领夹麦已接入，请用音箱外放时注意回授，建议戴监听耳机', 'ok', 5000); }
      catch (e) { store.toast(`麦克风授权失败：${(e as Error).message}`, 'err', 6000); }
    },
  }, '连接领夹麦');

  /* ---- 音高表 ---- */
  const noteEl = h('div', { class: 'pitch-note mono', id: 'pitch-note' }, '–');
  const centsEl = h('div', { class: 'pitch-cents mono', id: 'pitch-cents' }, '0 音分');
  const needle = h('div', { class: 'needle', id: 'cents-needle' });
  const meter = h('div', { class: 'cents-meter' },
    h('div', { class: 'cents-track' }, h('div', { class: 'cents-center' }), needle),
    h('div', { class: 'cents-labels' }, h('span', null, '-50'), h('span', null, '0'), h('span', null, '+50')),
  );
  const confBar = h('div', { class: 'bar' }, h('i', { id: 'conf-bar' }));
  const rmsBar = h('div', { class: 'bar' }, h('i', { id: 'rms-bar' }));
  const statePill = h('span', { class: 'state-pill', id: 'voiced-pill' }, '未出声');
  const targetEl = h('div', { class: 'target-line' },
    h('span', null, '拉到：'), h('b', { id: 'target-note' }, '–'),
    h('span', { class: 'dim' }, '　三：'), h('b', { id: 'h3-note' }, '–'),
    h('span', { class: 'dim' }, '　五：'), h('b', { id: 'h5-note' }, '–'),
  );

  /* ---- 拉音 ---- */
  const strengthSlider = sliderRow({
    label: '拉音力度', id: 'strength-slider', min: 0, max: 1, step: 0.01, value: s.strength,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => engine.updateSettings({ strength: v }),
  });
  const strengthHint = h('div', { class: 'slider-hints' },
    h('span', null, '0 原声'), h('span', null, '50% 保留滑音起伏'), h('span', null, '100% 完全拉到和弦音'));

  const retuneSlider = sliderRow({
    label: '拉音速度', min: 15, max: 400, step: 5, value: s.retuneMs, unit: 'ms',
    format: (v) => `${v.toFixed(0)}ms`,
    onInput: (v) => engine.updateSettings({ retuneMs: v }),
  });
  const gateSlider = sliderRow({
    label: '噪声门限', min: -72, max: -24, step: 1, value: s.gateDb, unit: 'dB',
    format: (v) => `${v.toFixed(0)} dB`, onInput: (v) => engine.updateSettings({ gateDb: v }),
  });
  const windSlider = sliderRow({
    label: '风噪抑制', min: 0, max: 1, step: 0.01, value: s.wind,
    format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => engine.updateSettings({ wind: v }),
  });

  /* ---- 和声 ---- */
  const h3Slider = sliderRow({ label: '三度音量', min: 0, max: 1, step: 0.01, value: s.h3, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => engine.updateSettings({ h3: v }) });
  const h5Slider = sliderRow({ label: '五度音量', min: 0, max: 1, step: 0.01, value: s.h5, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => engine.updateSettings({ h5: v }) });
  const modeSel = h('select', { class: 'select' }) as HTMLSelectElement;
  ([['diatonic', '自然音阶三/五度（最协和）'], ['chord', '和弦内音和声']] as const).forEach(([v, label]) => {
    const o = h('option', { value: v }, label) as HTMLOptionElement;
    if (s.harmonyMode === v) o.selected = true;
    modeSel.appendChild(o);
  });
  modeSel.addEventListener('change', () => engine.updateSettings({ harmonyMode: modeSel.value as FxSettings['harmonyMode'] }));

  /* ---- 重拍效果 ---- */
  const fxModes: Array<[BeatFxMode, string]> = [['off', '关'], ['vibrato', '重拍颤音'], ['echo', '重拍回声'], ['both', '颤音+回声']];
  const fxGroup = h('div', { class: 'seg', id: 'beatfx-group' });
  for (const [v, label] of fxModes) {
    const b = h('button', {
      class: `seg-btn${s.beatFx === v ? ' active' : ''}`, dataset: { v },
      onclick: () => { engine.updateSettings({ beatFx: v }); fxGroup.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', (x as HTMLElement).dataset.v === v)); },
    }, label);
    fxGroup.appendChild(b);
  }
  const amtSlider = sliderRow({ label: '效果深度', min: 0, max: 1, step: 0.01, value: s.fxAmount, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => engine.updateSettings({ fxAmount: v }) });
  const echoSel = h('select', { class: 'select' }) as HTMLSelectElement;
  ([0.5, 0.75, 1] as const).forEach((v) => {
    const o = h('option', { value: String(v) }, `回声 ${v} 拍`) as HTMLOptionElement;
    if (s.echoBeats === v) o.selected = true;
    echoSel.appendChild(o);
  });
  echoSel.addEventListener('change', () => engine.updateSettings({ echoBeats: parseFloat(echoSel.value) as FxSettings['echoBeats'] }));

  const beatDot = h('div', { class: 'beat-dot' });
  const beatDot2 = h('div', { class: 'beat-dot small' });

  /* ---- 伴奏 ---- */
  const accompPlay = h('button', {
    class: 'btn primary', id: 'fx-accomp-play',
    onclick: async () => {
      await bootLibrary();
      if (engine.playing) engine.pause();
      else await engine.play();
    },
  }, '▶ 播放配乐');
  cleanups.push(engine.subscribe(() => { accompPlay.textContent = engine.playing ? '⏸ 暂停配乐' : '▶ 播放配乐'; }));

  const monitorChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  monitorChk.checked = s.monitoring;
  monitorChk.addEventListener('change', () => engine.updateSettings({ monitoring: monitorChk.checked }));

  const accompVol = sliderRow({
    label: '伴奏音量', min: 0, max: 1, step: 0.01, value: s.accompGain,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => engine.updateSettings({ accompGain: v }),
  });

  const el = h('div', { class: 'page fx-page' },
    h('div', { class: 'page-head' }, h('h1', null, '实时效果'),
      h('div', { class: 'head-right' }, beatDot2, beatDot)),
    h('div', { class: 'fx-grid' },
      h('section', { class: 'panel pitch-panel card' },
        h('h2', null, '哨声音高跟踪'),
        h('div', { class: 'pitch-main' }, noteEl, statePill),
        centsEl, meter,
        h('div', { class: 'meters' },
          h('div', { class: 'meter-row' }, h('span', null, '置信'), confBar),
          h('div', { class: 'meter-row' }, h('span', null, '音量'), rmsBar),
        ),
        targetEl,
      ),
      h('section', { class: 'panel card' },
        h('h2', null, '输入'),
        h('div', { class: 'ctl-col' }, sourceSel, micBtn,
          h('label', { class: 'check-row' }, monitorChk, '监听输出（接音箱请谨慎，建议耳机）')),
        h('div', { class: 'accomp-row' }, accompPlay, accompVol),
      ),
      h('section', { class: 'panel card' },
        h('h2', null, '和弦拉音'),
        strengthSlider, strengthHint, retuneSlider, gateSlider, windSlider,
      ),
      h('section', { class: 'panel card' },
        h('h2', null, '三度 · 五度和声'),
        modeSel, h3Slider, h5Slider,
        h('p', { class: 'hint' }, '音高同步颗粒变调 + 整数周期交叉淡化，避免金属声。'),
      ),
      h('section', { class: 'panel card wide' },
        h('h2', null, '重拍效果（卡在拍点 ±30ms）'),
        h('div', { class: 'fx-row' }, fxGroup, echoSel),
        amtSlider,
        h('p', { class: 'hint' }, '颤音由拍点推动延迟调制深度；回声只在重拍瞬间打开发送，形成“加一下响”。'),
      ),
    ),
  );

  fillSources();

  // 高频 rAF 直接写 DOM
  const confFill = confBar.querySelector('i') as HTMLElement;
  const rmsFill = rmsBar.querySelector('i') as HTMLElement;
  const loop = () => {
    const p = engine.pitch;
    if (p.midi != null) {
      const m = Math.round(p.midi);
      noteEl.textContent = midiName(m);
      const centsDev = (p.midi - m) * 100;
      centsEl.textContent = `${centsDev >= 0 ? '+' : ''}${centsDev.toFixed(0)} 音分`;
      needle.style.left = `${50 + Math.max(-50, Math.min(50, centsDev))}%`;
    } else {
      noteEl.textContent = '–';
      centsEl.textContent = '等待哨声';
      needle.style.left = '50%';
    }
    confFill.style.width = `${Math.round((p.confidence || 0) * 100)}%`;
    const rmsPct = Math.min(100, Math.round(20 * Math.log10(Math.max(1e-4, p.rms)) + 120));
    rmsFill.style.width = `${Math.max(0, rmsPct)}%`;
    statePill.textContent = p.voiced ? '哨声中' : (p.gate > 0.02 ? '收尾中' : '未出声');
    statePill.classList.toggle('on', p.voiced);
    const te = el.querySelector('#target-note'); if (te) te.textContent = p.target != null ? midiName(p.target) : '–';
    const h3 = el.querySelector('#h3-note'); if (h3) h3.textContent = p.h3 ? midiName(p.h3) : '–';
    const h5 = el.querySelector('#h5-note'); if (h5) h5.textContent = p.h5 ? midiName(p.h5) : '–';
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  const unsubStore = store.subscribe(() => { fillSources(); });

  return {
    el,
    destroy() {
      cancelAnimationFrame(raf);
      unsubStore();
      unsubBeat();
      cleanups.forEach((f) => f());
      timeouts.forEach((id) => clearTimeout(id));
    },
  };
}
