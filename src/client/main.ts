import { isRoomId } from "../shared/ids";
import { CallSession } from "./call-session";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("missing app");

function renderInsecure(root: HTMLElement): void {
  root.replaceChildren(shell(`
    Wirecall открывается только по защищённой ссылке https.
    Адрес с http:// браузер не пускает к камере и микрофону.
  `, "Нужен HTTPS"));
}

async function renderHome(root: HTMLElement): Promise<void> {
  const page = document.createElement("main");
  page.className = "shell";
  page.append(mark(), title("Звонок для двоих"), paragraph("Личная ссылка. Сервер только знакомит телефоны и не записывает разговор."));
  const card = document.createElement("section");
  card.className = "card stack";
  const gate = document.createElement("input");
  gate.type = "password";
  gate.autocomplete = "current-password";
  gate.placeholder = "Ключ создания";
  gate.setAttribute("aria-label", "Ключ создания комнаты");
  gate.hidden = true;
  const gateNote = paragraph("Комнату можно создать, только зная ключ. Ссылка для входа отдельно.");
  gateNote.hidden = true;
  const create = button("Создать ссылку");
  const result = document.createElement("div");
  result.className = "stack";
  result.setAttribute("aria-live", "polite");
  card.append(gate, gateNote, create, result);
  const details = document.createElement("div");
  page.append(card, details);
  // The page is drawn first. A slow network must not leave a blank screen while /api/health loads.
  root.replaceChildren(page);

  let gated = false;
  create.addEventListener("click", async () => {
    create.disabled = true;
    result.replaceChildren();
    const headers = new Headers();
    if (gated) headers.set("x-wirecall-gate", gate.value);
    const response = await fetch("/api/rooms", { method: "POST", headers }).catch(() => null);
    create.disabled = false;
    if (!response) {
      result.append(paragraph("Нет связи с сервером. Проверьте интернет и попробуйте ещё раз."));
      return;
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "failed" })) as { error?: string };
      result.append(paragraph(error.error === "gate" ? "Ключ не подошёл." : error.error === "rate" || error.error === "daily" ? "Слишком много новых ссылок. Подождите." : "Не удалось создать комнату."));
      return;
    }
    const body = await response.json() as { path: string; expiresAt: number };
    const url = new URL(body.path, location.origin).toString();
    const box = document.createElement("p");
    box.className = "link-box";
    box.textContent = url;
    const send = button(canShare() ? "Отправить ссылку" : "Скопировать ссылку");
    send.classList.add("secondary");
    send.addEventListener("click", () => void shareLink(url, send));
    const open = document.createElement("a");
    open.href = body.path;
    open.className = "button";
    open.textContent = "Открыть звонок";
    const until = document.createElement("p");
    until.className = "note";
    until.textContent = `Ссылка действует до ${new Date(body.expiresAt).toLocaleString("ru-RU")}. Пока кто-то в комнате, срок продлевается.`;
    result.append(box, open, send, until);
  });

  const health = await loadHealth();
  gated = health.createGate;
  gate.hidden = !gated;
  gateNote.hidden = !gated;
  details.replaceWith(connectionDetails(health.turn));
}

interface Health {
  turn: string;
  createGate: boolean;
}

async function loadHealth(): Promise<Health> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return { turn: "off", createGate: false };
    const body = await response.json() as Partial<Health>;
    return { turn: body.turn === "on" ? "on" : "off", createGate: body.createGate === true };
  } catch {
    return { turn: "off", createGate: false };
  }
}

function canShare(): boolean {
  return typeof navigator.share === "function";
}

