const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  const dotenv = require('dotenv');
  dotenv.config();
  
  return {
    entry: {
      background: './src/background.ts',
      content: './src/content.ts',
      popup: './src/popup.ts',
      changelog: './src/changelog.ts',
      welcome: './src/welcome.ts'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
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
        'process.env.API_BASE_URL': JSON.stringify(process.env.API_BASE_URL || ''),
        'process.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL || ''),
        'process.env.SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY || ''),
      }),
      new CopyPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
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
