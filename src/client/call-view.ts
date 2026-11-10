import { START_TIER, type QualityTier } from "../shared/adaptive";
import { autoHideDelay, isWeakTier, mayAutoHide, mayHide, type ChromeContext, type InputKind } from "../shared/chrome-visibility";
import { gridLayout, type Rect } from "../shared/grid";
import { qualityBadge } from "../shared/quality-label";
import { GROUP_CAPACITY, PAIR_CAPACITY } from "../shared/room-state";
import {
  clampToBox,
  CORNER_STORAGE_KEY,
  cornerPosition,
  defaultCorner,
  isPhone,
  nearestCorner,
  parseCorner,
  safeBox,
  selfSize,
  type Box,
  type Corner,
  type Point,
  type Size,
} from "../shared/self-view";
import { CallSession, type CallPhase, type RemotePeer } from "./call-session";
import { aurora, button, canShare, el, flashLabel, iconSvg, isIPhone, linkButton, shareLink, sheet, type IconName } from "./ui";

type MediaIssue = "denied" | "missing" | "busy" | "failed";

/** Margin between the «me» window and the screen edge, and between it and a panel. */
const SELF_EDGE = 12;
const SELF_GAP = 12;
/** A finger that moved less than this tapped the window, it did not drag it. */
const DRAG_START_PX = 6;
/** A transient note in a live call («Не удалось переключить камеру») steps aside by itself. */
const LIVE_NOTE_MS = 6_000;
/** After a click hides the controls the cursor still trembles. That is not a request to show them again. */
const MOVE_QUIET_MS = 600;
/** Space between the pictures of a conference, and between them and the screen edge. */
const GRID_GAP = 6;

/** One other person on the stage: the frame that is moved and sized, the picture, a line about the connection. */
interface Tile {
  root: HTMLElement;
  video: HTMLVideoElement;
  note: HTMLElement;
}

