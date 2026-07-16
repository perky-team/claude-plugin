// Vendors js-yaml's self-contained ESM build into tools/lib/vendor/.
// Plugins are distributed by copying files with NO install step, so a bare
// `import 'js-yaml'` would fail once the plugin is copied alone. Re-run after
// bumping js-yaml in the root package.json:
//   node plugins/p-shed/scripts/vendor-deps.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'tools', 'lib', 'vendor');
mkdirSync(vendor, { recursive: true });
const pkgDir = dirname(require.resolve('js-yaml/package.json'));
copyFileSync(join(pkgDir, 'dist', 'js-yaml.mjs'), join(vendor, 'js-yaml.mjs'));
console.log('vendored js-yaml -> tools/lib/vendor/js-yaml.mjs');
