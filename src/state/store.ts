// 应用级状态：曲目库、哨声音色、当前页、提示、自检结果
import type { PageId, Track, WhistlePreset } from '../types';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'err';
}

interface AppState {
  page: PageId;
  booted: boolean;
  tracks: Track[];
  currentTrackId: string | null;
  whistles: WhistlePreset[];
  ctxReady: boolean;
  toasts: Toast[];
  selftest: SelftestSummary | null;
  showSelftest: boolean;
}

export interface SelftestCheck {
  name: string;
  pass: boolean;
  detail: string;
}
export interface SelftestSummary {
  ranAt: number;
  checks: SelftestCheck[];
  passed: number;
  failed: number;
  durationMs: number;
}

type Listener = () => void;

class Store {
  state: AppState = {
    page: 'import',
    booted: false,
    tracks: [],
    currentTrackId: null,
    whistles: [],
    ctxReady: false,
    toasts: [],
    selftest: null,
    showSelftest: false,
  };
  private listeners = new Set<Listener>();
  private toastId = 1;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    this.listeners.forEach((f) => f());
  }
  set(patch: Partial<AppState>) {
    Object.assign(this.state, patch);
    this.emit();
  }
  setPage(page: PageId) {
    this.set({ page });
  }
  currentTrack(): Track | null {
    return this.state.tracks.find((t) => t.id === this.state.currentTrackId) ?? this.state.tracks[0] ?? null;
  }
  setTracks(tracks: Track[]) {
    this.state.tracks = tracks;
    if (!this.state.currentTrackId && tracks[0]) this.state.currentTrackId = tracks[0].id;
    this.emit();
  }
  addTrack(t: Track) {
    this.state.tracks = [t, ...this.state.tracks];
    this.state.currentTrackId = t.id;
    this.emit();
  }
  selectTrack(id: string) {
    this.state.currentTrackId = id;
    this.emit();
  }
  toast(text: string, kind: Toast['kind'] = 'info', timeout = 3200) {
    const id = this.toastId++;
    this.state.toasts = [...this.state.toasts, { id, text, kind }];
    this.emit();
    if (timeout > 0) {
      setTimeout(() => this.dismissToast(id), timeout);
    }
  }
  dismissToast(id: number) {
    this.state.toasts = this.state.toasts.filter((t) => t.id !== id);
    this.emit();
  }
}

export const store = new Store();
