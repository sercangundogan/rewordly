#!/usr/bin/env node

/**
 * Build script for Rewordly Chrome Extension
 * Uses Webpack for proper bundling, minification, and obfuscation
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

const DIST_DIR = 'dist';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function build() {
  log('🚀 Starting Rewordly build process with Webpack...', 'blue');
  
  try {
    // Run webpack build
    log('📝 Building with Webpack...', 'blue');
    execSync('npm run build', { stdio: 'inherit' });
    log('✓ Webpack build completed', 'green');
    
    log('🎉 Build completed successfully!', 'green');
    log(`📁 Output directory: ${DIST_DIR}`, 'blue');
    log('💡 Load the extension from the dist folder in Chrome', 'yellow');
    log('🔒 Code is now properly bundled, minified, and obfuscated', 'green');
    
  } catch (error) {
    log(`❌ Build failed: ${error.message}`, 'red');
    process.exit(1);
  }
}

// Run build if this script is executed directly
if (require.main === module) {
  build();
}

module.exports = { build }; 