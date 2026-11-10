/** Small DOM helpers shared by every screen. No framework: plain elements with class names from styles.css. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export const ICONS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 11v1a7 7 0 0 1-14 0v-1"/><path d="M12 19v3"/>',
  video: '<path d="M22 8l-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2.5"/>',
  flip: '<path d="M21 4v6h-6"/><path d="M3 20v-6h6"/><path d="M4.5 9a8 8 0 0 1 13.2-3L21 10M3 14l3.3 4a8 8 0 0 0 13.2-3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  share: '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  group: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.2a6.5 6.5 0 0 1 3 5.8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** The markup is a constant from the table above, never text that came from the network. */
export function iconSvg(name: IconName, extra = ""): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}${extra}</svg>`;
}

export function icon(name: IconName): HTMLElement {
  const node = el("span", "icon");
  node.innerHTML = iconSvg(name);
  return node;
}

export type ButtonKind = "primary" | "glass" | "quiet";

export function button(text: string, kind: ButtonKind = "primary", iconName?: IconName): HTMLButtonElement {
  const node = el("button", `btn btn-${kind}`);
  node.type = "button";
  if (iconName) node.append(icon(iconName));
  node.append(el("span", "btn-label", text));
  return node;
}

export function linkButton(text: string, href: string, kind: ButtonKind = "primary"): HTMLAnchorElement {
  const node = el("a", `btn btn-${kind}`);
  node.href = href;
  node.append(el("span", "btn-label", text));
  return node;
}

export function mark(): HTMLElement {
  const node = el("p", "mark");
  const badge = el("i", "", "W");
  badge.setAttribute("aria-hidden", "true");
  node.append(badge, document.createTextNode("Wirecall"));
  return node;
}

/**
 * The drifting background: four soft colour spots and a grain layer. It is pure CSS, moves only by
 * transform, stops while the tab is hidden (see watchPageVisibility) and stands still under reduced motion.
 */
export function aurora(dim = false): HTMLElement {
  const node = el("div", dim ? "aurora dim" : "aurora");
  node.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) node.append(el("i"));
  node.append(el("b"));
  return node;
}

/** A hidden tab must not keep animating. The class pauses every background animation in CSS. */
export function watchPageVisibility(): void {
  const sync = (): void => {
    document.documentElement.classList.toggle("page-hidden", document.hidden);
  };
  document.addEventListener("visibilitychange", sync);
  sync();
}

/** One heading, one short phrase, at most one main action, on the drifting background. */
export function messageScreen(headingText: string, text: string, action?: HTMLElement): HTMLElement {
  const page = el("main", "screen");
  const body = el("div", "screen-body");
  body.append(el("h1", "", headingText), el("p", "lede", text));
  if (action) body.append(action);
  page.append(aurora(true), mark(), body);
  return page;
}

export interface Sheet {
  dialog: HTMLDialogElement;
  body: HTMLElement;
}

/** A glass sheet over the page. A tap on the dimmed area outside closes it, as on iPhone. */
export function sheet(titleText: string): Sheet {
  const dialog = el("dialog", "sheet");
  const body = el("div", "sheet-body");
  const close = button("Закрыть", "glass");
  close.addEventListener("click", () => dialog.close());
  dialog.append(el("h2", "", titleText), body, close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  return { dialog, body };
}

export function canShare(): boolean {
  return typeof navigator.share === "function";
}

/** iPhone and Mac open the system share sheet. Elsewhere the link goes to the clipboard. */
export async function shareLink(url: string, flash: (text: string) => void): Promise<void> {
  if (canShare()) {
    try {
      await navigator.share({ title: "Wirecall", url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    flash("Скопировано");
  } catch {
    flash("Не удалось скопировать");
  }
}

/** Shows a short word on the button and puts the old one back. */
export function flashLabel(control: HTMLElement): (text: string) => void {
  const label = control.querySelector<HTMLElement>(".btn-label") ?? control;
  const original = label.textContent ?? "";
  let timer = 0;
  return (text) => {
    label.textContent = text;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      label.textContent = original;
    }, 2500);
  };
}

export function isIPhone(): boolean {
  return /iPhone|iPod/u.test(navigator.userAgent);
}
