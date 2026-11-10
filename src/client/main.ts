import { isRoomId } from "../shared/ids";
import { START_TIER, type QualityTier } from "../shared/adaptive";
import { qualityBadge } from "../shared/quality-label";
import { CallSession } from "./call-session";
import { loadHealth, renderHome } from "./home";
import { button as uiButton, canShare, el, flashLabel, ICONS, linkButton, messageScreen, shareLink, watchPageVisibility } from "./ui";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("missing app");

function button(text: string): HTMLButtonElement {
  return uiButton(text);
}

function heading(text: string): HTMLElement {
  return el("h2", "", text);
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
  const notice = document.createElement("p");
  notice.className = "hint notice";
  notice.hidden = true;
  const hint = document.createElement("p");
  hint.className = "hint lobby-hint";
  hint.textContent = "Safari не держит звонок в фоне как телефон. Если закрыть экран или уйти в другое приложение, картинка и звук остановятся, пока вы не вернётесь.";
  // The badge is always on screen during a call: bars plus words, so the meaning never rests on colour alone.
  const quality = document.createElement("p");
  quality.className = "quality";
  quality.setAttribute("role", "status");
  quality.setAttribute("aria-live", "polite");
  quality.setAttribute("aria-atomic", "true");
  const bars = document.createElement("span");
  bars.className = "quality-bars";
  bars.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) bars.append(document.createElement("i"));
  const qualityWords = document.createElement("span");
  qualityWords.className = "quality-words";
  const qualityText = document.createElement("span");
  qualityText.className = "quality-text";
  const peerText = document.createElement("span");
  peerText.className = "quality-peer";
  peerText.hidden = true;
  qualityWords.append(qualityText, peerText);
  quality.append(bars, qualityWords);
  const showQuality = (tier: QualityTier, peerTier: QualityTier | null): void => {
    const badge = qualityBadge(tier, peerTier);
    quality.dataset.tier = tier;
    quality.dataset.bars = String(badge.bars);
    if (qualityText.textContent !== badge.text) qualityText.textContent = badge.text;
    const peer = badge.peerText ?? "";
    if (peerText.textContent !== peer) peerText.textContent = peer;
    peerText.hidden = badge.peerText === null;
  };
  showQuality(START_TIER, null);
  center.append(status, quality, join, issue, audio, retry, share, notice, hint);

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
  const diagButton = control("more", "Связь", "Диагностика");
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
  page.append(stage, center, controls, dialog);
  root.replaceChildren(page);
  // The call screen is always dark. Safari tints its bars to match instead of the paper colour of the home page.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", "#000000");

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
        if (dialog.open) dialog.close();
      },
      onWaiting: (waiting) => {
        status.textContent = waiting ? "Ждём второго человека" : "Соединяем";
      },
      onPhase: (phase) => {
        page.dataset.phase = phase;
        retry.hidden = phase !== "trouble";
      },
      onQuality: showQuality,
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
  share.addEventListener("click", () => void shareLink(location.href, flashLabel(share)));
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

function permissionHelp(reason: "denied" | "missing" | "busy" | "failed"): string {
  if (reason === "denied") return "Разрешите доступ к камере и микрофону. На iPhone: Настройки → Safari → Камера и Микрофон → Разрешить.";
  if (reason === "missing") return "Проверьте, подключены ли камера и микрофон, и войдите снова.";
  if (reason === "busy") return "Закройте приложение, которое держит камеру или микрофон, и войдите снова.";
  return "Не получилось открыть камеру и микрофон. Войдите ещё раз.";
}

// Runs last: the screens above use constants that must exist before the first render.
watchPageVisibility();
if (!window.isSecureContext) {
  app.replaceChildren(messageScreen("Нужен HTTPS", "Откройте ссылку, которая начинается с https://."));
} else if (location.pathname.startsWith("/r/")) {
  const roomId = location.pathname.split("/")[2] ?? "";
  if (!isRoomId(roomId)) app.replaceChildren(messageScreen("Комната не найдена", "Попросите прислать ссылку ещё раз.", linkButton("На главную", "/")));
  else renderCall(app, roomId);
} else {
  void renderHome(app);
}
