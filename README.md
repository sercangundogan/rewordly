# Rewordly Chrome Extension

A Chrome extension that rewrites selected text instantly with advanced AI to enhance clarity, tone, and readability.

## Features

- **Text Selection**: Select any text on any webpage to rewrite it
- **Rewrite Button**: A convenient rewrite button appears when text is selected
- **Modal Interface**: Clean modal interface to display original and rewritten text
- **Copy to Clipboard**: Easy one-click copying of rewritten text
- **Settings Management**: Enable/disable the extension through the popup interface

## Security & Privacy

### 🔒 **Properly Bundled & Obfuscated**

This extension is now properly bundled using Webpack with the following security features:

- **Code Minification**: All JavaScript code is minified to reduce size and obfuscate logic
- **Variable Name Obfuscation**: Function and variable names are mangled to prevent reverse engineering
- **No Source Maps**: Source maps are disabled in production to prevent source code exposure
- **Console Log Removal**: Debug console logs are removed in production builds
- **Single Bundle**: All code is bundled into optimized single files

### 🔐 **API Security**

- **No API Keys Required**: The extension uses our secure backend API
- **External API**: Uses the Rewordly web API endpoint for text processing
- **No Local Storage**: Sensitive data is not stored locally

## Installation

### Development Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-repo/rewordly.git
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
   
   The build process will:
   - Bundle all TypeScript files into JavaScript
   - Copy `manifest.json` and all static assets to `dist/`
   - Validate that all required files are present
   - Output files use deterministic names (no hashing): `content.js`, `background.js`, etc.

4. Load the extension in Chrome:
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right)
   - Click "Load unpacked"
   - **IMPORTANT**: Select the `dist` folder (not the root folder or any other folder)
   - The extension should now be loaded and active

5. Verify the extension is working:
   - Navigate to `https://www.reddit.com`
   - Open the browser console (F12)
   - You should see: `[REWORDLY][NEW] content.ts loaded`
   - The extension will only be active on sites with enabled adapters (currently Reddit)

### Build Output Structure

The build creates a `dist/` folder with the following structure:

```
dist/
├── manifest.json              # Extension manifest (references all files below)
├── content.js                 # Content script bundle (deterministic name)
├── background.js              # Background service worker (deterministic name)
├── popup.js                    # Popup script
├── popup.html                  # Popup HTML
├── welcome.js                  # Welcome page script
├── welcome.html                # Welcome page HTML
├── changelog.js                # Changelog script
├── changelog.html              # Changelog HTML
├── styles.css                  # Global styles
├── icons/                      # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── *.gif                       # Web accessible resources (if any)
```

**Key Points:**
- All file names are deterministic (no hashing) for consistent loading
- `manifest.json` references use relative paths that match the actual files
- The build validation script ensures all required files are present
- Always load the extension from the `dist/` folder in Chrome

### Production Installation

1. Download the latest release from the releases page
2. Extract the ZIP file
3. Load the extension in Chrome as described above

## Development

### Build Commands

- `npm run build` - Build for production (minified and obfuscated) with validation
- `npm run build:dev` - Build for development (with source maps) with validation
- `npm run dev` - Development mode with watch
- `npm run validate` - Validate that dist/ contains all required files
- `npm run package` - Create a ZIP file for distribution

### Build Output

The build process creates a `dist/` folder containing:
- `manifest.json` - Extension manifest
- `content.js` - Content script bundle (no hashing)
- `background.js` - Background service worker bundle (no hashing)
- `popup.js`, `popup.html` - Popup interface
- `welcome.js`, `welcome.html` - Welcome page
- `changelog.js`, `changelog.html` - Changelog page
- `styles.css` - Global styles
- `icons/` - Extension icons
- Any web_accessible_resources (GIFs, etc.)

**Always load the extension from the `dist/` folder in Chrome.** The build validation script ensures all required files are present.

### Project Structure

```
rewordly/
├── src/
│   ├── background.ts      # Background service worker
│   ├── content.ts         # Content script for webpage interaction
│   ├── popup.ts          # Popup interface logic
│   ├── popup.html        # Popup interface HTML
│   └── utils/
│       └── api.ts        # API utility functions
├── dist/                 # Built extension files
├── icons/               # Extension icons
├── styles.css           # Global styles
├── manifest.json        # Extension manifest
├── webpack.config.js    # Webpack configuration
└── package.json         # Dependencies and scripts
```

## API Integration

The extension integrates with the Rewordly API for text rewriting:

- **Endpoint**: `https://rewordly-web.vercel.app/api/rewrite`
- **Method**: POST
- **Content-Type**: application/json
- **Request Body**: `{ "text": "text to rewrite" }`
- **Response**: `{ "rewritten": "rewritten text" }`

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Build the extension: `npm run build`
5. Test your changes
6. Commit your changes: `git commit -am 'Add feature'`
7. Push to the branch: `git push origin feature-name`
8. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Security Notice

This extension is now properly bundled and obfuscated to protect your source code. The build process:

- ✅ Minifies all JavaScript code
- ✅ Obfuscates variable and function names
- ✅ Removes source maps in production
- ✅ Removes console logs in production
- ✅ Bundles all code into optimized files

This prevents users from easily reverse-engineering your extension's logic and protects your intellectual property. 