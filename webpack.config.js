const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  const dotenv = require('dotenv');
  dotenv.config();

  // Dev builds talk to the local rewordly-web server; production builds never do.
  const devApiBase = process.env.DEV_API_BASE_URL || 'http://localhost:3000';
  const apiBase = isProduction ? process.env.API_BASE_URL || '' : devApiBase;

  /** Dev only: allow the local API and mark the extension so it isn't confused with the store build. */
  const transformManifest = (content) => {
    if (isProduction) return content;
    const manifest = JSON.parse(content.toString());
    const origin = new URL(devApiBase).origin;
    manifest.name = `${manifest.name} (Dev)`;
    manifest.host_permissions = [...manifest.host_permissions, `${origin}/*`];
    manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(
      'connect-src',
      `connect-src ${origin}`
    );
    return JSON.stringify(manifest, null, 2);
  };
  
  return {
    entry: {
      background: './src/background.ts',
      content: './src/content.ts',
      live: './src/live/index.ts',
      popup: './src/popup.ts',
      changelog: './src/changelog.ts',
      welcome: './src/welcome.ts'
    },
    output: {
      path: path.resolve(__dirname, process.env.REWORDLY_OUT_DIR || 'dist'),
      filename: '[name].js',
      clean: true
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/
        }
      ]
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    optimization: {
      minimize: isProduction,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            compress: {
              drop_console: isProduction,
              drop_debugger: isProduction
            },
            mangle: {
              // Obfuscate variable and function names
              toplevel: true,
              reserved: ['chrome', 'document', 'window', 'console']
            },
            format: {
              comments: false
            }
          },
          extractComments: false
        })
      ],
      splitChunks: {
        // Prevent code splitting for Chrome extension
        chunks: 'all',
        cacheGroups: {
          default: false,
          vendors: false
        }
      }
    },
    plugins: [
      new webpack.DefinePlugin({
        'process.env.API_BASE_URL': JSON.stringify(apiBase),
        'process.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL || ''),
        'process.env.SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY || ''),
        // Dev/e2e only: send usage counters sooner than once a minute.
        'process.env.USAGE_FLUSH_MS': JSON.stringify(isProduction ? '' : process.env.USAGE_FLUSH_MS || ''),
      }),
      new CopyPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json', transform: transformManifest },
          { from: 'src/popup.html', to: 'popup.html' },
          { from: 'src/welcome.html', to: 'welcome.html' },
          { from: 'src/changelog.html', to: 'changelog.html' },
          { from: 'styles.css', to: 'styles.css' },
          { from: 'icons', to: 'icons', noErrorOnMissing: true },
          { from: 'assets/*.gif', to: '[name][ext]', noErrorOnMissing: true }
        ]
      })
    ],
    devtool: isProduction ? false : 'source-map',
    mode: isProduction ? 'production' : 'development'
  };
};
