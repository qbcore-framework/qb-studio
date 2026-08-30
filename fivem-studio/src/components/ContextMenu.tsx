import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  ariaLabel?: string;
}

export default function ContextMenu({ x, y, items, onClose, ariaLabel = "Actions" }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    function clampToViewport() {
      const menu = ref.current;
      if (!menu) return;
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - menu.offsetWidth - margin);
      const maxTop = Math.max(margin, window.innerHeight - menu.offsetHeight - margin);
      setPosition({
        left: Math.max(margin, Math.min(x, maxLeft)),
        top: Math.max(margin, Math.min(y, maxTop)),
      });
    }
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [items.length, x, y]);

  useEffect(() => {
    const menuElement = ref.current;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const enabledItems = () => Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    enabledItems()[0]?.focus();

    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = enabledItems();
      if (buttons.length === 0) return;
      e.preventDefault();
      const current = document.activeElement instanceof HTMLButtonElement
        ? buttons.indexOf(document.activeElement)
        : -1;
      const next = e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : e.key === "ArrowDown"
            ? (current + 1 + buttons.length) % buttons.length
            : (current - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      const activeElement = document.activeElement;
      const focusWasClaimedOutsideMenu = activeElement instanceof HTMLElement
        && activeElement !== document.body
        && activeElement !== document.documentElement
        && !menuElement?.contains(activeElement);

      // Actions can mount and focus their next control before cleanup runs (for
      // example, ResourceTree's rename input). Ordinary dismissal still leaves
      // focus in the menu/body and restores the control that opened the menu.
      if (!focusWasClaimedOutsideMenu) previousFocus.current?.focus();
    };
  }, []);

  return (
    <div ref={ref} className="context-menu" role="menu" aria-label={ariaLabel} style={position}>
      {items.map((item) => (
        <button
          type="button"
          role="menuitem"
          key={item.label}
          className={`context-menu-item ${item.danger ? "danger" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
