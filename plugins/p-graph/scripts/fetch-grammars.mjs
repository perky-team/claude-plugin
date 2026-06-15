import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'tools', 'vendor');
const grammars = join(here, '..', 'tools', 'lib', 'grammars');
mkdirSync(vendor, { recursive: true });
mkdirSync(grammars, { recursive: true });

// web-tree-sitter runtime
// In 0.25.x the package exports:
//   "." -> import: "./tree-sitter.js", require: "./tree-sitter.cjs"
//   "./tree-sitter.wasm" -> "./tree-sitter.wasm"
// require.resolve('web-tree-sitter') resolves to tree-sitter.cjs; use its dirname.
const wtsDir = dirname(require.resolve('web-tree-sitter'));
copyFileSync(join(wtsDir, 'tree-sitter.wasm'), join(vendor, 'tree-sitter.wasm'));
// Copy the ESM loader (tree-sitter.js) as web-tree-sitter.js for downstream consumers.
copyFileSync(join(wtsDir, 'tree-sitter.js'), join(vendor, 'web-tree-sitter.js'));

// grammars from tree-sitter-wasms/out
const tswDir = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
for (const g of ['cpp', 'go', 'python', 'typescript', 'tsx', 'javascript']) {
  copyFileSync(join(tswDir, `tree-sitter-${g}.wasm`), join(grammars, `${g}.wasm`));
}
console.log('vendored runtime + grammars');
