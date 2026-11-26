// 无头 Chrome 端到端验证：启动 vite preview，跑浏览器自检 + UI 流程 + 拍点精度 + 录制。
// 运行：node scripts/browser-selftest.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 47831;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOT_DIR = path.join(ROOT, 'shots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

function waitServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(url, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 4000) res.destroy(); });
        res.on('end', () => {
          if (body.includes('空竹和鸣')) resolve();
          else retry();
        });
        res.on('error', retry);
      }).on('error', retry);
      function retry() {
        if (Date.now() - start > timeoutMs) reject(new Error('server timeout / wrong app on port'));
        else setTimeout(tick, 400);
      }
    };
    tick();
  });
}

let server = null;
if (!process.env.BASE_URL) {
  server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, shell: process.platform === 'win32', stdio: 'ignore',
  });
  await waitServer(BASE);
}

const browser = await puppeteer.launch({
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  headless: 'new',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-file-access-from-files',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

const results = { consoleErrors: [], pageErrors: [], selftest: null, pitch: null, beatTiming: null, recording: null, ui: {} };
let code = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => results.pageErrors.push(String(e).slice(0, 400)));

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.nav-btn', { timeout: 15000 });
  await page.screenshot({ path: path.join(SHOT_DIR, '01-import.png') });

  // 启动音频 + 生成/分析演示曲
  await page.click('#top-boot').catch(() => page.click('#boot-btn'));
  await page.waitForFunction('window.__diabolo && window.__diabolo.store.state.booted === true', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 800));
  results.ui.trackCount = await page.evaluate('window.__diabolo.store.state.tracks.length');
  console.log('演示曲目数:', results.ui.trackCount);

  // 跑浏览器自检
  console.log('运行浏览器算法自检（可能需要 20-40s）…');
  await page.evaluate('window.__st = null; window.__diabolo.selftest().then(r => { window.__st = r; }).catch(e => { window.__st = { error: String(e) }; })');
  await page.waitForFunction('window.__st !== null', { timeout: 180000, polling: 1000 });
  results.selftest = await page.evaluate('window.__st');
  if (results.selftest?.checks) {
    for (const c of results.selftest.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.name} — ${c.detail}`);
  } else {
    console.log('自检异常:', JSON.stringify(results.selftest));
  }

  // ---- 实时效果页：选演示哨声，验证音高表 ----
  await page.click('[data-page="fx"]');
  await new Promise((r) => setTimeout(r, 400));
  await page.select('#fx-source', 'whistle-clear');
  // 等待音高出现
  try {
    await page.waitForFunction(`(() => {
      const el = document.querySelector('#pitch-note');
      return el && el.textContent.trim() !== '–';
    })()`, { timeout: 20000, polling: 500 });
    results.pitch = await page.evaluate(`(() => ({
      note: document.querySelector('#pitch-note').textContent,
      cents: document.querySelector('#pitch-cents').textContent,
      voiced: document.querySelector('#voiced-pill').textContent,
      target: document.querySelector('#target-note').textContent,
      h3: document.querySelector('#h3-note').textContent,
      h5: document.querySelector('#h5-note').textContent,
    }))()`);
    console.log('实时音高:', JSON.stringify(results.pitch));
  } catch {
    results.pitch = { error: 'pitch timeout' };
    console.log('音高表未在超时内出现');
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '02-fx.png') });

  // ---- 真实播放时，重拍效果调度时间 vs 分析拍点映射时间 ----
  await page.evaluate(`(() => {
    window.__beatErrs = [];
    const e = window.__diabolo.engine;
    const orig = e.triggerBeatFx.bind(e);
    e.triggerBeatFx = function (t, mode, amt) {
      try {
        const acc = e.accentTimes();
        let best = 1e9;
        for (const bt of acc) {
          const ct = e.startCtxTime + (bt - e.startOffset);
          best = Math.min(best, Math.abs(ct - t) * 1000);
        }
        window.__beatErrs.push(Math.round(best * 1000) / 1000);
      } catch (_) { /* ignore */ }
      return orig(t, mode, amt);
    };
  })()`);
  await page.click('#fx-accomp-play');
  await new Promise((r) => setTimeout(r, 5200));
  results.beatSchedule = await page.evaluate(`(() => ({
    count: window.__beatErrs.length,
    maxErrMs: window.__beatErrs.length ? Math.max(...window.__beatErrs) : null,
    errs: window.__beatErrs.slice(0, 10),
  }))()`);
  console.log('重拍调度精度:', JSON.stringify(results.beatSchedule));

  // ---- 拍点精度：分析重拍 vs 理想 BPM 网格 ----
  results.beatTiming = await page.evaluate(`(() => {
    const d = window.__diabolo;
    const t = d.store.currentTrack();
    if (!t) return { error: 'no track' };
    const bm = t.beatmap;
    const idealBeat = 60 / (t.expected?.bpm || bm.bpm);
    // 以第一个 downbeat 为相位，比较后续 downbeat 与理想小节网格
    const dbs = bm.downbeats;
    const bpb = bm.beatsPerBar;
    let maxMs = 0; const devs = [];
    for (let k = 0; k < dbs.length; k++) {
      const ideal = dbs[0] + k * bpb * idealBeat;
      const ms = (dbs[k] - ideal) * 1000;
      devs.push(Math.round(ms * 10) / 10);
      maxMs = Math.max(maxMs, Math.abs(ms));
    }
    // 调度映射误差（构造上为 0，这里显式验证）
    const when = d.engine.ctx.currentTime + 0.1;
    const offset = 0;
    let mapErr = 0;
    for (const bt of bm.downbeats.slice(0, 20)) {
      const scheduledCtx = when + (bt - offset);
      const reverseBuffer = offset + (scheduledCtx - when);
      mapErr = Math.max(mapErr, Math.abs(reverseBuffer - bt) * 1000);
    }
    return { bpm: bm.bpm, expectedBpm: t.expected?.bpm, downbeats: dbs.length, maxGridDeviationMs: Math.round(maxMs * 10) / 10, mapErrMs: mapErr, devs: devs.slice(0, 8) };
  })()`);
  console.log('拍点精度:', JSON.stringify(results.beatTiming));

  // ---- 和弦拍点页截图 ----
  await page.click('[data-page="chords"]');
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: path.join(SHOT_DIR, '03-chords.png') });

  // ---- 录制页：录 2.5s 并验证 take ----
  await page.click('[data-page="record"]');
  await new Promise((r) => setTimeout(r, 400));
  await page.click('#record-btn');
  await new Promise((r) => setTimeout(r, 2800));
  await page.click('#record-btn');
  await page.waitForFunction('document.querySelectorAll(".take-card").length > 0', { timeout: 20000, polling: 500 });
  await new Promise((r) => setTimeout(r, 600));
  results.recording = await page.evaluate(`(() => {
    const card = document.querySelector('.take-card');
    const audio = card?.querySelector('audio');
    return { takes: window.__diabolo.engine.takes.length, size: window.__diabolo.engine.takes[0]?.size, duration: window.__diabolo.engine.takes[0]?.durationSec, hasAudio: !!audio, src: audio?.src?.slice(0, 40) };
  })()`);
  console.log('录制:', JSON.stringify(results.recording));
  await page.screenshot({ path: path.join(SHOT_DIR, '04-record.png') });

  // ---- 判定 ----
  const st = results.selftest;
  const selfFail = st?.failed ?? 1;
  const pitchOk = results.pitch && !results.pitch.error && results.pitch.note !== '–';
  const beatOk = results.beatTiming && results.beatTiming.maxGridDeviationMs <= 30;
  const schedOk = results.beatSchedule && results.beatSchedule.count >= 1 && results.beatSchedule.maxErrMs <= 30;
  const recOk = results.recording && results.recording.takes > 0 && results.recording.size > 1000;
  const noPageErrors = results.pageErrors.length === 0;
  code = selfFail === 0 && pitchOk && beatOk && schedOk && recOk && noPageErrors ? 0 : 1;
  results.verdict = { selfFail, pitchOk, beatOk, schedOk, recOk, noPageErrors };
  console.log('判定:', JSON.stringify(results.verdict));
  if (results.pageErrors.length) console.log('页面异常:', results.pageErrors);
  if (results.consoleErrors.length) console.log('console.error:', results.consoleErrors.slice(0, 5));
} catch (e) {
  console.error('BROWSER TEST ERROR', e);
  code = 2;
} finally {
  fs.writeFileSync(path.join(ROOT, 'browser-selftest-result.json'), JSON.stringify(results, null, 2));
  await browser.close();
  server?.kill();
  process.exit(code);
}
