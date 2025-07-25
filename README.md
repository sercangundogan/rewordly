# Rewordly Chrome Extension

A powerful Chrome extension that uses OpenAI's GPT API to rewrite selected text, improving grammar, clarity, and fluency while preserving the original meaning.

## Features

- **Smart Text Selection**: Detects when you select text on any webpage
- **Floating Rewrite Button**: Appears near your selection for easy access
- **AI-Powered Rewriting**: Uses OpenAI's GPT models to improve your text
- **Modal Interface**: Clean, modern interface to compare original and rewritten text
- **Copy & Replace**: Easily copy rewritten text or replace the original
- **Settings Management**: Configure API key and model preferences
- **Toggle On/Off**: Enable or disable the extension as needed

## Installation

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-repo/rewordly.git
   cd rewordly
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the extension**
   ```bash
   npm run build
   ```

4. **Load in Chrome**
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `dist` folder from the project

### Production Installation

1. **Download the extension**
   - Download the latest release from GitHub
   - Extract the ZIP file

2. **Install in Chrome**
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the extracted folder

## Configuration

### Setting up OpenAI API Key

1. **Get an API Key**
   - Visit [OpenAI Platform](https://platform.openai.com/api-keys)
   - Create a new API key
   - Copy the key (starts with `sk-`)

2. **Configure the Extension**
   - Click the Rewordly extension icon in Chrome
   - Enter your API key in the settings
   - Click "Test API Key" to verify
   - Save your settings

### Available Models

- **GPT-3.5 Turbo**: Fast and cost-effective (recommended)
- **GPT-4**: Better quality, higher cost
- **GPT-4 Turbo**: Latest model with improved performance

## Usage

### Basic Usage

1. **Select Text**: Highlight any text on a webpage
2. **Click Rewrite**: Click the floating "Rewrite" button that appears
3. **Review Results**: Compare original and rewritten text in the modal
4. **Take Action**: Copy the rewritten text or replace the original

### Advanced Features

- **Keyboard Shortcuts**: Press `Escape` to close the modal
- **Toggle Extension**: Use the settings to enable/disable the extension
- **Model Selection**: Choose different GPT models based on your needs

## Development

### Project Structure

```
rewordly/
├── src/
│   ├── content.ts          # Content script for text selection
│   ├── background.ts       # Background service worker
│   ├── popup.ts           # Popup settings management
│   ├── popup.html         # Popup HTML interface
│   └── utils/
│       └── openai.ts      # OpenAI API utilities
├── styles.css             # Extension styles
├── manifest.json          # Chrome extension manifest
├── package.json           # Project dependencies
├── tsconfig.json          # TypeScript configuration
└── README.md             # This file
```

### Build Commands

```bash
# Development (watch mode)
npm run dev

# Production build
npm run build

# Clean and rebuild
npm run clean && npm run build

# Package for distribution
npm run package

# Type checking
npm run type-check

# Linting
npm run lint
```

### Development Workflow

1. **Make Changes**: Edit TypeScript files in `src/`
2. **Build**: Run `npm run build` to compile
3. **Reload**: Refresh the extension in `chrome://extensions/`
4. **Test**: Test your changes on any webpage

## API Usage

The extension makes requests to OpenAI's API for each text rewrite. Here's what you can expect:

- **Cost**: ~$0.002 per 1K tokens (GPT-3.5 Turbo)
- **Rate Limits**: Follow OpenAI's rate limits
- **Privacy**: Your API key is stored locally in Chrome's sync storage

### Estimating Costs

- Short text (1-2 sentences): ~$0.001-0.002
- Medium text (paragraph): ~$0.005-0.01
- Long text (multiple paragraphs): ~$0.02-0.05

## Troubleshooting

### Common Issues

**Extension not working**
- Check if the extension is enabled in settings
- Verify your API key is valid
- Ensure you have an active internet connection

**API Key errors**
- Make sure your API key starts with `sk-`
- Check your OpenAI account has sufficient credits
- Verify the API key has the correct permissions

**Text not being rewritten**
- Ensure you've selected at least 3 characters
- Check the browser console for error messages
- Try refreshing the page and selecting text again

### Debug Mode

Enable debug logging by setting `DEBUG=true` in your environment variables.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow TypeScript best practices
- Add proper error handling
- Include unit tests for new features
- Update documentation for API changes
- Test on multiple websites

## Security

- **API Key Storage**: Keys are stored in Chrome's secure sync storage
- **Network Requests**: All requests use HTTPS
- **Data Privacy**: No text is stored permanently
- **Permissions**: Minimal required permissions

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/your-repo/rewordly/issues)
- **Discussions**: [GitHub Discussions](https://github.com/your-repo/rewordly/discussions)
- **Email**: support@rewordly.com

## Changelog

### v1.0.0
- Initial release
- Text selection and rewriting
- OpenAI GPT integration
- Settings management
- Modern UI with modal interface

## Acknowledgments

- OpenAI for providing the GPT API
- Chrome Extension API for the platform
- TypeScript team for the excellent language
- The open-source community for inspiration

---

**Note**: This extension requires an OpenAI API key and may incur costs based on usage. Please review OpenAI's pricing before use. 