/** iPhone and Mac open the system share sheet. Elsewhere the link goes to the clipboard. */
async function shareLink(url: string, control: HTMLButtonElement): Promise<void> {
  const label = control.querySelector<HTMLElement>(".ctl-label") ?? control;
  const original = label.textContent ?? "";
  const flash = (text: string): void => {
    label.textContent = text;
    window.setTimeout(() => {
      label.textContent = original;
    }, 2500);
  };
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

function renderCall(root: HTMLElement, roomId: string): void {
  const page = document.createElement("section");
  page.className = "call";
  page.dataset.phase = "idle";
  const stage = document.createElement("div");
  stage.className = "stage";
  const remote = document.createElement("video");
  remote.className = "remote";
  remote.setAttribute("playsinline", "");
  remote.autoplay = true;
  const local = document.createElement("video");
  local.className = "local";
  local.setAttribute("playsinline", "");
  local.muted = true;
  local.autoplay = true;
  stage.append(remote, local);

  const center = document.createElement("div");
  center.className = "center";
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  status.textContent = "Готовы войти";
  const join = button("Войти в звонок");
  join.classList.add("big");
  const issue = document.createElement("p");
  issue.className = "hint media-issue";
  issue.hidden = true;
  const audio = button("Включить звук");
  audio.classList.add("big", "unmute");
  audio.hidden = true;
  const retry = button("Переподключить");
  retry.classList.add("ghost", "retry");
  retry.hidden = true;
  const share = button(canShare() ? "Отправить ссылку" : "Скопировать ссылку");
  share.classList.add("ghost", "share");
  const upgrade = button("Вернуть видео");
  upgrade.classList.add("ghost", "upgrade");
  upgrade.hidden = true;
  const notice = document.createElement("p");
  notice.className = "hint notice";
  notice.hidden = true;
  const hint = document.createElement("p");
  hint.className = "hint lobby-hint";
  hint.textContent = "Safari не держит звонок в фоне как телефон. Если закрыть экран или уйти в другое приложение, картинка и звук остановятся, пока вы не вернётесь.";
  center.append(status, join, issue, audio, retry, share, notice, hint);

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.setAttribute("role", "toolbar");
  controls.setAttribute("aria-label", "Управление звонком");
  const mic = control("mic", "Микрофон");
  const cam = control("video", "Камера");
  mic.setAttribute("aria-pressed", "false");
  cam.setAttribute("aria-pressed", "false");
  const flip = control("flip", "Повернуть", "Другая камера");
  flip.hidden = true;
  const diagButton = control("signal", "Связь", "Диагностика");
  const end = control("phone", "Завершить");
  end.classList.add("danger");
  controls.append(mic, cam, flip, diagButton, end);

  const dialog = document.createElement("dialog");
  const diagList = document.createElement("div");
  diagList.className = "diag";
  const closeDiag = button("Закрыть");
  closeDiag.classList.add("secondary");
  closeDiag.addEventListener("click", () => dialog.close());
  dialog.append(heading("Диагностика"), diagList, closeDiag);
  // A tap on the dimmed area outside the sheet closes it, as on iPhone.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  page.append(stage, upgrade, center, controls, dialog);
  root.replaceChildren(page);
  // The call screen is always dark. Safari tints its bars to match instead of the paper colour of the home page.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", "#0f0e0c");

  let fitFlipped = false;
  const fitRemote = (): void => {
    if (!remote.videoWidth || !remote.videoHeight) return;
    // A portrait iPhone picture on a wide Mac window is shown whole, not cropped to a strip of forehead.
    const videoTall = remote.videoHeight > remote.videoWidth;
    const stageTall = stage.clientHeight > stage.clientWidth;
    remote.classList.toggle("contain", (videoTall !== stageTall) !== fitFlipped);
  };
  // A tap on the picture switches between the whole frame and a full-screen crop.
  stage.addEventListener("click", () => {
    if (page.dataset.phase !== "live") return;
    fitFlipped = !fitFlipped;
    fitRemote();
  });
  remote.addEventListener("resize", fitRemote);
  remote.addEventListener("loadedmetadata", fitRemote);
  window.addEventListener("resize", fitRemote);

  let session: CallSession | null = null;
  const ensure = () => {
    session ??= new CallSession(roomId, local, remote, {
      onStatus: (text) => {
        status.textContent = text;
      },
      onDiagnostics: (lines) => {
        diagList.replaceChildren(...lines.map((line) => {
          const row = document.createElement("div");
          const split = line.indexOf(": ");
          const name = document.createElement("span");
          name.textContent = split < 0 ? line : line.slice(0, split);
          const value = document.createElement("b");
          value.textContent = split < 0 ? "" : line.slice(split + 2);
          row.append(name, value);
          return row;
        }));
        upgrade.hidden = !lines.some((line) => line.includes("только звук") || line.includes("экономия"));
      },
      onAudioBlocked: (blocked) => {
        audio.hidden = !blocked;
      },
      onMediaIssue: (reason) => {
        issue.hidden = reason === null;
        issue.textContent = reason === null ? "" : permissionHelp(reason);
      },
      onEnded: (text) => {
        status.textContent = text;
        join.textContent = "Войти снова";
        audio.hidden = true;
        upgrade.hidden = true;
        if (dialog.open) dialog.close();
      },
      onWaiting: (waiting) => {
        status.textContent = waiting ? "Ждём второго человека" : "Соединяем";
      },
      onPhase: (phase) => {
        page.dataset.phase = phase;
        retry.hidden = phase !== "trouble";
      },
      onCameras: (count) => {
        flip.hidden = count < 2;
      },
    });
    return session;
  };

  join.addEventListener("click", () => {
    page.dataset.phase = "starting";
    void ensure().start();
  });
  audio.addEventListener("click", () => {
    if (session) void session.playRemote();
  });
  retry.addEventListener("click", () => session?.retry());
  share.addEventListener("click", () => void shareLink(location.href, share));
  const toggleMic = (): void => {
    if (!session) return;
    const enabled = session.toggleAudio();
    setControl(mic, enabled, "Микрофон", "Выключен", "Микрофон выключен");
  };
  const toggleCam = (): void => {
    if (!session) return;
    const enabled = session.toggleVideo();
    setControl(cam, enabled, "Камера", "Выключена", "Камера выключена");
    local.classList.toggle("off", !enabled);
  };
  mic.addEventListener("click", toggleMic);
  cam.addEventListener("click", toggleCam);
  flip.addEventListener("click", () => {
    if (session) void session.switchCamera();
  });
  upgrade.addEventListener("click", () => {
    if (session) void session.requestUpgrade();
  });
  end.addEventListener("click", () => {
    if (session) session.hangup();
  });
  diagButton.addEventListener("click", () => dialog.showModal());
  // On a Mac the keyboard is closer than the pointer: M mutes, V turns the camera off.
  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || dialog.open) return;
    const phase = page.dataset.phase;
    if (phase === "idle" || phase === "ended" || phase === "starting") return;
    const key = event.key.toLowerCase();
    if (key === "m" || key === "ь") toggleMic();
    else if (key === "v" || key === "м") toggleCam();
  });

  void loadHealth().then((health) => {
    if (health.turn === "on") return;
    notice.hidden = false;
    notice.textContent = "Релей TURN выключен. Если сети не пускают прямой звонок, соединение может не собраться.";
  });
}

