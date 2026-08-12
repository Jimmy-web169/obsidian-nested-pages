# Notion View

A Notion-style page tree sidebar for Obsidian, built for vaults exported from Notion.

Notion exports every page as `Page.md` plus a same-name sibling folder `Page/` holding its sub-pages. Obsidian's file explorer shows those as two separate entries, which makes navigating a Notion-shaped vault painful. This plugin merges each note + same-name folder pair into a **single expandable page node**, exactly like Notion's sidebar.

## Features

- **Merged page tree** — `AI Knowledge.md` + `AI Knowledge/` show as one row with an expand chevron. Clicking the row opens the note; the chevron expands its sub-pages.
- **Quick sub-page creation** — hover any page and hit `+` (or right-click → *New sub-page*). Creates the child note in the right folder (creating the folder when needed), appends a link inside the parent note to keep the Notion-style index in sync, and opens it.
- **Filter box** — type to filter the whole tree by page title; matching branches auto-expand.
- **Follows the active note** — the open note is highlighted and its ancestors auto-expand.
- **Right-click menu** — new sub-page, open in new tab, reveal in the regular file explorer.
- Expand/collapse state is remembered across restarts.

## Usage

Click the panel icon in the left ribbon, or run the command **Open Notion view**. The view opens in the left sidebar next to the regular file explorer.

## Install (manual)

1. Build or download `main.js`, `manifest.json`, `styles.css`
2. Place them in `<your-vault>/.obsidian/plugins/notion-view/`
3. Enable **Notion View** in Settings → Community plugins

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

## License

MIT
