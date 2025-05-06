/**
 * index.ts
 * This is the entry point for the Remi preprocessor.
 * 
 * Usage: bun run index.ts <filename>
 * Example: bun run index.ts main.remi
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { checkTemplates } from './src/templateChecker';

const outDir = './out';
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Please provide a filename');
  process.exit(1);
}

const filename = args[0];
const inputPath = join('./examples', filename);

try {
  const code = readFileSync(inputPath, 'utf-8');
  
  const processedCode = checkTemplates(code, filename);
  
  console.log(`Successfully processed ${filename}`);
} catch (error: any) {
  console.error(`Error processing ${filename}:`);
  console.error(error.message);
  process.exit(1);
}