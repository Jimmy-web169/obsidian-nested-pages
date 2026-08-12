import {
  App,
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

class NotionView extends ItemView {
  private plugin: NotionViewPlugin;
  private treeEl: HTMLElement | null = null;
  private query = "";
  private refreshTimer: number | null = null;

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

    const newBtn = header.createDiv({ cls: "nv-new-btn", attr: { "aria-label": "New root page" } });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", () => {
      this.promptCreate(this.app.vault.getRoot(), null);
    });

    this.treeEl = container.createDiv({ cls: "nv-tree" });
    this.renderTree();

    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) this.revealFile(file, false);
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
    setIcon(icon, node.file ? "file-text" : "folder");

    row.createSpan({ cls: "nv-title", text: node.title });

    const addBtn = row.createSpan({ cls: "nv-row-btn", attr: { "aria-label": "New sub-page" } });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.promptCreateUnder(node);
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
      i.setTitle("New sub-page").setIcon("plus").onClick(() => this.promptCreateUnder(node))
    );
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
  private revealFile(file: TFile, rerenderAlways: boolean): void {
    let changed = false;
    let dir: TFolder | null = file.parent;
    while (dir && dir.path !== "/") {
      if (!this.plugin.expanded.has(dir.path)) {
        this.plugin.expanded.add(dir.path);
        changed = true;
      }
      dir = dir.parent;
    }
    if (changed) void this.plugin.persist();
    if (changed || rerenderAlways) this.renderTree();
  }

  private updateActive(): void {
    if (!this.treeEl) return;
    const active = this.app.workspace.getActiveFile();
    this.treeEl.querySelectorAll(".nv-row.nv-active").forEach((el) => el.removeClass("nv-active"));
    if (!active) return;
    const row = this.treeEl.querySelector(`.nv-row[data-path="${CSS.escape(active.path)}"]`);
    row?.addClass("nv-active");
  }

  private promptCreateUnder(node: PageNode): void {
    // Children live in the paired folder; create it beside the note if missing.
    if (node.folder) {
      this.promptCreate(node.folder, null);
    } else if (node.file) {
      const parentPath = node.file.parent && node.file.parent.path !== "/" ? node.file.parent.path + "/" : "";
      this.promptCreate(null, parentPath + node.file.basename);
    }
  }

  private promptCreate(folder: TFolder | null, folderPathToCreate: string | null): void {
    new NamePromptModal(this.app, "New page name", (raw) => {
      void this.createPage(folder, folderPathToCreate, raw);
    }).open();
  }

  private async createPage(
    folder: TFolder | null,
    folderPathToCreate: string | null,
    rawName: string
  ): Promise<void> {
    const name = sanitizeFileName(rawName) || "Untitled";
    try {
      let dir: string;
      if (folder) {
        dir = folder.path === "/" ? "" : folder.path;
      } else if (folderPathToCreate !== null) {
        dir = folderPathToCreate;
        if (!this.app.vault.getAbstractFileByPath(dir)) {
          await this.app.vault.createFolder(dir);
        }
      } else {
        return;
      }

      const prefix = dir ? dir + "/" : "";
      let path = `${prefix}${name}.md`;
      for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
        path = `${prefix}${name} ${i}.md`;
      }
      const newFile = await this.app.vault.create(path, "");

      // Keep the Notion-style index in sync: append a link inside the parent
      // page's note (the md paired with the folder we created into).
      const parentNote = this.findParentNote(dir);
      if (parentNote) {
        const link = this.app.fileManager.generateMarkdownLink(newFile, parentNote.path);
        const content = await this.app.vault.read(parentNote);
        const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
        await this.app.vault.modify(parentNote, content + sep + link + "\n");
      }

      this.plugin.expanded.add(dir || "/");
      await this.plugin.persist();
      await this.app.workspace.getLeaf(false).openFile(newFile);
      new Notice(`Created "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to create page: ${msg}`);
    }
  }

  /** For folder "A/B", the parent note is "A/B.md" (Notion export layout). */
  private findParentNote(dir: string): TFile | null {
    if (!dir) return null;
    const note = this.app.vault.getAbstractFileByPath(dir + ".md");
    return note instanceof TFile ? note : null;
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
