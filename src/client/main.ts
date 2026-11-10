import { isRoomId } from "../shared/ids";
import { renderCall } from "./call-view";
import { renderHome } from "./home";
import { linkButton, messageScreen, watchPageVisibility } from "./ui";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("missing app");

watchPageVisibility();
if (!window.isSecureContext) {
  app.replaceChildren(messageScreen("Нужен HTTPS", "Откройте ссылку, которая начинается с https://."));
} else if (location.pathname.startsWith("/r/") || location.pathname.startsWith("/c/")) {
  const roomId = location.pathname.split("/")[2] ?? "";
  if (!isRoomId(roomId)) app.replaceChildren(messageScreen("Комната не найдена", "Попросите прислать ссылку ещё раз.", linkButton("На главную", "/")));
  // /c/ is a conference link. The letter only picks the words of the lobby; the room knows its own size.
  else renderCall(app, roomId, location.pathname.startsWith("/c/"));
} else {
  void renderHome(app);
}
