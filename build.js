#!/usr/bin/env node

/**
 * Build script for Rewordly Chrome Extension
 * Compiles TypeScript and copies necessary files
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

const SRC_DIR = 'src';
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

function copyFile(src, dest) {
  try {
    fs.copyFileSync(src, dest);
    log(`✓ Copied ${src} to ${dest}`, 'green');
  } catch (error) {
    log(`✗ Failed to copy ${src}: ${error.message}`, 'red');
  }
}

function createDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log(`✓ Created directory: ${dir}`, 'green');
  }
}

function cleanDirectory(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`✓ Cleaned directory: ${dir}`, 'yellow');
  }
  createDirectory(dir);
}

function injectEnvironmentVariables(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Direct API key injection (you can replace this with your actual API key)
    const apiKey = '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';
    
    // Replace process.env references with literal values
    content = content.replace(/process\.env\['OPENAI_API_KEY'\]/g, `'${apiKey}'`);
    content = content.replace(/process\.env\['DEFAULT_MODEL'\]/g, "'gpt-3.5-turbo'");
    content = content.replace(/process\.env\['ENABLED_BY_DEFAULT'\]/g, "'true'");
    
    fs.writeFileSync(filePath, content);
    log(`✓ Injected environment variables into ${filePath}`, 'green');
  } catch (error) {
    log(`✗ Failed to inject environment variables into ${filePath}: ${error.message}`, 'red');
  }
}

function build() {
  log('🚀 Starting Rewordly build process...', 'blue');
  
  // Check if .env file exists
  if (fs.existsSync('.env')) {
    log('📄 Found .env file, will inject environment variables', 'blue');
  } else {
    log('⚠️  No .env file found, using default values', 'yellow');
  }
  
  // Clean and create dist directory
  cleanDirectory(DIST_DIR);
  
  try {
    // Compile TypeScript
    log('📝 Compiling TypeScript...', 'blue');
    execSync('npx tsc', { stdio: 'inherit' });
    log('✓ TypeScript compilation completed', 'green');
    
    // Inject environment variables into compiled files
    if (fs.existsSync('.env')) {
      log('🔧 Injecting environment variables...', 'blue');
      const jsFiles = ['background.js', 'content.js', 'popup.js'];
      jsFiles.forEach(file => {
        const filePath = path.join(DIST_DIR, file);
        if (fs.existsSync(filePath)) {
          injectEnvironmentVariables(filePath);
        }
      });
    }
    
    // Copy necessary files
    log('📋 Copying files...', 'blue');
    
    // Copy HTML files from src
    const htmlFiles = fs.readdirSync(SRC_DIR).filter(file => file.endsWith('.html'));
    htmlFiles.forEach(file => {
      copyFile(path.join(SRC_DIR, file), path.join(DIST_DIR, file));
    });
    
    // Copy CSS file
    if (fs.existsSync('styles.css')) {
      copyFile('styles.css', path.join(DIST_DIR, 'styles.css'));
    }
    
    // Copy manifest
    if (fs.existsSync('manifest.json')) {
      copyFile('manifest.json', path.join(DIST_DIR, 'manifest.json'));
    }
    
    // Copy icons directory if it exists
    if (fs.existsSync('icons')) {
      createDirectory(path.join(DIST_DIR, 'icons'));
      const iconFiles = fs.readdirSync('icons');
      iconFiles.forEach(file => {
        copyFile(path.join('icons', file), path.join(DIST_DIR, 'icons', file));
      });
    }
    
    log('🎉 Build completed successfully!', 'green');
    log(`📁 Output directory: ${DIST_DIR}`, 'blue');
    log('💡 Load the extension from the dist folder in Chrome', 'yellow');
    
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