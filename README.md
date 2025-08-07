# Rewordly Chrome Extension

A Chrome extension that rewrites selected text using the Rewordly API to improve grammar, clarity, and fluency.

## Features

- **Text Selection**: Select any text on any webpage to rewrite it
- **Floating Button**: A convenient floating button appears when text is selected
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

4. Load the extension in Chrome:
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist` folder

### Production Installation

1. Download the latest release from the releases page
2. Extract the ZIP file
3. Load the extension in Chrome as described above

## Development

### Build Commands

- `npm run build` - Build for production (minified and obfuscated)
- `npm run build:dev` - Build for development (with source maps)
- `npm run dev` - Development mode with watch
- `npm run package` - Create a ZIP file for distribution

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