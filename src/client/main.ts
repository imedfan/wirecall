import { isRoomId } from "../shared/ids";
import { renderCall } from "./call-view";
import { renderHome } from "./home";
import { linkButton, messageScreen, watchPageVisibility } from "./ui";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("missing app");

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
