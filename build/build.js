#!/usr/bin/env node

/**
 * Build script using esbuild
 * Bundles the module with tree-shaking to remove unused code.
 * 
 * This script filters the ArcGIS assets required for self hosting.
 * The total assets for ArcGIS is well over 17,000 files with a total size of over 54MB but
 * only a subset of them are required for the ArcGIS API to work. 
 * This script copies only the required assets to the dist folder, 
 * which reduces the size of the dist folder significantly.
 * 
 * We will put the raw filtered assets in the samples folder for testing, 
 * and then put a zip version of that in the dist folder.
 */

import fs from 'fs';
import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');
const umdDir = path.join(distDir, 'umd');
const esmDir = path.join(distDir, 'esm');

const fileName = 'offline-data-manager';
const globalUmdName = 'offlineMapData';

const baseConfig = {
  entryPoints: [path.join(srcDir, 'index.js')],
  bundle: true,
  treeShaking: true,
  external: [],
  platform: 'browser',
  target: ['es2020'],
  loader: {
    '.css': 'text'
  }
};

// Production build config (minimized)
const prodConfig = {
  ...baseConfig,
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"'
  }
};

// Development build config (non-minimized)
/*const devConfig = {
  ...baseConfig,
  minify: false,
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': '"development"'
  }
};*/

const contexts = [
  { config: prodConfig, outfile: path.join(esmDir, `${fileName}.js`), format: 'esm', name: 'ESM (production)' },
  { config: prodConfig, outfile: path.join(umdDir, `${fileName}.js`), format: 'iife', name: 'UMD (production)' }
];

async function build() {
  try {    
    // Ensure dist directories exist
    await Promise.all([
      fs.promises.mkdir(umdDir, { recursive: true }),
      fs.promises.mkdir(esmDir, { recursive: true }),
    ]);

    console.log(`🔨 Building ${fileName} module...\n`);

    for (const { config, outfile, format, name } of contexts) {
      await esbuild.build({
        ...config,
        outfile: outfile,
        format: format,
        ...(format === 'iife' && { globalName: globalUmdName })
      });

      console.log(`✅ Built: ${outfile} ${name}`);
    }

    console.log('\n✨ Build complete! All formats generated.');
    
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();
