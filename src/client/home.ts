import { expiryLabel, shortLink } from "../shared/link-label";
import { GROUP_CAPACITY } from "../shared/room-state";
import { aurora, button, canShare, el, flashLabel, linkButton, mark, shareLink, sheet } from "./ui";

export interface Health {
  turn: string;
  createGate: boolean;
}

export async function loadHealth(): Promise<Health> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return { turn: "off", createGate: false };
    const body = await response.json() as Partial<Health>;
    return { turn: body.turn === "on" ? "on" : "off", createGate: body.createGate === true };
  } catch {
    return { turn: "off", createGate: false };
  }
}

interface CreatedRoom {
  path: string;
  expiresAt: number;
  kind?: "pair" | "group";
  capacity?: number;
}

export async function renderHome(root: HTMLElement): Promise<void> {
  const page = el("main", "home");
  const hero = el("div", "hero");
  hero.append(el("h1", "", "Звонок по ссылке"), el("p", "lede", `Для двоих или для компании до ${GROUP_CAPACITY} человек. Без записи разговора.`));

  const action = el("div", "action");
  const gate = el("input", "field");
  gate.type = "password";
  gate.autocomplete = "current-password";
  gate.placeholder = "Ключ создания";
  gate.setAttribute("aria-label", "Ключ создания комнаты");
  gate.hidden = true;
  const create = button("Создать ссылку", "primary", "video");
  create.classList.add("btn-hero");
  // The second, quieter button: the same thing for more than two people.
  const createGroup = button("Создать ссылку для конференции", "glass", "group");
  createGroup.classList.add("btn-group");
  const problem = el("p", "problem");
  problem.setAttribute("role", "status");
  problem.setAttribute("aria-live", "polite");
  const result = el("div", "result");
  action.append(gate, create, createGroup, problem, result);

  const about = aboutSheet();
  const more = button("Подробнее", "quiet");
  more.classList.add("more");
  more.addEventListener("click", () => about.showModal());
  page.append(aurora(), mark(), hero, action, more, about);
  // The page is drawn first. A slow network must not leave a blank screen while /api/health loads.
  root.replaceChildren(page);

  let gated = false;
  const make = async (group: boolean): Promise<void> => {
    create.disabled = true;
    createGroup.disabled = true;
    problem.textContent = "";
    const headers = new Headers();
    if (gated) headers.set("x-wirecall-gate", gate.value);
    const response = await fetch(group ? "/api/rooms?kind=group" : "/api/rooms", { method: "POST", headers }).catch(() => null);
    create.disabled = false;
    createGroup.disabled = false;
    if (!response) {
      problem.textContent = "Нет связи. Проверьте интернет";
      return;
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "failed" })) as { error?: string };
      problem.textContent = error.error === "gate"
        ? "Ключ не подошёл"
        : error.error === "rate" || error.error === "daily"
          ? "Слишком много ссылок. Подождите"
          : "Не получилось создать комнату";
      return;
    }
    const room = await response.json() as CreatedRoom;
    // The link is ready: the card takes the place of the buttons, so the screen keeps one main action.
    gate.hidden = true;
    create.hidden = true;
    createGroup.hidden = true;
    result.replaceChildren(linkCard(room));
    result.querySelector<HTMLElement>("a")?.focus();
  };
  create.addEventListener("click", () => void make(false));
  createGroup.addEventListener("click", () => void make(true));

  const health = await loadHealth();
  gated = health.createGate;
  gate.hidden = !gated || create.hidden;
}

function linkCard(room: CreatedRoom): HTMLElement {
  const url = new URL(room.path, location.origin).toString();
  const group = room.kind === "group";
  const card = el("section", "link-card glass");
  card.setAttribute("aria-label", group ? "Ссылка на конференцию" : "Ссылка на звонок");
  const short = el("p", "link-short", shortLink(url));
  // The whole address is only in the attribute and behind the buttons, never printed large.
  short.title = url;
  const term = expiryLabel(room.expiresAt, Date.now());
  const until = el("p", "note", group ? `До ${room.capacity ?? GROUP_CAPACITY} человек · ${term}` : term);
  const open = linkButton(group ? "Открыть конференцию" : "Открыть звонок", room.path);
  open.classList.add("open-call");
  const send = button(canShare() ? "Отправить ссылку" : "Скопировать", "glass", canShare() ? "share" : undefined);
  send.addEventListener("click", () => void shareLink(url, flashLabel(send)));
  card.append(short, until, open, send);
  return card;
}

/** Everything a person may want to know, in four short lines. Nothing here is needed to make a call. */
function aboutSheet(): HTMLDialogElement {
  const { dialog, body } = sheet("Как это работает");
  const list = el("ul", "about");
  for (const line of [
    "Звонок идёт напрямую между устройствами участников.",
    "Сервер только знакомит их. Разговор он не видит и не записывает.",
    `В конференции до ${GROUP_CAPACITY} человек: каждое устройство соединяется с каждым, и больше оно не потянет.`,
    "В закрытой сети, например рабочей, звонок может не собраться. Попробуйте другую сеть.",
    "Не сворачивайте браузер во время звонка: в фоне картинка и звук останавливаются.",
    "На iPhone: «Поделиться» → «На экран „Домой“», и сайт откроется одним касанием.",
  ]) list.append(el("li", "", line));
  body.append(list);
  return dialog;
}
