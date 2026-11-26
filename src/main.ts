// 应用入口：导航、页面挂载、Toast、测试钩子
import './styles.css';
import { h } from './ui/dom';
import { store } from './state/store';
import { engine } from './audio/engine';
import { bootLibrary } from './services/library';
import { runBrowserSelfTest } from './test/selftest';
import { createImportPage } from './ui/importPage';
import { createChordsPage } from './ui/chordsPage';
import { createFxPage } from './ui/fxPage';
import { createRecordPage } from './ui/recordPage';
import type { PageId } from './types';

const TABS: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'import', label: '伴奏导入', icon: '📥' },
  { id: 'chords', label: '和弦拍点', icon: '🎼' },
  { id: 'fx', label: '实时效果', icon: '🎛️' },
  { id: 'record', label: '演出录制', icon: '⏺️' },
];

let currentDestroy: (() => void) | null = null;
const pageHost = h('main', { class: 'page-host', id: 'page-host' });

function mountPage(page: PageId) {
  currentDestroy?.();
  pageHost.replaceChildren();
  let created: { el: HTMLElement; destroy(): void };
  if (page === 'import') created = createImportPage();
  else if (page === 'chords') created = createChordsPage();
  else if (page === 'fx') created = createFxPage();
  else created = createRecordPage();
  pageHost.appendChild(created.el);
  currentDestroy = created.destroy;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.page === page));
}

const nav = h('nav', { class: 'nav' },
  ...TABS.map((t) => h('button', {
    class: 'nav-btn', dataset: { page: t.id },
    onclick: () => store.setPage(t.id),
  }, h('span', { class: 'nav-icon' }, t.icon), h('span', null, t.label))),
);

const bootTopBtn = h('button', {
  class: 'btn gold small', id: 'top-boot',
  onclick: () => bootLibrary().catch(() => undefined),
}, store.state.booted ? '音频已就绪 ✓' : '启动音频');

const header = h('header', { class: 'topbar' },
  h('div', { class: 'brand' }, h('span', { class: 'logo' }, '🌀'), h('div', null, h('div', { class: 'brand-name' }, '空竹和鸣'), h('div', { class: 'brand-sub' }, 'Diabolo Harmony Station'))),
  nav,
  h('div', { class: 'top-right' }, statusDot(), bootTopBtn),
);

function statusDot() {
  const dot = h('span', { class: 'status-dot', id: 'engine-dot', title: '音频引擎状态' });
  return dot;
}

const toastHost = h('div', { class: 'toast-host', id: 'toast-host' });

const app = h('div', { class: 'app-shell' }, header, pageHost, toastHost);
document.querySelector('#app')!.appendChild(app);

function renderToasts() {
  toastHost.replaceChildren(...store.state.toasts.map((t) =>
    h('div', { class: `toast ${t.kind}` },
      h('span', null, t.text),
      h('button', { class: 'toast-x', onclick: () => store.dismissToast(t.id) }, '×')),
  ));
}

function updateChrome() {
  bootTopBtn.textContent = store.state.booted ? '音频已就绪 ✓' : '启动音频';
  bootTopBtn.classList.toggle('done', store.state.booted);
  const dot = document.querySelector('#engine-dot');
  if (dot) dot.classList.toggle('on', store.state.ctxReady);
  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.page === store.state.page));
}

let mountedPage: PageId | null = null;
store.subscribe(() => {
  // 只在真正切换页面时重挂载；Toast / 数据变化由各页自行局部刷新
  if (store.state.page !== mountedPage) {
    mountedPage = store.state.page;
    mountPage(store.state.page);
  }
  renderToasts();
  updateChrome();
});

// 首次挂载
mountedPage = store.state.page;
mountPage(store.state.page);
renderToasts();
updateChrome();

// 浏览器/自动化测试钩子
declare global {
  interface Window {
    __diabolo?: unknown;
  }
}
window.__diabolo = {
  store,
  engine,
  bootLibrary,
  runBrowserSelfTest,
  async selftest() {
    const r = await runBrowserSelfTest();
    store.set({ selftest: r });
    return r;
  },
};
