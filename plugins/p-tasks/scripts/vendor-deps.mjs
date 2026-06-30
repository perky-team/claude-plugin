// Vendors p-tasks' sole runtime dependency (js-yaml) into the shipped artifact.
//
// WHY: plugins are distributed by copying files into a cache with NO install
// step, so the plugin must be self-sufficient at rest. A bare `import 'js-yaml'`
// only resolves while a node_modules tree happens to sit above the tools at dev
// time; once the plugin is copied into the cache alone it fails with
// ERR_MODULE_NOT_FOUND. We copy js-yaml's self-contained ESM build into
// tools/lib/vendor/ and import it by relative path instead. (Same pattern as
// p-graph's tools/vendor/.)
//
// js-yaml's dist/js-yaml.mjs is a single self-contained file — argparse is only
// used by js-yaml's CLI bin, not by the library export, so nothing else needs
// vendoring. Re-run this after bumping js-yaml in the root package.json:
//   node plugins/p-tasks/scripts/vendor-deps.mjs

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'tools', 'lib', 'vendor');
mkdirSync(vendor, { recursive: true });

// Resolve the package root via its package.json, then take its declared ESM
// build (the "module"/exports import entry → dist/js-yaml.mjs).
const pkgDir = dirname(require.resolve('js-yaml/package.json'));
copyFileSync(join(pkgDir, 'dist', 'js-yaml.mjs'), join(vendor, 'js-yaml.mjs'));
console.log('vendored js-yaml -> tools/lib/vendor/js-yaml.mjs');
