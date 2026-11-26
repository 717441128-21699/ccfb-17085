// 页面 1：伴奏导入（文件上传 / 拖拽 / 演示曲目库）
import { h, appendChildren } from './dom';
import { store } from '../state/store';
import { engine } from '../audio/engine';
import { bootLibrary, importAudioFile } from '../services/library';
import { midiName } from '../audio/theory';

export function createImportPage(): { el: HTMLElement; destroy(): void } {
  let dragDepth = 0;
  const fileInput = h('input', { type: 'file', accept: 'audio/*', style: 'display:none' }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (f) {
      try {
        await bootLibrary();
        await importAudioFile(f);
        store.toast(`已导入并分析：${f.name}`, 'ok');
      } catch (e) {
        store.toast(`导入失败：${(e as Error).message}`, 'err', 5000);
      }
    }
  });

  const drop = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': '导入伴奏音频' } as any,
    h('div', { class: 'drop-icon' }, '🎵'),
    h('div', { class: 'drop-title' }, '点击选择或把伴奏音频拖到这里'),
    h('div', { class: 'drop-sub' }, '支持 MP3 / WAV / M4A / OGG，导入后自动分析拍点与和弦'),
    fileInput,
  );
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  drop.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => { dragDepth--; if (dragDepth <= 0) drop.classList.remove('drag'); });
  drop.addEventListener('dragover', (e) => e.preventDefault());
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove('drag');
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) {
      try {
        await bootLibrary();
        await importAudioFile(f);
        store.toast(`已导入并分析：${f.name}`, 'ok');
      } catch (err) {
        store.toast(`导入失败：${(err as Error).message}`, 'err', 5000);
      }
    }
  });

  const list = h('div', { class: 'track-grid' });
  function renderTracks() {
    list.replaceChildren();
    const tracks = store.state.tracks;
    if (!tracks.length) {
      list.appendChild(h('div', { class: 'empty' }, '演示曲目合成中…若浏览器拦截了音频，请先点右上角“启动音频”。'));
      return;
    }
    for (const t of tracks) {
      const bm = t.beatmap;
      const active = store.state.currentTrackId === t.id;
      const card = h('div', { class: `card track-card${active ? ' active' : ''}` },
        h('div', { class: 'track-head' },
          h('div', { class: 'track-title' }, t.title),
          h('span', { class: `badge ${t.kind === 'demo' ? 'gold' : ''}` }, t.kind === 'demo' ? '自编演示曲' : '我的文件'),
        ),
        h('div', { class: 'track-meta' },
          h('span', null, `⏱ ${fmt(bm.durationSec)}`),
          h('span', null, `🥁 ${bm.bpm} BPM`),
          h('span', null, `📏 ${bm.beatsPerBar}/4`),
          h('span', null, `🎹 ${bm.chords.length} 个和弦`),
        ),
        h('div', { class: 'chord-strip' },
          ...bm.chords.slice(0, 8).map((c) => h('span', { class: 'chord-chip' }, c.label)),
          bm.chords.length > 8 ? h('span', { class: 'chord-more' }, `+${bm.chords.length - 8}`) : null,
        ),
        h('div', { class: 'track-actions' },
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              await bootLibrary();
              store.selectTrack(t.id);
              engine.loadTrack(t);
              await engine.play();
            },
          }, '▶ 试听'),
          h('button', {
            class: 'btn',
            onclick: () => { store.selectTrack(t.id); engine.loadTrack(t); store.setPage('chords'); },
          }, '和弦拍点 →'),
        ),
      );
      list.appendChild(card);
    }
  }

  const bootBtn = h('button', {
    class: 'btn gold big', id: 'boot-btn',
    onclick: () => bootLibrary().catch(() => undefined),
  }, store.state.booted ? '音频引擎已启动 ✓' : '① 启动音频并生成演示曲');
  if (store.state.booted) bootBtn.classList.add('done');

  const whistleHint = h('div', { class: 'whistle-hint card' },
    h('div', { class: 'whistle-hint-title' }, '🪈 已内置 4 种自编空竹哨声'),
    h('div', { class: 'whistle-presets' },
      ...store.state.whistles.map((w) => h('span', { class: 'preset-pill' }, w.name)),
    ),
    h('div', { class: 'hint' }, '没有领夹麦也能在“实时效果”页选择演示哨声，完整体验跟踪—拉音—和声。'),
  );

  const el = h('div', { class: 'page import-page' },
    h('section', { class: 'hero' },
      h('h1', null, '把空竹的哨声，拉进配乐的和弦里'),
      h('p', { class: 'hero-sub' }, '领夹麦实时跟踪 · 抗风噪不跳八度 · 和弦拉音 · 三度五度和声 · 重拍颤音/回声 · 整场录制'),
      h('div', { class: 'hero-cta' }, bootBtn,
        h('button', { class: 'btn big', onclick: () => store.setPage('fx') }, '直接进实时效果 →')),
    ),
    h('section', { class: 'panel' },
      h('h2', null, '① 导入伴奏'),
      drop,
    ),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, '② 或选用自编伴奏曲目'),
        h('button', { class: 'btn small', onclick: () => bootLibrary().catch(() => undefined) }, '重新生成/分析')),
      list,
    ),
    whistleHint,
  );

  const unsub = store.subscribe(() => {
    renderTracks();
    const b = el.querySelector('#boot-btn');
    if (b) {
      b.textContent = store.state.booted ? '音频引擎已启动 ✓' : '① 启动音频并生成演示曲';
      b.classList.toggle('done', store.state.booted);
    }
    const wp = whistleHint.querySelector('.whistle-presets');
    if (wp && wp.children.length !== store.state.whistles.length) {
      wp.replaceChildren();
      appendChildren(wp as HTMLElement, store.state.whistles.map((w) => h('span', { class: 'preset-pill' }, w.name)));
    }
  });
  renderTracks();
  return { el, destroy: unsub };
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

void midiName;
