import { useEffect, useState } from "react";

export default function App() {
  const [visible, setVisible] = useState(false);
  const [title, setTitle] = useState("React resource UI");

  useEffect(() => {
    function receiveMessage(event) {
      const message = event.data;
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.type === "qb-studio:open") {
        if (typeof message.title === "string") setTitle(message.title.slice(0, 80));
        setVisible(true);
      }
      if (message.type === "qb-studio:close") setVisible(false);
    }
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, []);

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

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape" && visible) void closeUi();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  return (
    <main className={`overlay ${visible ? "is-visible" : ""}`} aria-hidden={!visible}>
      <section className="panel" role="dialog" aria-modal="true" aria-labelledby="title">
        <p className="eyebrow">QB Studio React starter</p>
        <h1 id="title">{title}</h1>
        <p>Edit <code>html/src/App.jsx</code>, then run <code>npm run build</code> inside <code>html</code>.</p>
        <button type="button" onClick={() => void closeUi()}>Close</button>
      </section>
    </main>
  );
}
