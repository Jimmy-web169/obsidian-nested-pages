import {
  App,
  FuzzySuggestModal,
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

const VIEW_TYPE = "notion-view";

interface NotionViewData {
  expanded: string[];
  icons: Record<string, string>;
}

const DEFAULT_DATA: NotionViewData = { expanded: [], icons: {} };

/**
 * A tree node. Two flavors, matching how the vault is organized:
 * - page: an md note; in Notion-export layout it may be paired with a
 *   same-name sibling folder that holds its sub-pages.
 * - folder: a plain folder (no same-name note) that just groups notes.
 */
interface PageNode {
  title: string;
  file: TFile | null;
  folder: TFolder | null;
  children: PageNode[];
}

function buildTree(folder: TFolder): PageNode[] {
  const mdFiles = new Map<string, TFile>();
  const subFolders: TFolder[] = [];

  for (const child of folder.children) {
    if (child instanceof TFolder) {
      subFolders.push(child);
    } else if (child instanceof TFile && child.extension === "md") {
      mdFiles.set(child.basename, child);
    }
  }

  const nodes: PageNode[] = [];
  for (const sub of subFolders) {
    const paired = mdFiles.get(sub.name) ?? null;
    if (paired) mdFiles.delete(sub.name);
    nodes.push({
      title: sub.name,
      file: paired,
      folder: sub,
      children: buildTree(sub),
    });
  }
  for (const file of mdFiles.values()) {
    nodes.push({ title: file.basename, file, folder: null, children: [] });
  }

  nodes.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return nodes;
}

/** Path that identifies a node across rebuilds (folder path wins). */
function nodeKey(node: PageNode): string {
  return node.folder?.path ?? node.file?.path ?? node.title;
}

/** Directory the node itself lives in ("" = vault root). */
function dirPathOf(node: PageNode): string {
  const parent = node.file?.parent ?? node.folder?.parent ?? null;
  return parent && parent.path !== "/" ? parent.path : "";
}

function filterTree(nodes: PageNode[], query: string): PageNode[] {
  const q = query.toLowerCase();
  const out: PageNode[] = [];
  for (const n of nodes) {
    const children = filterTree(n.children, query);
    if (n.title.toLowerCase().includes(q) || children.length > 0) {
      out.push({ ...n, children });
    }
  }
  return out;
}

function countDescendants(node: PageNode): number {
  let n = 0;
  for (const c of node.children) n += 1 + countDescendants(c);
  return n;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:#^|[\]?*"<>]/g, "").trim();
}

function isImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

class NamePromptModal extends Modal {
  private heading: string;
  private initial: string;
  private onSubmit: (value: string) => void;

  constructor(app: App, heading: string, initial: string, onSubmit: (value: string) => void) {
    super(app);
    this.heading = heading;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.heading });
    const input = contentEl.createEl("input", {
      type: "text",
      cls: "nv-name-input",
      attr: { placeholder: "Untitled" },
    });
    input.value = this.initial;
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.close();
        this.onSubmit(input.value.trim());
      } else if (ev.key === "Escape") {
        this.close();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class IconPromptModal extends Modal {
  private current: string;
  private onSubmit: (value: string) => void;

  constructor(app: App, current: string, onSubmit: (value: string) => void) {
    super(app);
    this.current = current;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Page icon" });
    const input = contentEl.createEl("input", {
      type: "text",
      cls: "nv-name-input",
      attr: { placeholder: "🔥  or  https://example.com/icon.png" },
    });
    input.value = this.current;
    contentEl.createDiv({
      cls: "nv-hint",
      text: "Paste an emoji or an image URL. Leave empty to remove the icon.",
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.close();
        this.onSubmit(input.value.trim());
      } else if (ev.key === "Escape") {
        this.close();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  private message: string;
  private cta: string;
  private onConfirm: () => void;

  constructor(app: App, message: string, cta: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.cta = cta;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    const row = contentEl.createDiv({ cls: "nv-confirm-row" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const ok = row.createEl("button", { text: this.cta, cls: "mod-warning" });
    ok.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface MoveTarget {
  label: string;
  node: PageNode | null; // null = vault root
}

class MoveTargetModal extends FuzzySuggestModal<MoveTarget> {
  private targets: MoveTarget[];
  private onChoose: (target: MoveTarget) => void;

  constructor(app: App, targets: MoveTarget[], onChoose: (target: MoveTarget) => void) {
    super(app);
    this.targets = targets;
    this.onChoose = onChoose;
    this.setPlaceholder("Move to…");
  }

  getItems(): MoveTarget[] {
    return this.targets;
  }

  getItemText(item: MoveTarget): string {
    return item.label;
  }

  onChooseItem(item: MoveTarget): void {
    this.onChoose(item);
  }
}

class NotionView extends ItemView {
  private plugin: NotionViewPlugin;
  private treeEl: HTMLElement | null = null;
  private query = "";
  private refreshTimer: number | null = null;
  private nodeMap: Map<string, PageNode> = new Map();
  private dragKey: string | null = null;
  private selection: Set<string> = new Set();

  constructor(leaf: WorkspaceLeaf, plugin: NotionViewPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Notion view";
  }

  getIcon(): string {
    return "panel-left";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("nv-container");

    const header = container.createDiv({ cls: "nv-header" });
    const searchWrap = header.createDiv({ cls: "nv-search" });
    const searchIcon = searchWrap.createSpan({ cls: "nv-search-icon" });
    setIcon(searchIcon, "search");
    const search = searchWrap.createEl("input", {
      type: "text",
      attr: { placeholder: "Filter pages…" },
    });
    search.addEventListener("input", () => {
      this.query = search.value.trim();
      this.renderTree();
    });

    const newBtn = header.createDiv({ cls: "nv-new-btn", attr: { "aria-label": "New…" } });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", (ev) => this.showCreateMenu(ev, ""));

    this.treeEl = container.createDiv({ cls: "nv-tree" });

    // Right-click / click on empty space = act on the top level.
    this.treeEl.addEventListener("contextmenu", (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest(".nv-row")) return;
      ev.preventDefault();
      this.showCreateMenu(ev, "");
    });
    this.treeEl.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      if (!target.closest(".nv-row")) this.clearSelection();
    });

    // Drop on empty tree area = move to vault root.
    this.treeEl.addEventListener("dragover", (ev) => {
      if (this.dragKey === null || ev.target !== this.treeEl) return;
      ev.preventDefault();
      this.treeEl?.addClass("nv-drop-root");
    });
    this.treeEl.addEventListener("dragleave", (ev) => {
      if (ev.target === this.treeEl) this.treeEl?.removeClass("nv-drop-root");
    });
    this.treeEl.addEventListener("drop", (ev) => {
      this.treeEl?.removeClass("nv-drop-root");
      if (this.dragKey === null || ev.target !== this.treeEl) return;
      ev.preventDefault();
      const nodes = this.draggedNodes();
      this.dragKey = null;
      void this.moveNodes(nodes, null);
    });

    this.renderTree();

    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    // Re-render when frontmatter (page icons) changes.
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) this.revealFile(file);
        this.updateActive();
      })
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.renderTree();
    }, 200);
  }

  private renderTree(): void {
    if (!this.treeEl) return;
    this.treeEl.empty();
    this.nodeMap.clear();
    let nodes = buildTree(this.app.vault.getRoot());
    const filtering = this.query.length > 0;
    if (filtering) nodes = filterTree(nodes, this.query);
    if (nodes.length === 0) {
      this.treeEl.createDiv({ cls: "nv-empty", text: filtering ? "No matching pages" : "No pages" });
      return;
    }
    for (const node of nodes) this.renderNode(node, this.treeEl, 0, filtering);
    // Drop selection entries that no longer exist.
    for (const key of Array.from(this.selection)) {
      if (!this.nodeMap.has(key)) this.selection.delete(key);
    }
    this.updateActive();
  }

  private renderNode(node: PageNode, parent: HTMLElement, depth: number, forceExpand: boolean): void {
    const key = nodeKey(node);
    this.nodeMap.set(key, node);
    const hasChildren = node.children.length > 0;
    const expanded = forceExpand || this.plugin.expanded.has(key);

    const item = parent.createDiv({ cls: "nv-item" });
    const row = item.createDiv({ cls: "nv-row" });
    row.style.paddingLeft = `${depth * 16 + 4}px`;
    row.dataset.key = key;
    if (node.file) row.dataset.path = node.file.path;
    if (this.selection.has(key)) row.addClass("nv-selected");

    const chevron = row.createSpan({ cls: "nv-chevron" });
    if (hasChildren) {
      setIcon(chevron, "chevron-right");
      if (expanded) chevron.addClass("nv-open");
      chevron.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.toggle(key);
      });
    } else {
      chevron.addClass("nv-chevron-empty");
    }

    const icon = row.createSpan({ cls: "nv-icon" });
    const custom = this.customIconOf(node);
    if (custom && isImageUrl(custom)) {
      const img = icon.createEl("img", { cls: "nv-icon-img" });
      img.src = custom;
      img.addEventListener("error", () => {
        img.remove();
        setIcon(icon, node.file ? "file-text" : "folder");
      });
    } else if (custom) {
      icon.addClass("nv-icon-emoji");
      icon.setText(custom);
    } else {
      setIcon(icon, node.file ? "file-text" : "folder");
    }

    row.createSpan({ cls: "nv-title", text: node.title });

    const addBtn = row.createSpan({ cls: "nv-row-btn", attr: { "aria-label": "New inside" } });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void (async () => {
        const dir = await this.ensureContainer(node);
        this.showCreateMenu(ev, dir);
      })();
    });

    row.addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey) {
        this.toggleSelect(key);
        return;
      }
      this.clearSelection();
      if (node.file) {
        void this.app.workspace.getLeaf(false).openFile(node.file);
      } else if (hasChildren) {
        this.toggle(key);
      }
    });

    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (this.selection.has(key) && this.selection.size > 1) {
        this.showMultiMenu(ev);
      } else {
        this.clearSelection();
        this.showNodeMenu(ev, node);
      }
    });

    // --- Drag & drop: drag a row onto another row to nest it there ---
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      this.dragKey = key;
      ev.dataTransfer?.setData("text/plain", key);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      this.dragKey = null;
      this.treeEl?.querySelectorAll(".nv-drop").forEach((el) => el.removeClass("nv-drop"));
    });
    row.addEventListener("dragover", (ev) => {
      if (this.dragKey === null || this.dragKey === key) return;
      ev.preventDefault();
      row.addClass("nv-drop");
    });
    row.addEventListener("dragleave", () => row.removeClass("nv-drop"));
    row.addEventListener("drop", (ev) => {
      ev.preventDefault();
      row.removeClass("nv-drop");
      if (this.dragKey === null || this.dragKey === key) return;
      const nodes = this.draggedNodes();
      this.dragKey = null;
      void this.moveNodes(nodes, node);
    });

    if (hasChildren && expanded) {
      const childrenEl = item.createDiv({ cls: "nv-children" });
      for (const child of node.children) {
        this.renderNode(child, childrenEl, depth + 1, forceExpand);
      }
    }
  }

  // ----- Selection -----

  private toggleSelect(key: string): void {
    if (this.selection.has(key)) this.selection.delete(key);
    else this.selection.add(key);
    this.rowEl(key)?.toggleClass("nv-selected", this.selection.has(key));
  }

  private clearSelection(): void {
    for (const key of this.selection) this.rowEl(key)?.removeClass("nv-selected");
    this.selection.clear();
  }

  private rowEl(key: string): HTMLElement | null {
    return this.treeEl?.querySelector(`.nv-row[data-key="${CSS.escape(key)}"]`) ?? null;
  }

  private selectedNodes(): PageNode[] {
    const nodes: PageNode[] = [];
    for (const key of this.selection) {
      const n = this.nodeMap.get(key);
      if (n) nodes.push(n);
    }
    return nodes;
  }

  /** The set being dragged: the whole selection if dragging a selected row. */
  private draggedNodes(): PageNode[] {
    if (this.dragKey === null) return [];
    if (this.selection.has(this.dragKey) && this.selection.size > 1) {
      return this.selectedNodes();
    }
    const n = this.nodeMap.get(this.dragKey);
    return n ? [n] : [];
  }

  /** Drop nodes whose ancestor is also in the list (they move with it). */
  private dedupeNested(nodes: PageNode[]): PageNode[] {
    const folderPaths = nodes.filter((n) => n.folder).map((n) => (n.folder as TFolder).path);
    return nodes.filter((n) => {
      const path = nodeKey(n);
      return !folderPaths.some((fp) => path !== fp && path.startsWith(fp + "/"));
    });
  }

  // ----- Menus -----

  /** "New page / New folder" — used by header +, row +, and empty space. */
  private showCreateMenu(ev: MouseEvent, dir: string): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("New page").setIcon("file-plus").onClick(() => {
        this.promptName("New page name", "", (raw) => void this.createPage(dir, raw));
      })
    );
    menu.addItem((i) =>
      i.setTitle("New folder").setIcon("folder-plus").onClick(() => {
        this.promptName("New folder name", "", (raw) => void this.createFolder(dir, raw));
      })
    );
    menu.showAtMouseEvent(ev);
  }

  private showNodeMenu(ev: MouseEvent, node: PageNode): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("New page").setIcon("file-plus").onClick(() => {
        this.promptName("New page name", "", (raw) => {
          void (async () => {
            const dir = await this.ensureContainer(node);
            await this.createPage(dir, raw);
          })();
        });
      })
    );
    menu.addItem((i) =>
      i.setTitle("New folder").setIcon("folder-plus").onClick(() => {
        this.promptName("New folder name", "", (raw) => {
          void (async () => {
            const dir = await this.ensureContainer(node);
            await this.createFolder(dir, raw);
          })();
        });
      })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Change icon…").setIcon("smile").onClick(() => {
        new IconPromptModal(this.app, this.customIconOf(node) ?? "", (value) => {
          void this.setNodeIcon(node, value);
        }).open();
      })
    );
    menu.addItem((i) =>
      i.setTitle("Rename").setIcon("pencil").onClick(() => {
        this.promptName("Rename", node.title, (raw) => void this.renameNode(node, raw));
      })
    );
    menu.addItem((i) =>
      i.setTitle("Move to…").setIcon("corner-down-right").onClick(() => {
        new MoveTargetModal(this.app, this.buildTargets([node]), (target) => {
          void this.moveNodes([node], target.node);
        }).open();
      })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Delete").setIcon("trash").onClick(() => {
        const n = countDescendants(node);
        if (n > 0) {
          new ConfirmModal(
            this.app,
            `Delete "${node.title}" and ${n} item${n === 1 ? "" : "s"} inside it? They go to the trash.`,
            "Delete",
            () => void this.deleteNodes([node])
          ).open();
        } else {
          void this.deleteNodes([node]);
        }
      })
    );
    menu.showAtMouseEvent(ev);
  }

  private showMultiMenu(ev: MouseEvent): void {
    const nodes = this.dedupeNested(this.selectedNodes());
    const count = this.selection.size;
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle(`Move ${count} items to…`).setIcon("corner-down-right").onClick(() => {
        new MoveTargetModal(this.app, this.buildTargets(nodes), (target) => {
          void this.moveNodes(nodes, target.node);
        }).open();
      })
    );
    menu.addItem((i) =>
      i.setTitle(`Delete ${count} items`).setIcon("trash").onClick(() => {
        new ConfirmModal(
          this.app,
          `Delete ${count} selected items (and everything inside them)? They go to the trash.`,
          "Delete",
          () => void this.deleteNodes(nodes)
        ).open();
      })
    );
    menu.showAtMouseEvent(ev);
  }

  // ----- Tree state -----

  private toggle(key: string): void {
    if (this.plugin.expanded.has(key)) this.plugin.expanded.delete(key);
    else this.plugin.expanded.add(key);
    void this.plugin.persist();
    this.renderTree();
  }

  /** Expand all ancestor folders of a file so its row is visible. */
  private revealFile(file: TFile): void {
    let changed = false;
    let dir: TFolder | null = file.parent;
    while (dir && dir.path !== "/") {
      if (!this.plugin.expanded.has(dir.path)) {
        this.plugin.expanded.add(dir.path);
        changed = true;
      }
      dir = dir.parent;
    }
    if (changed) {
      void this.plugin.persist();
      this.renderTree();
    }
  }

  private updateActive(): void {
    if (!this.treeEl) return;
    const active = this.app.workspace.getActiveFile();
    this.treeEl.querySelectorAll(".nv-row.nv-active").forEach((el) => el.removeClass("nv-active"));
    if (!active) return;
    const row = this.treeEl.querySelector(`.nv-row[data-path="${CSS.escape(active.path)}"]`);
    row?.addClass("nv-active");
  }

  private promptName(heading: string, initial: string, cb: (raw: string) => void): void {
    new NamePromptModal(this.app, heading, initial, cb).open();
  }

  // ----- Icons -----

  private customIconOf(node: PageNode): string | null {
    if (node.file) {
      const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter;
      const v = fm?.icon;
      return typeof v === "string" && v.trim() ? v.trim() : null;
    }
    if (node.folder) return this.plugin.icons[node.folder.path] ?? null;
    return null;
  }

  private async setNodeIcon(node: PageNode, value: string): Promise<void> {
    const v = value.trim();
    try {
      if (node.file) {
        // Stored in frontmatter so the icon travels with the note.
        await this.app.fileManager.processFrontMatter(node.file, (fm) => {
          if (v) fm.icon = v;
          else delete fm.icon;
        });
      } else if (node.folder) {
        if (v) this.plugin.icons[node.folder.path] = v;
        else delete this.plugin.icons[node.folder.path];
        await this.plugin.persist();
      }
      this.scheduleRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to set icon: ${msg}`);
    }
  }

  // ----- Create / rename / delete / move -----

  /**
   * Folder that holds this node's children. For a plain folder that's the
   * folder itself; for a page it's the Notion-style paired folder, created
   * on demand.
   */
  private async ensureContainer(node: PageNode): Promise<string> {
    if (node.folder) return node.folder.path;
    const file = node.file as TFile;
    const base = dirPathOf(node);
    const dir = (base ? base + "/" : "") + file.basename;
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir);
    }
    return dir;
  }

  /** Create a new page (md note) inside dir ("" = vault root). */
  private async createPage(dir: string, rawName: string): Promise<void> {
    const name = sanitizeFileName(rawName) || "Untitled";
    try {
      const prefix = dir ? dir + "/" : "";
      let path = `${prefix}${name}.md`;
      for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
        path = `${prefix}${name} ${i}.md`;
      }
      const newFile = await this.app.vault.create(path, "");
      await this.appendLinkToParentNote(dir, newFile);
      if (dir) this.plugin.expanded.add(dir);
      await this.plugin.persist();
      await this.app.workspace.getLeaf(false).openFile(newFile);
      new Notice(`Created "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to create page: ${msg}`);
    }
  }

  /** Create a plain folder inside dir ("" = vault root). */
  private async createFolder(dir: string, rawName: string): Promise<void> {
    const name = sanitizeFileName(rawName) || "Untitled";
    try {
      const prefix = dir ? dir + "/" : "";
      let path = `${prefix}${name}`;
      for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
        path = `${prefix}${name} ${i}`;
      }
      await this.app.vault.createFolder(path);
      if (dir) this.plugin.expanded.add(dir);
      this.plugin.expanded.add(path);
      await this.plugin.persist();
      new Notice(`Created folder "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to create folder: ${msg}`);
    }
  }

  /** Rename a node: md note and paired folder stay in sync. */
  private async renameNode(node: PageNode, rawName: string): Promise<void> {
    const name = sanitizeFileName(rawName);
    if (!name || name === node.title) return;
    const base = dirPathOf(node);
    const prefix = base ? base + "/" : "";
    if (
      (node.file && this.app.vault.getAbstractFileByPath(`${prefix}${name}.md`)) ||
      (node.folder && this.app.vault.getAbstractFileByPath(prefix + name))
    ) {
      new Notice(`"${name}" already exists here`);
      return;
    }
    try {
      // renameFile updates every link pointing at the renamed note/folder.
      if (node.file) {
        await this.app.fileManager.renameFile(node.file, `${prefix}${name}.md`);
      }
      if (node.folder) {
        await this.app.fileManager.renameFile(node.folder, prefix + name);
      }
      new Notice(`Renamed to "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Rename failed: ${msg}`);
    }
  }

  /** Trash nodes (md note + paired folder), syncing parent note indexes. */
  private async deleteNodes(nodes: PageNode[]): Promise<void> {
    for (const node of nodes) {
      try {
        if (node.file) {
          await this.removeLinkFromParentNote(dirPathOf(node), node.file);
          await this.app.fileManager.trashFile(node.file);
        }
        if (node.folder) {
          await this.app.fileManager.trashFile(node.folder);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Delete failed for "${node.title}": ${msg}`);
        return;
      }
    }
    this.clearSelection();
    new Notice(nodes.length === 1 ? `Deleted "${nodes[0].title}"` : `Deleted ${nodes.length} items`);
  }

  private buildTargets(exclude: PageNode[]): MoveTarget[] {
    const excludeKeys = new Set(exclude.map(nodeKey));
    const excludeFolders = exclude.filter((n) => n.folder).map((n) => (n.folder as TFolder).path);
    const targets: MoveTarget[] = [{ label: "/ (vault root)", node: null }];
    const walk = (nodes: PageNode[], chain: string): void => {
      for (const n of nodes) {
        const key = nodeKey(n);
        const label = chain ? `${chain} / ${n.title}` : n.title;
        const isExcluded =
          excludeKeys.has(key) || excludeFolders.some((fp) => key.startsWith(fp + "/"));
        if (!isExcluded) {
          targets.push({ label, node: n });
          walk(n.children, label);
        }
      }
    };
    walk(buildTree(this.app.vault.getRoot()), "");
    return targets;
  }

  /** Move nodes to become children of `target` (null = vault root). */
  private async moveNodes(nodes: PageNode[], target: PageNode | null): Promise<void> {
    if (nodes.length === 0) return;
    try {
      const dir = target ? await this.ensureContainer(target) : "";
      for (const node of this.dedupeNested(nodes)) {
        await this.moveNode(node, dir);
      }
      this.clearSelection();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Move failed: ${msg}`);
    }
  }

  /** Move a node (md note + paired folder) into `dir` ("" = vault root). */
  private async moveNode(node: PageNode, dir: string): Promise<void> {
    if (node.folder && (dir === node.folder.path || dir.startsWith(node.folder.path + "/"))) {
      new Notice("Cannot move into itself");
      return;
    }
    const oldDir = dirPathOf(node);
    if (dir === oldDir) return;

    const prefix = dir ? dir + "/" : "";
    const clash =
      (node.file && this.app.vault.getAbstractFileByPath(prefix + node.file.name)) ||
      (node.folder && this.app.vault.getAbstractFileByPath(prefix + node.folder.name));
    if (clash) {
      new Notice(`"${node.title}" already exists in the target`);
      return;
    }

    try {
      if (node.file) await this.removeLinkFromParentNote(oldDir, node.file);
      // fileManager.renameFile updates every link pointing at the moved files.
      if (node.file) {
        await this.app.fileManager.renameFile(node.file, prefix + node.file.name);
      }
      if (node.folder) {
        await this.app.fileManager.renameFile(node.folder, prefix + node.folder.name);
      }
      const movedNote = node.file
        ? this.app.vault.getAbstractFileByPath(prefix + node.file.name)
        : null;
      if (movedNote instanceof TFile) {
        await this.appendLinkToParentNote(dir, movedNote);
      }
      if (dir) this.plugin.expanded.add(dir);
      await this.plugin.persist();
      new Notice(`Moved "${node.title}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Move failed: ${msg}`);
    }
  }

  /** For folder "A/B", the parent note is "A/B.md" (Notion export layout). */
  private parentNoteOf(dir: string): TFile | null {
    if (!dir) return null;
    const note = this.app.vault.getAbstractFileByPath(dir + ".md");
    return note instanceof TFile ? note : null;
  }

  /**
   * Notion-style index sync: if the containing folder has a same-name note,
   * append a link to the new/moved page there. Plain folders (no paired
   * note) are left alone.
   */
  private async appendLinkToParentNote(dir: string, file: TFile): Promise<void> {
    const parentNote = this.parentNoteOf(dir);
    if (!parentNote) return;
    const link = this.app.fileManager.generateMarkdownLink(file, parentNote.path);
    const content = await this.app.vault.read(parentNote);
    const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    await this.app.vault.modify(parentNote, content + sep + link + "\n");
  }

  /** Remove lines in the old parent note that only carried a link to `file`. */
  private async removeLinkFromParentNote(dir: string, file: TFile): Promise<void> {
    const parentNote = this.parentNoteOf(dir);
    if (!parentNote) return;
    const cache = this.app.metadataCache.getFileCache(parentNote);
    const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
    const linesToDrop = new Set<number>();
    for (const ref of refs) {
      const linkPath = ref.link.split("#")[0];
      const dest = this.app.metadataCache.getFirstLinkpathDest(linkPath, parentNote.path);
      if (dest?.path === file.path) {
        linesToDrop.add(ref.position.start.line);
      }
    }
    if (linesToDrop.size === 0) return;
    const content = await this.app.vault.read(parentNote);
    const lines = content.split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (linesToDrop.has(i)) {
        // Also swallow one following blank line so we don't leave double gaps.
        if (i + 1 < lines.length && lines[i + 1].trim() === "") i++;
        continue;
      }
      kept.push(lines[i]);
    }
    await this.app.vault.modify(parentNote, kept.join("\n"));
  }
}

export default class NotionViewPlugin extends Plugin {
  expanded: Set<string> = new Set();
  icons: Record<string, string> = {};

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? DEFAULT_DATA) as NotionViewData;
    this.expanded = new Set(data.expanded ?? []);
    this.icons = data.icons ?? {};

    this.registerView(VIEW_TYPE, (leaf) => new NotionView(leaf, this));

    // Keep folder icons attached across renames/moves.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.icons[oldPath]) {
          this.icons[file.path] = this.icons[oldPath];
          delete this.icons[oldPath];
          void this.persist();
        }
      })
    );

    this.addRibbonIcon("panel-left", "Open Notion view", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-notion-view",
      name: "Open Notion view",
      callback: () => void this.activateView(),
    });
  }

  onunload(): void {
    // Obsidian detaches our views automatically.
  }

  async persist(): Promise<void> {
    await this.saveData({
      expanded: Array.from(this.expanded),
      icons: this.icons,
    } satisfies NotionViewData);
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
