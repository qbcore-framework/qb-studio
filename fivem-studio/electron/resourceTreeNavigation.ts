export interface ResourceTreeNavigationItem {
  path: string;
  parentPath: string | null;
  isDirectory: boolean;
  expanded: boolean;
}

export type ResourceTreeNavigationAction =
  | { type: "focus"; path: string }
  | { type: "toggle"; path: string }
  | { type: "activate"; path: string };

/** Resolve one standard ARIA tree keystroke against visible items in DOM order. */
export function resourceTreeNavigationAction(
  items: ResourceTreeNavigationItem[],
  currentPath: string,
  key: string,
): ResourceTreeNavigationAction | null {
  const index = items.findIndex((item) => item.path === currentPath);
  if (index < 0) return null;
  const current = items[index];

  if (key === "ArrowDown" && index < items.length - 1) return { type: "focus", path: items[index + 1].path };
  if (key === "ArrowUp" && index > 0) return { type: "focus", path: items[index - 1].path };
  if (key === "Home" && items.length > 0) return { type: "focus", path: items[0].path };
  if (key === "End" && items.length > 0) return { type: "focus", path: items[items.length - 1].path };
  if (key === "Enter" || key === " ") return { type: "activate", path: current.path };

  if (key === "ArrowRight") {
    if (!current.isDirectory) return null;
    if (!current.expanded) return { type: "toggle", path: current.path };
    const firstChild = items[index + 1];
    return firstChild?.parentPath === current.path ? { type: "focus", path: firstChild.path } : null;
  }

  if (key === "ArrowLeft") {
    if (current.isDirectory && current.expanded) return { type: "toggle", path: current.path };
    return current.parentPath ? { type: "focus", path: current.parentPath } : null;
  }

  return null;
}