function setControl(node: HTMLButtonElement, enabled: boolean, label: string, offLabel: string, offName: string): void {
  node.setAttribute("aria-pressed", String(!enabled));
  node.setAttribute("aria-label", enabled ? label : offName);
  const text = node.querySelector(".ctl-label");
  if (text) text.textContent = enabled ? label : offLabel;
}

const ICONS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 11v1a7 7 0 0 1-14 0v-1"/><path d="M12 19v3"/>',
  video: '<path d="M22 8l-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2.5"/>',
  flip: '<path d="M21 4v6h-6"/><path d="M3 20v-6h6"/><path d="M4.5 9a8 8 0 0 1 13.2-3L21 10M3 14l3.3 4a8 8 0 0 0 13.2-3"/>',
  signal: '<path d="M6 20v-5"/><path d="M12 20V10"/><path d="M18 20V4"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
} as const;

/** A round call button: icon on top, a short word below, the full name for screen readers. */
function control(icon: keyof typeof ICONS, label: string, name = label): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `ctl ctl-${icon}`;
  node.setAttribute("aria-label", name);
  const disc = document.createElement("span");
  disc.className = "ctl-icon";
  disc.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[icon]}<path class="slash" d="M3 3l18 18"/></svg>`;
  const text = document.createElement("span");
  text.className = "ctl-label";
  text.textContent = label;
  node.append(disc, text);
  return node;
}

function renderMissing(root: HTMLElement): void {
  root.replaceChildren(shell("Ссылка комнаты повреждена. Попросите прислать её ещё раз.", "Комната не найдена"));
}

function connectionDetails(turn: string): HTMLElement {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Про связь и интернет";
  const text = document.createElement("div");
  text.className = "stack";
  const p2p = document.createElement("p");
  p2p.textContent = turn === "on"
    ? "Релей Cloudflare TURN включён на сервере. Прямое соединение всё равно используется, когда оно возможно. Исходящий трафик TURN может тарифицироваться: в документации Realtime указаны 1000 ГБ в месяц бесплатно вместе с SFU и затем $0.05/ГБ, но страница TURN формулирует цену иначе. Жёсткого потолка расходов нет."
    : "Сейчас только прямое соединение и бесплатный STUN Cloudflare. Сервер не пропускает через себя видео и звук. Если у одного из вас закрытая сеть, звонок может не собраться, пока человек, который размещает сайт, не включит TURN.";
  const bg = document.createElement("p");
  bg.textContent = "Добавить сайт на экран «Домой» можно через «Поделиться» в Safari. Это ярлык. Входящих звонков в заблокированном телефоне не будет: Safari так не умеет.";
  text.append(p2p, bg);
  details.append(summary, text);
  return details;
}

function permissionHelp(reason: "denied" | "missing" | "busy" | "failed"): string {
  if (reason === "denied") {
    return "Разрешите камеру и микрофон для этого сайта. На iPhone: Настройки → Safari → Камера и Микрофон → Разрешить, затем вернитесь и нажмите «Войти снова».";
  }
  if (reason === "missing") return "Устройство не показало камеру или микрофон. Можно проверить, подключён ли микрофон, и войти снова.";
  if (reason === "busy") return "Камера или микрофон заняты другим приложением. Закройте его и войдите снова.";
  return "Не получилось открыть камеру и микрофон. Войдите ещё раз.";
}

function shell(text: string, headingText: string): HTMLElement {
  const page = document.createElement("main");
  page.className = "shell";
  page.append(mark(), title(headingText), paragraph(text));
  return page;
}

function mark(): HTMLElement {
  const node = document.createElement("p");
  node.className = "mark";
  const icon = document.createElement("i");
  icon.textContent = "W";
  node.append(icon, document.createTextNode("Wirecall"));
  return node;
}

function title(text: string): HTMLElement {
  const node = document.createElement("h1");
  node.textContent = text;
  return node;
}

function heading(text: string): HTMLElement {
  const node = document.createElement("h2");
  node.textContent = text;
  return node;
}

function paragraph(text: string): HTMLElement {
  const node = document.createElement("p");
  node.className = "lede";
  node.textContent = text;
  return node;
}

function button(text: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  return node;
}

// Runs last: the screens above use constants that must exist before the first render.
if (!window.isSecureContext) {
  renderInsecure(app);
} else if (location.pathname.startsWith("/r/")) {
  const roomId = location.pathname.split("/")[2] ?? "";
  if (!isRoomId(roomId)) renderMissing(app);
  else renderCall(app, roomId);
} else {
  void renderHome(app);
}
