# Rewordly Chrome Extension

A Chrome extension that rewrites or grammar-checks selected text using AI to improve clarity, tone, and readability.

## Features

- **Text selection** — Select any text (3+ characters) on a webpage, in inputs, textareas, or contenteditable areas.
- **Floating button** — A floating button appears next to the selection with two actions:
  - **Rewrite** — Rewrite the selected text with AI.
  - **Check Grammar** — Fix grammar and spelling in the selected text.
- **Modal** — Modal shows original and result (rewritten or corrected) text.
- **Copy to clipboard** — One-click copy of the result.
- **Popup settings** — Enable or disable the rewrite/grammar button from the extension popup.
- **Context menu** — Right-click on selected text for:
  - Rewordly → Rewrite Text
  - Rewordly → Check Grammar
  - Disable / Enable Rewordly on this page (per-site toggle).
- **Welcome & changelog** — Welcome page on first install, changelog on update.
- **Account & login** (v1.3.0) — Sign in via the website for more daily usage; session is shown in the popup. Free limits can be requested by email; payment plans coming soon.
- **Keyboard shortcuts** (v1.4.0) — `Ctrl+Shift+E` (rewrite) and `Ctrl+Shift+L` (grammar); popup shows bindings and opens Chrome shortcut settings. Optional uninstall feedback link.
- **v1.5.0** — **Rewrite tone** (popup default + modal switches); **Shorter / Longer** in the modal; **Apply** into editable fields; **upgraded backend AI model**; **refreshed UI**; popup **usage counter** when signed in; **automatic session refresh** after login; **Esc** closes the modal.

## Security & Privacy

### Bundling & obfuscation

The extension is built with Webpack:

- **Minification** — JavaScript is minified.
- **Name mangling** — Variable and function names are mangled in production.
- **No source maps** — Disabled in production builds.
- **Console removal** — `console` calls are stripped in production.
- **Single bundles** — Code is bundled into one file per entry.

### API

- **No API keys in the extension** — Uses the Rewordly backend at `rewordly.store`.
- **External API** — All rewrite/grammar requests go to `https://rewordly.store/api/*`.
- **Local data** — Only extension settings and “welcome/changelog seen” state are stored in Chrome storage; no sensitive data.

## Installation

### Development

1. Clone the repository:
   ```bash
   git clone https://github.com/sercangundogan/rewordly.git
   cd rewordly
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run build
   ```

4. Load in Chrome:
   - Open `chrome://extensions/`
   - Turn on **Developer mode**
   - Click **Load unpacked**
   - Select the `dist` folder

### Production

1. Download the latest release (ZIP) from the releases page.
2. Unzip and load the unpacked extension in Chrome as above (select the unzipped folder that contains the extension files).

## Development

### Scripts

| Command | Description |
|--------|-------------|
| `npm run build` | Production build (minified, no source maps) |
| `npm run build:dev` | Development build (with source maps) |
| `npm run dev` | Development build with watch |
| `npm run package` | Clean, build, and create a ZIP for distribution |
| `npm run lint` | Run ESLint on `src/**/*.ts` |
| `npm run type-check` | Run TypeScript type check (`tsc --noEmit`) |

### Project structure

```
rewordly/
├── src/
│   ├── background.ts    # Service worker: context menu, install/update, messages
│   ├── content.ts       # Content script: selection, floating button, modal, API calls
│   ├── popup.ts         # Popup logic and settings
│   ├── popup.html       # Popup UI
│   ├── changelog.ts     # Changelog page logic
│   ├── changelog.html   # Changelog page
│   ├── welcome.ts       # Welcome page logic
│   ├── welcome.html     # Welcome page (first install)
│   └── utils/
│       └── api.ts       # API helpers (rewrite, grammar)
├── icons/               # Extension icons (16, 48, 128)
├── styles.css           # Shared styles (injected by content script)
├── manifest.json        # Extension manifest (source; copied to dist by build)
├── webpack.config.js    # Webpack config
├── tsconfig.json        # TypeScript config
├── package.json
└── dist/                # Build output (load this in Chrome)
```

## API

The extension calls the Rewordly API at `https://rewordly.store/api/`.

### Rewrite

- **URL:** `POST https://rewordly.store/api/rewrite`
- **Body:** `{ "text": "text to rewrite" }`
- **Response:** `{ "rewritten": "rewritten text" }`

### Grammar

- **URL:** `POST https://rewordly.store/api/grammar`
- **Body:** `{ "text": "text to check", "mode": "ai" }`
- **Response:** `{ "corrected": "corrected text" }`

## Contributing

1. Fork the repository.
2. Create a branch: `git checkout -b feature/your-feature`.
3. Make changes, then run `npm run build` and test.
4. Commit and push, then open a pull request.

## License

MIT — see the [LICENSE](LICENSE) file.
