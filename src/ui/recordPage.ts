// 页面 4：演出录制 + 算法自检
import { h } from '../ui/dom';
import { store } from '../state/store';
import { engine } from '../audio/engine';
import { bootLibrary } from '../services/library';
import { runBrowserSelfTest } from '../test/selftest';

export function createRecordPage(): { el: HTMLElement; destroy(): void } {
  let raf = 0;

  const recDot = h('div', { class: 'rec-dot', id: 'rec-dot' });
  const timer = h('div', { class: 'rec-timer mono', id: 'rec-timer' }, '00:00');
  const recBtn = h('button', { class: 'btn rec-btn big', id: 'record-btn' }, '● 开始录制');
  const recHint = h('p', { class: 'hint' }, '录制内容 = 配乐 + 拉音主声 + 三度/五度和声 + 重拍颤音/回声 的总输出（Web Audio 总线 → MediaRecorder）。');

  recBtn.addEventListener('click', async () => {
    await bootLibrary();
    if (engine.isRecording) {
      recBtn.disabled = true;
      await engine.stopRecording();
      recBtn.disabled = false;
      store.toast('演出已保存，可在下方回放或下载', 'ok');
    } else {
      try {
        await engine.startRecording();
        store.toast('开始录制整场演出', 'info', 2000);
      } catch (e) {
        store.toast(`录制启动失败：${(e as Error).message}`, 'err', 5000);
      }
    }
    syncRec();
  });

  function syncRec() {
    const rec = engine.isRecording;
    recBtn.textContent = rec ? '■ 停止并保存' : '● 开始录制';
    recBtn.classList.toggle('recording', rec);
    recDot.classList.toggle('on', rec);
  }
  const unsubEngine = engine.subscribe(() => { syncRec(); renderTakes(); });

  const takeList = h('div', { class: 'take-list' });
  function renderTakes() {
    takeList.replaceChildren();
    if (!engine.takes.length) {
      takeList.appendChild(h('div', { class: 'empty' }, '还没有录音。开始录制后会出现在这里。'));
      return;
    }
    for (const t of engine.takes) {
      const audio = h('audio', { controls: true, src: t.url }) as HTMLAudioElement;
      const a = h('a', { class: 'btn small primary', href: t.url, download: `${t.name}.webm` }, '⬇ 下载');
      const del = h('button', { class: 'btn small danger', onclick: () => engine.deleteTake(t.id) }, '删除');
      takeList.appendChild(h('div', { class: 'take-card card' },
        h('div', { class: 'take-head' },
          h('b', null, t.name),
          h('span', { class: 'badge' }, `${t.durationSec.toFixed(1)}s · ${(t.size / 1024 / 1024).toFixed(2)}MB`),
        ),
        audio,
        h('div', { class: 'take-actions' }, a, del),
      ));
    }
  }

  // 自检
  const testOut = h('div', { class: 'selftest-out', id: 'selftest-out' });
  const testBtn = h('button', { class: 'btn gold', id: 'selftest-btn' }, '🧪 运行算法自检（离线音频，约 15 秒）');
  testBtn.addEventListener('click', async () => {
    testBtn.setAttribute('disabled', 'true');
    testOut.replaceChildren(h('div', { class: 'hint' }, '正在 OfflineAudioContext 中渲染并测量…'));
    try {
      const summary = await runBrowserSelfTest();
      store.set({ selftest: summary });
      renderTest();
    } catch (e) {
      testOut.replaceChildren(h('div', { class: 'selftest-fail' }, `自检运行失败：${(e as Error).message}`));
    } finally {
      testBtn.removeAttribute('disabled');
    }
  });

  function renderTest() {
    const s = store.state.selftest;
    if (!s) return;
    testOut.replaceChildren(
      h('div', { class: `selftest-summary ${s.failed ? 'has-fail' : 'all-pass'}` },
        `${s.failed === 0 ? '✅ 全部通过' : '⚠ 有未达标项'}：${s.passed} 通过 / ${s.failed} 未过 · ${(s.durationMs / 1000).toFixed(1)}s`),
      ...s.checks.map((c) => h('div', { class: `check-row ${c.pass ? 'pass' : 'fail'}` },
        h('span', { class: 'check-icon' }, c.pass ? '✓' : '✗'),
        h('span', { class: 'check-name' }, c.name),
        h('span', { class: 'check-detail mono' }, c.detail),
      )),
    );
  }

  const el = h('div', { class: 'page record-page' },
    h('div', { class: 'page-head' }, h('h1', null, '演出录制')),
    h('section', { class: 'panel card rec-panel' },
      h('div', { class: 'rec-row' }, recDot, timer, recBtn),
      recHint,
    ),
    h('section', { class: 'panel' }, h('h2', null, '本场录音'), takeList),
    h('section', { class: 'panel card selftest-panel' },
      h('h2', null, '指标自检'),
      h('p', { class: 'hint' }, '用代码合成的哨声在离线音频上下文里跑真实 AudioWorklet，客观验证题目指标；Node 侧另有 20 分钟浸泡测试。'),
      testBtn, testOut,
    ),
  );

  renderTakes();
  renderTest();

  const loop = () => {
    if (engine.isRecording && engine.ctx) {
      // 用录制开始的上下文时间近似
      timer.textContent = fmt(Math.max(0, engine.ctx.currentTime - (engine as unknown as { recStartCtx: number }).recStartCtx));
      recDot.classList.add('on');
    } else if (!engine.takes.length) {
      timer.textContent = '00:00';
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    el,
    destroy() { cancelAnimationFrame(raf); unsubEngine(); },
  };
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