/** `group` is what the link says: a room for two or a conference. The room confirms it when it lets the person in. */
export function renderCall(root: HTMLElement, roomId: string, group = false): void {
  let capacity = group ? GROUP_CAPACITY : PAIR_CAPACITY;
  const isGroup = (): boolean => capacity > PAIR_CAPACITY;
  const page = el("section", "call");
  page.dataset.phase = "idle";
  page.dataset.ui = "shown";
  page.dataset.preview = "off";

  // One tile per other person. With one, it fills the screen; with more, they share it as a grid.
  const stage = el("div", "stage");
  stage.dataset.layout = "single";
  const tiles = new Map<string, Tile>();

  // The wrapper is moved and sized; the video inside keeps its own mirror transform.
  const self = el("div", "self");
  const local = el("video", "local");
  local.setAttribute("playsinline", "");
  local.muted = true;
  local.autoplay = true;
  self.append(local);

  // Reads the safe-area insets as numbers: CSS knows them, script otherwise does not.
  const probe = el("div", "safe-probe");
  probe.setAttribute("aria-hidden", "true");

  // ---- Status, badge and the actions of the current phase ----
  const center = el("div", "center");
  // Bars plus words, so the meaning never rests on colour alone. A tap opens the diagnostics as a shortcut;
  // keyboard and screen-reader users reach the same sheet through the settings button.
  const quality = el("p", "quality");
  quality.setAttribute("role", "status");
  quality.setAttribute("aria-live", "polite");
  quality.setAttribute("aria-atomic", "true");
  const bars = el("span", "quality-bars");
  bars.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) bars.append(el("i"));
  const qualityWords = el("span", "quality-words");
  const qualityText = el("span", "quality-text");
  const peerText = el("span", "quality-peer");
  peerText.hidden = true;
  qualityWords.append(qualityText, peerText);
  quality.append(bars, qualityWords);

  const pulse = el("div", "pulse");
  pulse.setAttribute("aria-hidden", "true");
  pulse.append(el("i"), el("i"));
  const status = el("p", "status", group ? "Конференция" : "Готовы войти");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const statusNote = el("p", "status-note", group ? `До ${capacity} человек` : "");
  statusNote.hidden = !group;
  const issue = el("div", "media-issue glass");
  issue.hidden = true;

  const lobby = el("div", "lobby-row");
  const lobbyMic = roundToggle("mic", "Микрофон");
  const lobbyCam = roundToggle("video", "Камера");
  const meter = el("div", "meter");
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", "Уровень микрофона");
  const meterBar = el("i");
  meter.append(meterBar);
  lobby.append(lobbyMic, meter, lobbyCam);

  const join = button(group ? "Войти в конференцию" : "Войти в звонок");
  join.classList.add("btn-hero", "join");
  const fresh = linkButton("Создать новую ссылку", "/");
  fresh.classList.add("btn-hero", "fresh");
  fresh.hidden = true;
  const audio = button("Включить звук");
  audio.classList.add("btn-hero", "unmute");
  audio.hidden = true;
  const retry = button("Переподключить", "glass");
  retry.classList.add("retry");
  retry.hidden = true;
  const shareWord = canShare() ? "Отправить ссылку" : "Скопировать ссылку";
  const share = button(shareWord, "glass", "share");
  share.classList.add("share");
  const hint = el("p", "hint lobby-hint", "Не сворачивайте браузер во время звонка");
  hint.hidden = !isIPhone();
  center.append(quality, pulse, status, statusNote, issue, lobby, join, fresh, audio, retry, share, hint);

  // In the lobby sharing is a small icon in the corner. It does not compete with the main button.
  const shareCorner = el("button", "round share-corner");
  shareCorner.type = "button";
  shareCorner.setAttribute("aria-label", shareWord);
  shareCorner.innerHTML = iconSvg("share");

  // ---- The floating panel ----
  const controls = el("div", "controls");
  controls.setAttribute("role", "toolbar");
  controls.setAttribute("aria-label", "Управление звонком");
  const mic = control("mic", "Микрофон");
  const cam = control("video", "Камера");
  mic.setAttribute("aria-pressed", "false");
  cam.setAttribute("aria-pressed", "false");
  const flip = control("flip", "Повернуть", "Другая камера");
  flip.hidden = true;
  const more = control("more", "Ещё", "Настройки");
  const end = control("phone", "Завершить");
  end.classList.add("danger");
  controls.append(mic, cam, flip, more, end);

  // ---- Sheets ----
  const settings = sheet("Настройки");
  const fitSwitch = el("button", "row switch");
  fitSwitch.type = "button";
  fitSwitch.setAttribute("role", "switch");
  fitSwitch.setAttribute("aria-checked", "false");
  fitSwitch.append(el("span", "", "Показывать целиком"), el("i"));
  const diagRow = el("button", "row");
  diagRow.type = "button";
  diagRow.append(el("span", "", "Диагностика"), el("span", "chevron", "›"));
  // A conference can grow during the call, so the link is at hand here too, with the seats taken so far.
  const inviteRow = el("button", "row invite");
  inviteRow.type = "button";
  const inviteLabel = el("span", "", "Пригласить по ссылке");
  const inviteCount = el("span", "seats");
  inviteRow.append(inviteLabel, inviteCount);
  inviteRow.hidden = !group;
  settings.body.append(fitSwitch, inviteRow, diagRow);

  const diagnostics = sheet("Диагностика");
  const diagMain = el("div", "diag");
  const diagMore = el("details", "diag-more");
  const diagRest = el("div", "diag");
  diagMore.append(el("summary", "", "Ещё"), diagRest);
  diagnostics.body.append(diagMain, diagMore);

  page.append(aurora(true), stage, self, probe, center, shareCorner, controls, settings.dialog, diagnostics.dialog);
  root.replaceChildren(page);

  let phase: CallPhase = "idle";
  let tier: QualityTier = START_TIER;

  // ---- Quality badge ----
  const showQuality = (next: QualityTier, peerTier: QualityTier | null): void => {
    const wasWeak = isWeakTier(tier);
    tier = next;
    const badge = qualityBadge(next, peerTier);
    quality.dataset.tier = next;
    quality.dataset.bars = String(badge.bars);
    // The other side's tier as it was reported, also when the words for it stay hidden.
    quality.dataset.peer = peerTier ?? "unknown";
    if (qualityText.textContent !== badge.text) qualityText.textContent = badge.text;
    const peer = badge.peerText ?? "";
    if (peerText.textContent !== peer) peerText.textContent = peer;
    peerText.hidden = badge.peerText === null;
    // A weak link brings the controls back and keeps them: the person must see the warning.
    if (isWeakTier(next)) {
      window.clearTimeout(hideTimer);
      if (!wasWeak) setUi(true);
    } else if (wasWeak) {
      armHide();
    }
    layoutSelf();
  };

  // ---- Status ----
  let noteTimer = 0;
  const showStatus = (text: string): void => {
    window.clearTimeout(noteTimer);
    // An ended call reads as one heading and one short phrase.
    const split = phase === "ended" || phase === "idle" ? text.indexOf(". ") : -1;
    const head = split < 0 ? text : text.slice(0, split);
    const tail = split < 0 ? "" : text.slice(split + 2);
    if (status.textContent !== head) status.textContent = head;
    statusNote.textContent = tail;
    statusNote.hidden = tail === "";
    if (phase === "live" && text !== "") {
      noteTimer = window.setTimeout(() => {
        if (phase === "live") status.textContent = "";
        layoutSelf();
      }, LIVE_NOTE_MS);
    }
    layoutSelf();
  };

  // ---- Showing and hiding the controls ----
  let uiShown = true;
  let hideTimer = 0;
  let lastInput: InputKind = "touch";
  let quietUntil = 0;
  const context = (): ChromeContext => {
    const focused = document.activeElement;
    return {
      phase,
      sheetOpen: settings.dialog.open || diagnostics.dialog.open,
      keyboardFocus: focused instanceof HTMLElement && page.contains(focused) && focused.matches(":focus-visible"),
      tier,
    };
  };
  const setUi = (shown: boolean): void => {
    if (uiShown === shown) return;
    uiShown = shown;
    page.dataset.ui = shown ? "shown" : "hidden";
    layoutSelf();
  };
  const armHide = (): void => {
    window.clearTimeout(hideTimer);
    if (!mayAutoHide(context())) return;
    hideTimer = window.setTimeout(() => {
      // Whatever blocks hiding now (a sheet, keyboard focus, a weak link) arms the timer again when it ends.
      if (mayAutoHide(context())) setUi(false);
    }, autoHideDelay(lastInput));
  };
  const wake = (input: InputKind): void => {
    lastInput = input;
    setUi(true);
    armHide();
  };

  /*
   * One tap on the picture hides or shows the controls, at once. There is no double tap: telling the two
   * apart would delay every single tap by a third of a second, which reads as a stutter. Fitting the whole
   * frame, the old meaning of a tap, is a switch in the settings sheet.
   */
  stage.addEventListener("click", () => {
    if (phase !== "live") return;
    if (uiShown && mayHide(context())) {
      window.clearTimeout(hideTimer);
      quietUntil = Date.now() + MOVE_QUIET_MS;
      setUi(false);
    } else {
      wake(lastInput);
    }
  });
  // A touch anywhere but the picture (a button, the «me» window) counts as activity. The picture has its own tap.
  page.addEventListener("pointerdown", (event) => {
    const input: InputKind = event.pointerType === "mouse" ? "mouse" : "touch";
    if (event.target instanceof Node && stage.contains(event.target)) lastInput = input;
    else wake(input);
  });
  page.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" || Date.now() < quietUntil) return;
    wake("mouse");
  });
  // Keyboard and screen-reader users always get the controls: focus on any of them shows the panel.
  page.addEventListener("focusin", () => {
    setUi(true);
    armHide();
  });
  page.addEventListener("focusout", () => armHide());
  for (const dialog of [settings.dialog, diagnostics.dialog]) dialog.addEventListener("close", () => wake(lastInput));

  // ---- The «me» window ----
  let corner: Corner = parseCorner(readCorner(), defaultCorner(viewportOf(page)));
  let selfRatio: number | undefined;
  let selfAt: Point = { x: 0, y: 0 };
  let pip = false;
  let drag: { pointer: number; startX: number; startY: number; origin: Point; moved: boolean } | null = null;

  const selfArea = (): Box => safeBox(viewportOf(page), insetsOf(probe), SELF_EDGE);
  const placeSelf = (at: Point, size: Size): void => {
    selfAt = at;
    self.style.setProperty("width", `${size.width}px`);
    self.style.setProperty("height", `${size.height}px`);
    self.style.setProperty("transform", `translate3d(${Math.round(at.x)}px, ${Math.round(at.y)}px, 0)`);
  };
  function layoutSelf(): void {
    const nowPip = phase === "live" || phase === "trouble";
    const ownCell = layoutStage(nowPip);
    if (!nowPip) {
      // Before the call connects the own picture fills the screen; the stylesheet does that.
      pip = false;
      drag = null;
      self.classList.remove("pip", "dragging", "tiled");
      for (const property of ["width", "height", "transform"]) self.style.removeProperty(property);
      return;
    }
    self.classList.toggle("tiled", ownCell !== null);
    if (ownCell) {
      // In a conference the own picture is one more tile of the grid. It is not dragged anywhere.
      drag = null;
      const fresh = !pip;
      pip = true;
      self.classList.add("pip");
      self.classList.toggle("dragging", fresh);
      placeSelf({ x: ownCell.x, y: ownCell.y }, { width: ownCell.width, height: ownCell.height });
      if (fresh) {
        void self.offsetWidth;
        self.classList.remove("dragging");
      }
      return;
    }
    const size = selfSize(viewportOf(page), selfRatio);
    const area = selfArea();
    if (drag?.moved) {
      placeSelf(clampToBox(selfAt, area, size), size);
      return;
    }
    // Panels only count while they are on screen. When they hide, the window slides back to the edge.
    const obstacles = uiShown ? [controls, quality, status].map(boxOf).filter((box): box is Box => box !== null) : [];
    const at = cornerPosition(corner, area, size, obstacles, SELF_GAP);
    if (!pip) {
      // First appearance: land in the corner at once instead of flying in from the top left.
      pip = true;
      self.classList.add("pip", "dragging");
      placeSelf(at, size);
      void self.offsetWidth;
      self.classList.remove("dragging");
      return;
    }
    placeSelf(at, size);
  }

  self.addEventListener("pointerdown", (event) => {
    if (!pip || event.button !== 0 || drag || self.classList.contains("tiled")) return;
    drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, origin: selfAt, moved: false };
    self.setPointerCapture?.(event.pointerId);
  });
  self.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_START_PX) return;
    drag.moved = true;
    self.classList.add("dragging");
    const size = selfSize(viewportOf(page), selfRatio);
    placeSelf(clampToBox({ x: drag.origin.x + dx, y: drag.origin.y + dy }, selfArea(), size), size);
  });
  const drop = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const moved = drag.moved;
    drag = null;
    self.classList.remove("dragging");
    if (!moved) return;
    corner = nearestCorner(selfAt, selfArea(), selfSize(viewportOf(page), selfRatio));
    writeCorner(corner);
    layoutSelf();
  };
  self.addEventListener("pointerup", drop);
  self.addEventListener("pointercancel", drop);
  const readSelfRatio = (): void => {
    if (!local.videoWidth || !local.videoHeight) return;
    selfRatio = local.videoWidth / local.videoHeight;
    layoutSelf();
  };
  local.addEventListener("resize", readSelfRatio);
  local.addEventListener("loadedmetadata", readSelfRatio);
  if (typeof ResizeObserver === "function") new ResizeObserver(() => layoutSelf()).observe(controls);

  // ---- The other people: one tile each ----
  /**
   * Places the tiles. One person fills the screen, as in a call for two. More share it as a grid, and
   * during the call the own picture takes the last cell: its place is returned, or null when it stays a window.
   */
  function layoutStage(withSelf: boolean): Rect | null {
    const list = [...tiles.values()];
    const grid = list.length >= 2;
    stage.dataset.layout = grid ? "grid" : "single";
    if (!grid) {
      for (const tile of list) for (const property of ["width", "height", "transform"]) tile.root.style.removeProperty(property);
      return null;
    }
    const box = safeBox(viewportOf(page), insetsOf(probe), GRID_GAP);
    const area: Rect = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
    const cells = gridLayout(area, list.length + (withSelf ? 1 : 0), GRID_GAP);
    list.forEach((tile, index) => {
      const cell = cells[index];
      if (!cell) return;
      tile.root.style.setProperty("width", `${Math.round(cell.width)}px`);
      tile.root.style.setProperty("height", `${Math.round(cell.height)}px`);
      tile.root.style.setProperty("transform", `translate3d(${Math.round(cell.x)}px, ${Math.round(cell.y)}px, 0)`);
    });
    return withSelf ? (cells[list.length] ?? null) : null;
  }

  // ---- How each picture fills its tile ----
  let userFit: boolean | null = null;
  const fitRemote = (): void => {
    let shown = false;
    for (const { root: frame, video } of tiles.values()) {
      let auto = false;
      if (video.videoWidth && video.videoHeight && !isPhone(viewportOf(page))) {
        // A portrait iPhone picture on a wide Mac window is shown whole, not cropped to a strip of forehead.
        // On a phone the picture always fills its place, with a soft crop at the sides.
        auto = (video.videoHeight > video.videoWidth) !== (frame.clientHeight > frame.clientWidth);
      }
      const whole = userFit ?? auto;
      video.classList.toggle("contain", whole);
      shown ||= whole;
    }
    fitSwitch.setAttribute("aria-checked", String(userFit ?? shown));
  };
  fitSwitch.addEventListener("click", () => {
    userFit = fitSwitch.getAttribute("aria-checked") !== "true";
    fitRemote();
  });
  window.addEventListener("resize", () => {
    layoutSelf();
    fitRemote();
  });

  /** Starts every picture and voice on screen. A browser that refuses gets the «Включить звук» button. */
  const playAll = async (): Promise<void> => {
    let blocked = false;
    for (const { video } of tiles.values()) {
      if (!video.srcObject) continue;
      try {
        await video.play();
      } catch {
        blocked = true;
      }
    }
    audio.hidden = !blocked;
  };

  const showPeers = (peers: RemotePeer[]): void => {
    for (const [id, tile] of tiles) {
      if (peers.some((peer) => peer.id === id)) continue;
      tile.video.srcObject = null;
      tile.root.remove();
      tiles.delete(id);
    }
    let fresh = false;
    for (const peer of peers) {
      let tile = tiles.get(peer.id);
      if (!tile) {
        const frame = el("div", "tile");
        const video = el("video", "remote");
        video.setAttribute("playsinline", "");
        video.playsInline = true;
        video.autoplay = true;
        video.addEventListener("resize", fitRemote);
        video.addEventListener("loadedmetadata", fitRemote);
        const note = el("p", "tile-note");
        frame.append(video, note);
        stage.append(frame);
        tile = { root: frame, video, note };
        tiles.set(peer.id, tile);
        fresh = true;
      }
      // The last picture stays, dimmed, while a connection is rebuilt: only a new stream replaces it.
      if (peer.stream && tile.video.srcObject !== peer.stream) {
        tile.video.srcObject = peer.stream;
        fresh = true;
      }
      tile.root.dataset.phase = peer.phase;
      const weak = peer.phase === "live" && peer.tier !== null && isWeakTier(peer.tier);
      tile.root.dataset.weak = String(weak);
      // What is wrong with this one person, on their own picture. The rest of the call goes on.
      const text = peer.phase === "live" ? (weak ? "Слабая связь" : "") : peer.phase === "connecting" ? "Соединяем" : (peer.note.split(". ")[0] ?? "");
      if (tile.note.textContent !== text) tile.note.textContent = text;
    }
    const seats = `${peers.length + 1} из ${capacity}`;
    if (inviteCount.textContent !== seats) inviteCount.textContent = seats;
    // A full conference has nobody left to invite.
    inviteRow.disabled = peers.length + 1 >= capacity;
    stage.dataset.count = String(peers.length);
    layoutSelf();
    fitRemote();
    if (fresh) void playAll();
  };

  // ---- Microphone level in the lobby ----
  let stopMeter: (() => void) | null = null;
  const setPreview = (on: boolean): void => {
    page.dataset.preview = on ? "on" : "off";
    stopMeter?.();
    stopMeter = on && local.srcObject instanceof MediaStream ? startMeter(local.srcObject, meterBar) : null;
  };

  // ---- Phases ----
  const setPhase = (next: CallPhase): void => {
    const before = phase;
    phase = next;
    page.dataset.phase = next;
    retry.hidden = next !== "trouble";
    if (next !== "idle") setPreview(false);
    if (next === "live" && before !== "live" && status.textContent !== "") showStatus("");
    // Safari tints its bars to match: black around the video, the page colour around the drifting background.
    setThemeColor(next === "idle" || next === "ended" ? "#060d12" : "#000000");
    if (next !== before) setUi(true);
    armHide();
    layoutSelf();
  };

  const session = new CallSession(roomId, local, {
    onStatus: showStatus,
    onDiagnostics: (main, rest) => {
      diagMain.replaceChildren(...main.map(diagLine));
      diagRest.replaceChildren(...rest.map(diagLine));
    },
    onAudioBlocked: (blocked) => {
      audio.hidden = !blocked;
    },
    onPeers: showPeers,
    onPlayback: () => void playAll(),
    onCapacity: (seats) => {
      capacity = seats;
      inviteRow.hidden = !isGroup();
    },
    onMediaIssue: (reason) => {
      issue.hidden = reason === null;
      issue.replaceChildren(...(reason === null ? [] : permissionHelp(reason)));
      if (reason !== null) join.querySelector(".btn-label")!.textContent = "Войти снова";
    },
    onEnded: (text, canRejoin) => {
      phase = "ended";
      showStatus(text);
      join.querySelector(".btn-label")!.textContent = "Войти снова";
      join.hidden = !canRejoin;
      fresh.hidden = canRejoin;
      audio.hidden = true;
      for (const dialog of [settings.dialog, diagnostics.dialog]) if (dialog.open) dialog.close();
    },
    onWaiting: (waiting) => showStatus(waiting ? (isGroup() ? "Ждём участников" : "Ждём второго человека") : "Соединяем"),
    onPhase: setPhase,
    onQuality: showQuality,
    onCameras: (count) => {
      flip.hidden = count < 2;
    },
  }, group);
  showQuality(START_TIER, null);
  setPhase("idle");

  // ---- Actions ----
  join.addEventListener("click", () => {
    setPhase("starting");
    void session.start();
  });
  audio.addEventListener("click", () => void playAll());
  inviteRow.addEventListener("click", () => void shareLink(location.href, flashLabel(inviteLabel)));
  retry.addEventListener("click", () => session.retry());
  share.addEventListener("click", () => void shareLink(location.href, flashLabel(share)));
  shareCorner.addEventListener("click", () => {
    void shareLink(location.href, (text) => {
      // The icon has no room for a word: it turns into a tick and names the result for a screen reader.
      shareCorner.setAttribute("aria-label", text);
      shareCorner.innerHTML = iconSvg(text === "Скопировано" ? "check" : "share");
      window.setTimeout(() => {
        shareCorner.setAttribute("aria-label", shareWord);
        shareCorner.innerHTML = iconSvg("share");
      }, 2500);
    });
  });
  const toggleMic = (): void => {
    const enabled = session.toggleAudio();
    setControl(mic, enabled, "Микрофон", "Выключен", "Микрофон выключен");
    setControl(lobbyMic, enabled, "Микрофон", "Выключен", "Микрофон выключен");
  };
  const toggleCam = (): void => {
    const enabled = session.toggleVideo();
    setControl(cam, enabled, "Камера", "Выключена", "Камера выключена");
    setControl(lobbyCam, enabled, "Камера", "Выключена", "Камера выключена");
    self.classList.toggle("off", !enabled);
  };
  for (const node of [mic, lobbyMic]) node.addEventListener("click", toggleMic);
  for (const node of [cam, lobbyCam]) node.addEventListener("click", toggleCam);
  flip.addEventListener("click", () => void session.switchCamera());
  end.addEventListener("click", () => session.hangup());
  more.addEventListener("click", () => settings.dialog.showModal());
  const openDiagnostics = (): void => {
    if (settings.dialog.open) settings.dialog.close();
    diagnostics.dialog.showModal();
  };
  diagRow.addEventListener("click", openDiagnostics);
  quality.addEventListener("click", openDiagnostics);
  // On a Mac the keyboard is closer than the pointer: M mutes, V turns the camera off.
  window.addEventListener("keydown", (event) => {
    wake("key");
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || settings.dialog.open || diagnostics.dialog.open) return;
    if (phase === "idle" || phase === "ended" || phase === "starting") return;
    const key = event.key.toLowerCase();
    if (key === "m" || key === "ь") toggleMic();
    else if (key === "v" || key === "м") toggleCam();
  });

  // The camera shows in the lobby only when the browser already has permission. Asking for it before
  // the person has touched anything would greet them with a system prompt instead of the page.
  void mediaGranted().then(async (granted) => {
    if (!granted || phase !== "idle") return;
    const hasPicture = await session.preview();
    if (!hasPicture || phase !== "idle") return;
    showStatus("Всё готово");
    setPreview(true);
  });
}

