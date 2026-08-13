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
}

const DEFAULT_DATA: NotionViewData = { expanded: [] };

/**
 * A "page" in the Notion sense: an md note, optionally paired with a
 * same-name sibling folder that holds its sub-pages (Notion export layout).
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

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:#^|[\]?*"<>]/g, "").trim();
}

class NamePromptModal extends Modal {
  private heading: string;
  private onSubmit: (value: string) => void;

  constructor(app: App, heading: string, onSubmit: (value: string) => void) {
    super(app);
    this.heading = heading;
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
    setTimeout(() => input.focus(), 0);
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
    this.setPlaceholder("Move to page…");
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

    const newBtn = header.createDiv({ cls: "nv-new-btn", attr: { "aria-label": "New page or section" } });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", (ev) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i.setTitle("New page (top level)").setIcon("file-plus").onClick(() => {
          this.promptName("New page name", (raw) => void this.createPage("", raw));
        })
      );
      menu.addItem((i) =>
        i.setTitle("New section (top level)").setIcon("folder-plus").onClick(() => {
          this.promptName("New section name", (raw) => void this.createSection("", raw));
        })
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("New page under…").setIcon("file-plus").onClick(() => {
          this.pickParentThen("New page name", (dir, raw) => void this.createPage(dir, raw));
        })
      );
      menu.addItem((i) =>
        i.setTitle("New section under…").setIcon("folder-plus").onClick(() => {
          this.pickParentThen("New section name", (dir, raw) => void this.createSection(dir, raw));
        })
      );
      menu.showAtMouseEvent(ev);
    });

    this.treeEl = container.createDiv({ cls: "nv-tree" });

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
      const node = this.nodeMap.get(this.dragKey);
      this.dragKey = null;
      if (node) void this.moveNode(node, "");
    });

    this.renderTree();

    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
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
    }, 150);
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
    if (node.file) row.dataset.path = node.file.path;

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
    setIcon(icon, node.folder ? "folder" : "file-text");

    row.createSpan({ cls: "nv-title", text: node.title });

    const addBtn = row.createSpan({ cls: "nv-row-btn", attr: { "aria-label": "New sub-page" } });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.promptSubPage(node);
    });

    row.addEventListener("click", () => {
      if (node.file) {
        void this.app.workspace.getLeaf(false).openFile(node.file);
      } else if (hasChildren) {
        this.toggle(key);
      }
    });

    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.showMenu(ev, node);
    });

    // --- Drag & drop: drag a page onto another page to nest it there ---
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
      const dragged = this.nodeMap.get(this.dragKey);
      this.dragKey = null;
      if (dragged) void this.moveIntoPage(dragged, node);
    });

    if (hasChildren && expanded) {
      const childrenEl = item.createDiv({ cls: "nv-children" });
      for (const child of node.children) {
        this.renderNode(child, childrenEl, depth + 1, forceExpand);
      }
    }
  }

  private showMenu(ev: MouseEvent, node: PageNode): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("New sub-page").setIcon("plus").onClick(() => this.promptSubPage(node))
    );
    menu.addItem((i) =>
      i.setTitle("New sub-section").setIcon("folder-plus").onClick(() => {
        this.promptName("New section name", (raw) => {
          void (async () => {
            const dir = await this.ensureContainer(node);
            await this.createSection(dir, raw);
          })();
        });
      })
    );
    menu.addItem((i) =>
      i.setTitle("New sibling page").setIcon("copy-plus").onClick(() => {
        this.promptName("New page name", (raw) => void this.createPage(dirPathOf(node), raw));
      })
    );
    menu.addItem((i) =>
      i.setTitle("New sibling section").setIcon("folder-plus").onClick(() => {
        this.promptName("New section name", (raw) => void this.createSection(dirPathOf(node), raw));
      })
    );
    menu.addItem((i) =>
      i.setTitle("Wrap in new parent page…").setIcon("folder-input").onClick(() => {
        this.promptName("New parent page name", (raw) => void this.wrapInParent(node, raw));
      })
    );
    menu.addItem((i) =>
      i.setTitle("Move to page…").setIcon("corner-down-right").onClick(() => this.openMoveModal(node))
    );
    menu.addSeparator();
    if (node.file) {
      const file = node.file;
      menu.addItem((i) =>
        i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => {
          void this.app.workspace.getLeaf("tab").openFile(file);
        })
      );
    }
    const target = node.file ?? node.folder;
    if (target) {
      menu.addItem((i) =>
        i.setTitle("Reveal in file explorer").setIcon("folder-open").onClick(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const explorer = (this.app as any).internalPlugins?.plugins?.["file-explorer"]?.instance;
          explorer?.revealInFolder?.(target);
        })
      );
    }
    menu.showAtMouseEvent(ev);
  }

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

  private promptName(heading: string, cb: (raw: string) => void): void {
    new NamePromptModal(this.app, heading, cb).open();
  }

  private promptSubPage(node: PageNode): void {
    this.promptName("New page name", (raw) => {
      void (async () => {
        const dir = await this.ensureContainer(node);
        await this.createPage(dir, raw);
      })();
    });
  }

  /** Folder that holds this page's children, created on demand. */
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

  /**
   * Create a section: a folder plus its same-name note (Notion export
   * layout), ready to hold sub-pages, inside dir ("" = vault root).
   */
  private async createSection(dir: string, rawName: string): Promise<void> {
    const name = sanitizeFileName(rawName) || "Untitled";
    try {
      const prefix = dir ? dir + "/" : "";
      let base = name;
      for (
        let i = 2;
        this.app.vault.getAbstractFileByPath(prefix + base) ||
        this.app.vault.getAbstractFileByPath(`${prefix}${base}.md`);
        i++
      ) {
        base = `${name} ${i}`;
      }
      await this.app.vault.createFolder(prefix + base);
      const note = await this.app.vault.create(`${prefix}${base}.md`, "");
      await this.appendLinkToParentNote(dir, note);
      if (dir) this.plugin.expanded.add(dir);
      this.plugin.expanded.add(prefix + base);
      await this.plugin.persist();
      await this.app.workspace.getLeaf(false).openFile(note);
      new Notice(`Created section "${base}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to create section: ${msg}`);
    }
  }

  /**
   * Create a new parent page beside `node`, then move `node` inside it —
   * turns a loose page into a child of a brand-new section.
   */
  private async wrapInParent(node: PageNode, rawName: string): Promise<void> {
    const name = sanitizeFileName(rawName) || "Untitled";
    try {
      const base = dirPathOf(node);
      const prefix = base ? base + "/" : "";
      if (
        this.app.vault.getAbstractFileByPath(`${prefix}${name}`) ||
        this.app.vault.getAbstractFileByPath(`${prefix}${name}.md`)
      ) {
        new Notice(`"${name}" already exists here`);
        return;
      }
      await this.app.vault.createFolder(`${prefix}${name}`);
      const parentNote = await this.app.vault.create(`${prefix}${name}.md`, "");
      await this.moveNode(node, `${prefix}${name}`);
      this.plugin.expanded.add(`${prefix}${name}`);
      await this.plugin.persist();
      await this.app.workspace.getLeaf(false).openFile(parentNote);
      new Notice(`Created parent "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to create parent: ${msg}`);
    }
  }

  private buildTargets(exclude: PageNode | null): MoveTarget[] {
    const excludeKey = exclude ? nodeKey(exclude) : null;
    const targets: MoveTarget[] = [{ label: "/ (vault root)", node: null }];
    const walk = (nodes: PageNode[], chain: string): void => {
      for (const n of nodes) {
        const key = nodeKey(n);
        const label = chain ? `${chain} / ${n.title}` : n.title;
        const isExcluded =
          key === excludeKey ||
          (exclude?.folder != null && key.startsWith(exclude.folder.path + "/"));
        if (!isExcluded) {
          targets.push({ label, node: n });
          walk(n.children, label);
        }
      }
    };
    walk(buildTree(this.app.vault.getRoot()), "");
    return targets;
  }

  private openMoveModal(node: PageNode): void {
    new MoveTargetModal(this.app, this.buildTargets(node), (target) => {
      void this.moveIntoPage(node, target.node);
    }).open();
  }

  /** Fuzzy-pick a parent page, then prompt for a name and create there. */
  private pickParentThen(heading: string, create: (dir: string, raw: string) => void): void {
    new MoveTargetModal(this.app, this.buildTargets(null), (target) => {
      this.promptName(heading, (raw) => {
        void (async () => {
          const dir = target.node ? await this.ensureContainer(target.node) : "";
          create(dir, raw);
        })();
      });
    }).open();
  }

  /** Move `node` to become a child of `target` (null = vault root). */
  private async moveIntoPage(node: PageNode, target: PageNode | null): Promise<void> {
    try {
      const dir = target ? await this.ensureContainer(target) : "";
      await this.moveNode(node, dir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Move failed: ${msg}`);
    }
  }

  /** Move a page (md + paired folder) into `dir` ("" = vault root). */
  private async moveNode(node: PageNode, dir: string): Promise<void> {
    if (node.folder && (dir === node.folder.path || dir.startsWith(node.folder.path + "/"))) {
      new Notice("Cannot move a page into itself");
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

  /** Keep the Notion-style index in sync: append a link in the parent note. */
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

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? DEFAULT_DATA) as NotionViewData;
    this.expanded = new Set(data.expanded ?? []);

    this.registerView(VIEW_TYPE, (leaf) => new NotionView(leaf, this));

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
    await this.saveData({ expanded: Array.from(this.expanded) } satisfies NotionViewData);
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
