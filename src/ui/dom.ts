// 极简 hyperscript 辅助
export type VChild = Node | string | number | false | null | undefined | VChild[];

type Props<K extends keyof HTMLElementTagNameMap> =
  & Partial<Omit<HTMLElementTagNameMap[K], 'style'>>
  & { class?: string; style?: string | CSSStyleDeclaration; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<K> | null,
  ...children: VChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
      else if (k === 'dataset' && typeof v === 'object') {
        for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'value') {
        (el as HTMLInputElement).value = String(v);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (el as any)[k] = v;
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el: HTMLElement, children: VChild[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtMs(sec: number): string {
  return `${(sec * 1000).toFixed(0)}ms`;
}