async function mediaGranted(): Promise<boolean> {
  try {
    const query = (name: string): Promise<PermissionStatus> => navigator.permissions.query({ name: name as PermissionName });
    const [camera, microphone] = await Promise.all([query("camera"), query("microphone")]);
    return camera.state === "granted" && microphone.state === "granted";
  } catch {
    // A browser that cannot answer is treated as one that would have to ask.
    return false;
  }
}

/** Draws how loud the microphone is, so a person sees they are heard before they join. */
function startMeter(stream: MediaStream, bar: HTMLElement): (() => void) | null {
  const track = stream.getAudioTracks()[0];
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!track || !Context) return null;
  try {
    const context = new Context();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    // A browser may hold the context until a touch. The bar then stays empty and wakes with the first tap.
    const resume = (): void => void context.resume().catch(() => undefined);
    resume();
    window.addEventListener("pointerdown", resume);
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 5);
      bar.style.setProperty("transform", `scaleX(${level.toFixed(3)})`);
    }, 80);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", resume);
      source.disconnect();
      bar.style.removeProperty("transform");
      void context.close().catch(() => undefined);
    };
  } catch {
    return null;
  }
}

function permissionHelp(reason: MediaIssue): HTMLElement[] {
  if (reason === "denied") {
    return [
      el("p", "", "Разрешите доступ к камере и микрофону и войдите снова."),
      el("p", "steps", "На iPhone: Настройки → Safari → Камера и Микрофон → Разрешить"),
    ];
  }
  if (reason === "missing") return [el("p", "", "Проверьте, подключены ли камера и микрофон.")];
  if (reason === "busy") return [el("p", "", "Закройте приложение, которое держит камеру или микрофон.")];
  return [el("p", "", "Проверьте камеру и микрофон и войдите ещё раз.")];
}

