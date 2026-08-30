const overlay = document.querySelector(".overlay");
const title = document.querySelector("#title");
const closeButton = document.querySelector("#close");

function setVisible(visible, nextTitle) {
  overlay.classList.toggle("is-visible", visible);
  overlay.setAttribute("aria-hidden", String(!visible));
  if (visible && typeof nextTitle === "string") title.textContent = nextTitle.slice(0, 80);
  if (visible) closeButton.focus();
}

async function closeUi() {
  setVisible(false);
  const resourceName = typeof GetParentResourceName === "function" ? GetParentResourceName() : null;
  if (!resourceName) return;
  await fetch(`https://${resourceName}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (message.type === "qb-studio:open") setVisible(true, message.title);
  if (message.type === "qb-studio:close") setVisible(false);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void closeUi();
});

closeButton.addEventListener("click", () => void closeUi());
