import { isRoomId } from "../shared/ids";
import { CallSession } from "./call-session";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("missing app");

if (!window.isSecureContext) {
  renderInsecure(app);
} else if (location.pathname.startsWith("/r/")) {
  const roomId = location.pathname.split("/")[2] ?? "";
  if (!isRoomId(roomId)) renderMissing(app);
  else void renderCall(app, roomId);
} else {
  void renderHome(app);
}

function renderInsecure(root: HTMLElement): void {
  root.replaceChildren(shell(`
    Wirecall открывается только по защищённой ссылке https.
    Адрес с http:// браузер не пускает к камере и микрофону.
  `, "Нужен HTTPS"));
}

async function renderHome(root: HTMLElement): Promise<void> {
  const health = await fetch("/api/health").then(async (response) => {
    if (!response.ok) return { turn: "off", createGate: false, p2pOnly: true };
    return response.json() as Promise<{ turn: "off" | "on"; createGate: boolean; p2pOnly: boolean }>;
  }).catch(() => ({ turn: "off" as const, createGate: false, p2pOnly: true }));

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
  if (health.createGate) card.append(gate, paragraph("Комнату можно создать, только зная ключ. Ссылка для входа отдельно."));
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Создать ссылку";
  const result = document.createElement("div");
  result.className = "stack";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const headers = new Headers();
    if (health.createGate) headers.set("x-wirecall-gate", gate.value);
    const response = await fetch("/api/rooms", { method: "POST", headers });
    button.disabled = false;
    result.replaceChildren();
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
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "Скопировать ссылку";
    copy.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      copy.textContent = "Скопировано";
    });
    const open = document.createElement("a");
    open.href = body.path;
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "Открыть звонок";
    open.append(openButton);
    const until = document.createElement("p");
    until.className = "note";
    until.textContent = `Ссылка действует до ${new Date(body.expiresAt).toLocaleString("ru-RU")}. Пока кто-то в комнате, срок продлевается.`;
    result.append(box, copy, open, until);
  });
  card.append(button, result);
  page.append(card, connectionDetails(health.turn));
  root.replaceChildren(page);
}

async function renderCall(root: HTMLElement, roomId: string): Promise<void> {
  const health = await fetch("/api/health").then(async (response) => response.ok ? response.json() as Promise<{ turn: string }> : { turn: "off" }).catch(() => ({ turn: "off" }));
  const page = document.createElement("section");
  page.className = "call";
  const banner = document.createElement("p");
  banner.className = "banner";
  banner.hidden = true;
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
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const status = document.createElement("p");
  status.className = "status";
  status.textContent = "Готовы войти";
  overlay.append(status);
  stage.append(remote, local, overlay);
  const controls = document.createElement("div");
  controls.className = "controls";
  const join = button("Войти в звонок");
  join.classList.add("wide");
  const issue = document.createElement("p");
  issue.className = "hint";
  issue.hidden = true;
  const audio = button("Включить звук");
  audio.classList.add("wide");
  audio.hidden = true;
  const mic = button("Микрофон");
  const cam = button("Камера");
  const flip = button("Другая камера");
  flip.classList.add("secondary");
  const diagButton = button("Диагностика");
  diagButton.classList.add("secondary");
  const upgrade = button("Вернуть видео");
  upgrade.classList.add("secondary", "wide");
  upgrade.hidden = true;
  const end = button("Завершить");
  end.classList.add("danger", "wide");
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Safari не держит звонок в фоне как телефон. Если закрыть экран или уйти в другое приложение, картинка и звук остановятся, пока вы не вернётесь. Иконка на домашнем экране — только ярлык, не входящий вызов.";
  const dialog = document.createElement("dialog");
  const diagList = document.createElement("div");
  diagList.className = "diag";
  const closeDiag = button("Закрыть");
  closeDiag.classList.add("secondary");
  closeDiag.addEventListener("click", () => dialog.close());
  dialog.append(heading("Диагностика"), diagList, closeDiag);
  controls.append(join, issue, audio, mic, cam, flip, diagButton, upgrade, end, hint);
  page.append(banner, stage, controls, dialog);
  root.replaceChildren(page);

  let session: CallSession | null = null;
  const ensure = () => {
    session ??= new CallSession(roomId, local, remote, {
      onStatus: (text) => {
        status.textContent = text;
      },
      onDiagnostics: (lines) => {
        diagList.replaceChildren(...lines.map((line) => {
          const row = document.createElement("div");
          row.textContent = line;
          return row;
        }));
        upgrade.hidden = !lines.some((line) => line.includes("только звук") || line.includes("экономия"));
      },
      onAudioBlocked: (blocked) => {
        audio.hidden = !blocked;
        banner.hidden = !blocked;
        banner.textContent = "Звук собеседника заблокирован. Нажмите «Включить звук».";
      },
      onMediaIssue: (reason) => {
        issue.hidden = reason === null;
        issue.textContent = reason === null ? "" : permissionHelp(reason);
        if (reason) join.hidden = false;
      },
      onEnded: (text) => {
        status.textContent = text;
        join.hidden = false;
        join.textContent = "Войти снова";
      },
      onWaiting: (waiting) => {
        if (waiting) status.textContent = "Ждём второго человека";
      },
    });
    return session;
  };

  join.addEventListener("click", async () => {
    join.hidden = true;
    await ensure().start();
    if (!join.hidden) return;
  });
  audio.addEventListener("click", () => {
    if (session) void session.playRemote();
  });
  mic.addEventListener("click", () => {
    if (!session) return;
    const enabled = session.toggleAudio();
    mic.textContent = enabled ? "Микрофон" : "Микрофон выключен";
    mic.setAttribute("aria-pressed", String(!enabled));
  });
  cam.addEventListener("click", () => {
    if (!session) return;
    const enabled = session.toggleVideo();
    cam.textContent = enabled ? "Камера" : "Камера выключена";
    cam.setAttribute("aria-pressed", String(!enabled));
  });
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
  if (health.turn !== "on") {
    banner.hidden = false;
    banner.textContent = "Релей TURN выключен. Если сети не пускают прямой звонок, соединение может не собраться.";
  }
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