function diagLine(line: string): HTMLElement {
  const row = el("div");
  const split = line.indexOf(": ");
  row.append(el("span", "", split < 0 ? line : line.slice(0, split)), el("b", "", split < 0 ? "" : line.slice(split + 2)));
  return row;
}

function setControl(node: HTMLButtonElement, enabled: boolean, label: string, offLabel: string, offName: string): void {
  node.setAttribute("aria-pressed", String(!enabled));
  node.setAttribute("aria-label", enabled ? label : offName);
  const text = node.querySelector(".ctl-label");
  if (text) text.textContent = enabled ? label : offLabel;
}

/** A round call button: the icon in a disc, a short word that shows on hover, the full name for screen readers. */
function control(icon: IconName, label: string, name = label): HTMLButtonElement {
  const node = el("button", `ctl ctl-${icon}`);
  node.type = "button";
  node.setAttribute("aria-label", name);
  const disc = el("span", "ctl-icon");
  disc.innerHTML = iconSvg(icon, '<path class="slash" d="M3 3l18 18"/>');
  node.append(disc, el("span", "ctl-label", label));
  return node;
}

function roundToggle(icon: IconName, name: string): HTMLButtonElement {
  const node = el("button", "round");
  node.type = "button";
  node.setAttribute("aria-label", name);
  node.setAttribute("aria-pressed", "false");
  node.innerHTML = iconSvg(icon, '<path class="slash" d="M3 3l18 18"/>');
  return node;
}

