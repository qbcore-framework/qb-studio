import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CreatedResourceEntry, DirEntry, ResourceDuplicateResult, StarterResourceResult } from "../global";
import { t } from "../i18n";
import {
  resourceTreeNavigationAction,
  type ResourceTreeNavigationItem,
} from "../../electron/resourceTreeNavigation";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import ResourceCreationDialog, { type ResourceCreationKind, type StarterResourceTemplate } from "./ResourceCreationDialog";

type ResourceState = "started" | "stopped";
type ResourceAction = "start" | "stop" | "restart";

interface TreeNodeProps {
  entry: DirEntry;
  parentPath: string;
  depth: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  refreshKey: number;
  renamingPath: string | null;
  onCommitRename: (entry: DirEntry, newName: string) => void;
  onCancelRename: () => void;
  onContextMenu: (
    entry: DirEntry,
    parentPath: string,
    insideResource: boolean,
    canCreateStarterInParent: boolean,
    x: number,
    y: number,
  ) => void;
  resourceStates: Record<string, ResourceState>;
  serverStateAvailable: boolean;
  insideResource: boolean;
  canCreateStarterInParent: boolean;
  revealDirectory: { path: string; nonce: number } | null;
  focusedPath: string;
}

function isCategoryFolderName(name: string): boolean {
  return /^\[[^\[\]\\/]+\]$/.test(name);
}

