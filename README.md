# DocMap — Content Impact Visualizer

A chatbot-style web app that generates a visual mind map of every documentation page you need to create, modify, or remove when a product change ships.

## Features

- **Chat interface** — talk to DocMap like a colleague; it asks focused questions and builds the map as you go
- **Multi-source input** — paste Jira ticket text, GitHub repo URLs (README auto-fetched), release notes, specs, plain descriptions
- **Image support** — upload or paste screenshots; Claude reads them via vision
- **Live mind map** — Cytoscape.js canvas updates after each Claude response; color-coded by action type
- **Node detail panel** — click any node for What / Where / How / Content hints with page URL if known
- **Ask in chat** — "Ask DocMap about this node" sends the node context back into the conversation
- **Export** — download the map as PNG

## Setup

1. Push this folder to a GitHub repo and enable GitHub Pages (Settings → Pages → Deploy from `main` / `root`)
2. Open your Pages URL and enter your [Anthropic API key](https://console.anthropic.com/settings/keys)
3. Start chatting

**Local testing** (CORS requires a server — `file://` won't work):
```
npx serve .
```
Then open `http://localhost:3000`.

## Inputs DocMap understands

| Input | How to provide |
|---|---|
| Jira ticket | Paste the ticket description or copy-paste the full ticket text |
| GitHub repo | Paste the GitHub URL — DocMap auto-fetches the README |
| Release notes | Paste text directly into the chat |
| Images / screenshots | Click the paperclip, or paste with Ctrl+V |
| Text files (.txt, .md, .json) | Click the paperclip to upload |

## Mind map node types

| Color | Type | Meaning |
|---|---|---|
| 🟢 Green | Create | New page or section to write |
| 🟡 Amber | Modify | Existing page to update |
| 🔴 Red | Remove | Content to deprecate or delete |
| 🔵 Blue | Reference | Add cross-links or mentions |

## Keyboard shortcuts

| Key | Action |
|---|---|
| Ctrl+Enter | Send message |
| Ctrl+V (in chat) | Paste image from clipboard |
| + / - | Zoom in/out on map |
| 0 | Fit map to view |
| Esc | Close node detail panel |
