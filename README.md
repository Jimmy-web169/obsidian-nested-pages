# Nested Pages

A Notion-style page tree sidebar for Obsidian.

Notion exports every page as `Page.md` plus a same-name sibling folder `Page/` holding its sub-pages. Obsidian's file explorer shows those as two separate entries, which makes navigating a Notion-shaped vault painful. Nested Pages merges each note + same-name folder pair into a **single expandable page node**, exactly like Notion's sidebar — while plain folders keep working as simple groups of notes.

## Features

- **Merged page tree** — `AI Knowledge.md` + `AI Knowledge/` show as one row with an expand chevron. Clicking the row opens the note; the chevron expands its sub-pages. Plain folders (no same-name note) show as regular groups.
- **Simple creation** — right-click anywhere (a row or empty space) or use the `+` button: *New page* or *New folder*. Creating a page under a page builds the Notion-style nested layout automatically and keeps the parent note's link index in sync.
- **Organize** — drag & drop pages into each other, *Move to…* with fuzzy search, *Rename* (note + paired folder together, links auto-updated), *Delete* to trash with confirmation.
- **Multi-select** — Cmd/Ctrl-click several items, then move or delete them in one go.
- **Icons** — per-page icons like Notion: ~250 built-in icons in 11 categories with a 20-color palette and custom color picker, ~400 emoji in 8 categories, or any image URL. Page icons are stored in frontmatter (`icon:`), folder icons in plugin data.
- **Filter box** — type to filter the whole tree by title; matching branches auto-expand.
- **Follows the active note** — the open note is highlighted and its ancestors auto-expand. Expand state persists across restarts.

## Usage

Click the tree icon in the left ribbon, or run the command **Open nested pages**. The view opens in the left sidebar next to the regular file explorer.

## Install (manual)

1. Download `main.js`, `manifest.json`, `styles.css` from the latest [release](https://github.com/Jimmy-web169/obsidian-nested-pages/releases)
2. Place them in `<your-vault>/.obsidian/plugins/nested-pages/`
3. Enable **Nested Pages** in Settings → Community plugins

## Install (BRAT)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add beta plugin: `Jimmy-web169/obsidian-nested-pages`

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

## License

MIT