function setThemeColor(color: string): void {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", color);
}

function viewportOf(page: HTMLElement): Size {
  return { width: page.clientWidth, height: page.clientHeight };
}

function insetsOf(probe: HTMLElement): { top: number; right: number; bottom: number; left: number } {
  const style = getComputedStyle(probe);
  const read = (value: string): number => Number.parseFloat(value) || 0;
  return { top: read(style.paddingTop), right: read(style.paddingRight), bottom: read(style.paddingBottom), left: read(style.paddingLeft) };
}

/** The place an element takes in the layout, without the small shift of its show and hide animation. */
function boxOf(node: HTMLElement): Box | null {
  if (node.offsetWidth === 0 || node.offsetHeight === 0) return null;
  let left = 0;
  let top = 0;
  for (let item: HTMLElement | null = node; item && !item.classList.contains("call"); item = item.offsetParent as HTMLElement | null) {
    left += item.offsetLeft;
    top += item.offsetTop;
  }
  return { left, top, right: left + node.offsetWidth, bottom: top + node.offsetHeight };
}

function readCorner(): string | null {
  try {
    return localStorage.getItem(CORNER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeCorner(corner: Corner): void {
  try {
    localStorage.setItem(CORNER_STORAGE_KEY, corner);
  } catch {
    // Private mode without storage: the window still snaps, it only starts from the default next time.
  }
}