function TreeNode({
  entry,
  parentPath,
  depth,
  selectedPath,
  onOpenFile,
  refreshKey,
  renamingPath,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  resourceStates,
  serverStateAvailable,
  insideResource,
  canCreateStarterInParent,
  revealDirectory,
  focusedPath,
}: TreeNodeProps) {
  const treeItemRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (!entry.isDirectory) {
      onOpenFile(entry.path);
      return;
    }
    if (!expanded && children === null) {
      try {
        const loaded = await window.api.fs.listDir(entry.path);
        setChildren(loaded);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    }
    setExpanded((e) => !e);
  }

  // Keep already-loaded folders in sync with changes made outside Studio
  // (files moved/renamed/added/deleted in Explorer) — re-fetch whenever the
  // watcher-driven refreshKey ticks, regardless of current expand state.
  useEffect(() => {
    if (children === null) return;
    let cancelled = false;
    void window.api.fs
      .listDir(entry.path)
      .then((loaded) => {
        if (cancelled) return;
        setChildren(loaded);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => { cancelled = true; };
  }, [entry.path, refreshKey]); // children intentionally only gates the initial subscription

  useEffect(() => {
    if (!revealDirectory || revealDirectory.path !== entry.path || !entry.isDirectory) return;
    let cancelled = false;
    void window.api.fs.listDir(entry.path)
      .then((loaded) => {
        if (cancelled) return;
        setChildren(loaded);
        setError(null);
        setExpanded(true);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => { cancelled = true; };
  }, [entry.isDirectory, entry.path, revealDirectory]);

  const isRenaming = renamingPath === entry.path;
  const resourceState = entry.resourceName && serverStateAvailable
    ? resourceStates[entry.resourceName.toLowerCase()]
    : undefined;
  const categoryFolder = entry.isDirectory && isCategoryFolderName(entry.name);
  const entryIsInsideResource = insideResource || (Boolean(entry.resourceName) && !categoryFolder);
  const canCreateStarterInside = entry.isDirectory && !entryIsInsideResource &&
    canCreateStarterInParent && categoryFolder;

  return (
    <div
      ref={treeItemRef}
      className="tree-item"
      role="treeitem"
      tabIndex={focusedPath === entry.path ? 0 : -1}
      aria-selected={selectedPath === entry.path}
      aria-expanded={entry.isDirectory ? expanded : undefined}
      data-tree-path={entry.path}
      data-tree-parent-path={parentPath}
      data-tree-directory={entry.isDirectory ? "true" : "false"}
      onKeyDown={(event) => {
        if (isRenaming || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        onContextMenu(
          entry,
          parentPath,
          insideResource,
          canCreateStarterInParent,
          bounds.left + 20,
          bounds.top + 20,
        );
      }}
    >
      <div
        className={`tree-node ${selectedPath === entry.path ? "selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        data-tree-action
        onClick={() => {
          treeItemRef.current?.focus();
          void toggle();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          treeItemRef.current?.focus();
          onContextMenu(entry, parentPath, insideResource, canCreateStarterInParent, e.clientX, e.clientY);
        }}
      >
        <span className="icon">{entry.isDirectory ? (expanded ? "▾" : "▸") : "📄"}</span>
        {isRenaming ? (
          <input
            className="tree-rename-input"
            autoFocus
            defaultValue={entry.name}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitRename(entry, (e.target as HTMLInputElement).value);
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={(e) => onCommitRename(entry, e.target.value)}
          />
        ) : (
          <>
            <span>{entry.name}</span>
            {entry.resourceName && (
              <span
                className={`resource-state-dot ${resourceState ?? "unknown"}`}
                title={t(`resource.state.${resourceState ?? "unknown"}`)}
                aria-label={t(`resource.state.${resourceState ?? "unknown"}`)}
              />
            )}
          </>
        )}
      </div>
      {expanded && entry.isDirectory && (
        <div
          role="group"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            treeItemRef.current?.focus();
            onContextMenu(
              entry,
              parentPath,
              insideResource,
              canCreateStarterInParent,
              event.clientX,
              event.clientY,
            );
          }}
        >
          {error && <div className="tree-empty">{error}</div>}
          {children?.length === 0 && <div className="tree-empty">(empty)</div>}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              parentPath={entry.path}
              depth={depth + 1}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
              refreshKey={refreshKey}
              renamingPath={renamingPath}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onContextMenu={onContextMenu}
              resourceStates={resourceStates}
              serverStateAvailable={serverStateAvailable}
              insideResource={entryIsInsideResource}
              canCreateStarterInParent={canCreateStarterInside}
              revealDirectory={revealDirectory}
              focusedPath={focusedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ResourceTreeProps {
  rootPath: string | null;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  refreshKey: number;
  onPathRenamed: (oldPath: string, newPath: string) => void;
  onDeleteEntry: (path: string, name: string) => Promise<boolean>;
  resourceStates: Record<string, ResourceState>;
  serverStateAvailable: boolean;
  runtimeWritable: boolean;
  resourceAction: string | null;
  onResourceAction: (kind: ResourceAction, name: string) => Promise<unknown>;
  onResourceDuplicated: (sourceName: string, result: ResourceDuplicateResult) => void;
  onEntryCreated: (result: CreatedResourceEntry) => void;
  onStarterCreated: (result: StarterResourceResult) => void;
}

interface MenuState {
  x: number;
  y: number;
  entry: DirEntry | null;
  targetDirectory: string;
  canCreateStarter: boolean;
}

interface CreationState {
  kind: ResourceCreationKind;
  parentPath: string;
}

export default function ResourceTree({
  rootPath,
  selectedPath,
  onOpenFile,
  refreshKey,
  onPathRenamed,
  onDeleteEntry,
  resourceStates,
  serverStateAvailable,
  runtimeWritable,
  resourceAction,
  onResourceAction,
  onResourceDuplicated,
  onEntryCreated,
  onStarterCreated,
}: ResourceTreeProps) {
  const [loadedTree, setLoadedTree] = useState<{ rootPath: string; entries: DirEntry[] } | null>(null);
  const [loadError, setLoadError] = useState<{ rootPath: string; message: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creation, setCreation] = useState<CreationState | null>(null);
  const [revealDirectory, setRevealDirectory] = useState<{ path: string; nonce: number } | null>(null);
  const [focusedPath, setFocusedPath] = useState(rootPath ?? "");
  const [rootExpanded, setRootExpanded] = useState(true);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenu(null);
    setCreation(null);
    setRenamingPath(null);
    setRevealDirectory(null);
    setFocusedPath(rootPath ?? "");
    setRootExpanded(true);
  }, [rootPath]);

  useEffect(() => {
    let cancelled = false;
    if (!rootPath) {
      setLoadedTree(null);
      setLoadError(null);
      return () => { cancelled = true; };
    }
    setLoadError(null);
    void window.api.fs
      .listDir(rootPath)
      .then((loaded) => {
        if (cancelled) return;
        setLoadedTree({ rootPath, entries: loaded });
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError({ rootPath, message: (err as Error).message });
      });
    return () => { cancelled = true; };
  }, [rootPath, refreshKey]);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !rootPath) return;
    const hasFocusedItem = () => Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      .some((item) => item.dataset.treePath === focusedPath);
    const ensureFocusableItem = () => {
      if (!hasFocusedItem()) setFocusedPath(rootPath);
    };
    ensureFocusableItem();
    const observer = new MutationObserver(ensureFocusableItem);
    observer.observe(tree, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [focusedPath, loadedTree, rootPath]);

  function handleTreeNavigation(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const current = target?.closest<HTMLElement>('[role="treeitem"]');
    const tree = treeRef.current;
    if (!current || !tree?.contains(current)) return;
    const elements = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const items: ResourceTreeNavigationItem[] = elements.map((item) => ({
      path: item.dataset.treePath ?? "",
      parentPath: item.dataset.treeParentPath || null,
      isDirectory: item.dataset.treeDirectory === "true",
      expanded: item.getAttribute("aria-expanded") === "true",
    }));
    const action = resourceTreeNavigationAction(items, current.dataset.treePath ?? "", event.key);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.type === "focus") {
      const next = elements.find((item) => item.dataset.treePath === action.path);
      if (next) {
        setFocusedPath(action.path);
        next.focus();
      }
      return;
    }
    const actionRow = Array.from(current.children).find((child) =>
      child instanceof HTMLElement && child.hasAttribute("data-tree-action"),
    );
    if (actionRow instanceof HTMLElement) actionRow.click();
  }

  async function commitRename(entry: DirEntry, newName: string) {
    setRenamingPath(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) return;
    try {
      const newPath = await window.api.fs.rename(entry.path, trimmed);
      onPathRenamed(entry.path, newPath);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function deleteEntry(entry: DirEntry) {
    await onDeleteEntry(entry.path, entry.name);
  }

  async function duplicateEntry(entry: DirEntry) {
    if (!entry.resourceName) return;
    const proposed = prompt(t("resource.duplicate.prompt"), `${entry.resourceName}-copy`);
    if (proposed === null || !proposed.trim()) return;
    try {
      const result = await window.api.resources.duplicate(entry.path, proposed.trim());
      onResourceDuplicated(entry.resourceName, result);
    } catch (error) {
      alert((error as Error).message);
    }
  }

  function openContextMenu(
    entry: DirEntry,
    parentPath: string,
    insideResource: boolean,
    canCreateStarterInParent: boolean,
    x: number,
    y: number,
  ) {
    const targetDirectory = entry.isDirectory ? entry.path : parentPath;
    const categoryFolder = entry.isDirectory && isCategoryFolderName(entry.name);
    const canCreateStarter = entry.isDirectory
      ? !insideResource && canCreateStarterInParent && categoryFolder
      : !insideResource && canCreateStarterInParent;
    setMenu({ x, y, entry, targetDirectory, canCreateStarter });
  }

  function openRootContextMenu(x: number, y: number) {
    if (!rootPath) return;
    setMenu({ x, y, entry: null, targetDirectory: rootPath, canCreateStarter: true });
  }

  async function createEntry(kind: ResourceCreationKind, parentPath: string, name: string, template: StarterResourceTemplate) {
    if (kind === "resource") {
      const result = await window.api.resources.createStarter(parentPath, name, template);
      setRevealDirectory((current) => ({ path: parentPath, nonce: (current?.nonce ?? 0) + 1 }));
      onStarterCreated(result);
      return;
    }
    const result = kind === "file"
      ? await window.api.resources.createFile(parentPath, name)
      : await window.api.resources.createDirectory(parentPath, name);
    setRevealDirectory((current) => ({ path: parentPath, nonce: (current?.nonce ?? 0) + 1 }));
    onEntryCreated(result);
  }

  function lifecycleMenuItems(): ContextMenuItem[] {
    const name = menu?.entry?.resourceName;
    if (!name) return [];
    const state = serverStateAvailable ? resourceStates[name.toLowerCase()] : undefined;
    const controlsBlocked = !runtimeWritable || resourceAction !== null || !serverStateAvailable || state === undefined;
    return [
      ...(!serverStateAvailable
        ? [{ label: t("resource.context.unavailable"), disabled: true, onClick: () => undefined }]
        : []),
      {
        label: t("resource.context.start", { resource: name }),
        disabled: controlsBlocked || state === "started",
        onClick: () => void onResourceAction("start", name),
      },
      {
        label: t("resource.context.restart", { resource: name }),
        disabled: controlsBlocked,
        onClick: () => void onResourceAction("restart", name),
      },
      {
        label: t("resource.context.stop", { resource: name }),
        danger: true,
        disabled: controlsBlocked || state === "stopped",
        onClick: () => void onResourceAction("stop", name),
      },
    ];
  }

  function contextMenuItems(): ContextMenuItem[] {
    if (!menu) return [];
    const entry = menu.entry;
    return [
      {
        label: t("resource.context.newFile"),
        onClick: () => setCreation({ kind: "file", parentPath: menu.targetDirectory }),
      },
      {
        label: t("resource.context.newFolder"),
        onClick: () => setCreation({ kind: "folder", parentPath: menu.targetDirectory }),
      },
      ...(menu.canCreateStarter
        ? [{
            label: t("resource.context.newResource"),
            onClick: () => setCreation({ kind: "resource" as const, parentPath: menu.targetDirectory }),
          }]
        : []),
      ...lifecycleMenuItems(),
      ...(entry?.resourceName
        ? [{ label: t("resource.context.duplicate"), onClick: () => void duplicateEntry(entry) }]
        : []),
      ...(entry
        ? [
            { label: t("resource.context.rename"), onClick: () => setRenamingPath(entry.path) },
            { label: t("resource.context.show"), onClick: () => window.api.shell.showItemInFolder(entry.path) },
            { label: t("resource.context.delete"), danger: true, onClick: () => void deleteEntry(entry) },
          ]
        : []),
    ];
  }

  if (!rootPath) {
    return <div className="tree-empty">No profile selected — open Settings and pick your txData folder and profile.</div>;
  }
  if (loadedTree?.rootPath !== rootPath) {
    if (loadError?.rootPath === rootPath) {
      return <div className="tree-empty">{loadError.message}</div>;
    }
    return <div className="tree-empty" role="status">{t("resource.tree.loading")}</div>;
  }
  const entries = loadedTree.entries;

  return (
    <>
      <div
        ref={treeRef}
        className="resource-tree-root"
        role="tree"
        aria-label={t("resource.tree.label")}
        onKeyDown={handleTreeNavigation}
        onFocusCapture={(event) => {
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "treeitem") return;
          const path = event.target.dataset.treePath;
          if (path) setFocusedPath(path);
        }}
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          openRootContextMenu(event.clientX, event.clientY);
        }}
      >
        <div
          className="tree-item resource-tree-workspace-item"
          role="treeitem"
          tabIndex={focusedPath === rootPath ? 0 : -1}
          aria-expanded={rootExpanded}
          aria-haspopup="menu"
          data-tree-path={rootPath}
          data-tree-parent-path=""
          data-tree-directory="true"
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            openRootContextMenu(bounds.left + 20, bounds.top + 20);
          }}
        >
          <div
            className="tree-node resource-tree-root-node"
            style={{ paddingLeft: 8 }}
            data-tree-action
            onClick={(event) => {
              const item = event.currentTarget.parentElement;
              setFocusedPath(rootPath);
              item?.focus();
              setRootExpanded((expanded) => !expanded);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const item = event.currentTarget.parentElement;
              setFocusedPath(rootPath);
              item?.focus();
              openRootContextMenu(event.clientX, event.clientY);
            }}
          >
            <span className="icon">{rootExpanded ? "▾" : "▸"}</span>
            <span>{t("resource.create.rootLabel")}</span>
          </div>
          {rootExpanded && (
            <div
              role="group"
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const item = event.currentTarget.parentElement;
                setFocusedPath(rootPath);
                item?.focus();
                openRootContextMenu(event.clientX, event.clientY);
              }}
            >
              {loadError?.rootPath === rootPath && (
                <div className="tree-empty" role="alert">{loadError.message}</div>
              )}
              {entries.length === 0 && <div className="tree-empty">{t("resource.tree.empty")}</div>}
              {entries.map((entry) => (
                <TreeNode
                  key={entry.path}
                  entry={entry}
                  parentPath={rootPath}
                  depth={1}
                  selectedPath={selectedPath}
                  onOpenFile={onOpenFile}
                  refreshKey={refreshKey}
                  renamingPath={renamingPath}
                  onCommitRename={commitRename}
                  onCancelRename={() => setRenamingPath(null)}
                  onContextMenu={openContextMenu}
                  resourceStates={resourceStates}
                  serverStateAvailable={serverStateAvailable}
                  insideResource={false}
                  canCreateStarterInParent={true}
                  revealDirectory={revealDirectory}
                  focusedPath={focusedPath}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={t("resource.tree.menuLabel")}
          onClose={() => setMenu(null)}
          items={contextMenuItems()}
        />
      )}
      {creation && (
        <ResourceCreationDialog
          kind={creation.kind}
          parentPath={creation.parentPath}
          onClose={() => setCreation(null)}
          onCreate={(name, template) => createEntry(creation.kind, creation.parentPath, name, template)}
        />
      )}
    </>
  );
}
