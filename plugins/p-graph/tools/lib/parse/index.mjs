import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scm = (f) => readFileSync(join(here, 'lang', f), 'utf-8');

const BY_EXT = {
  '.ts': { lang: 'ts', langId: 'typescript', scm: 'ts.scm' },
  '.mts': { lang: 'ts', langId: 'typescript', scm: 'ts.scm' },
  '.cts': { lang: 'ts', langId: 'typescript', scm: 'ts.scm' },
  '.tsx': { lang: 'ts', langId: 'tsx', scm: 'ts.scm' },
  '.js': { lang: 'js', langId: 'javascript', scm: 'js.scm' },
  '.jsx': { lang: 'js', langId: 'javascript', scm: 'js.scm' },
  '.mjs': { lang: 'js', langId: 'javascript', scm: 'js.scm' },
  '.cjs': { lang: 'js', langId: 'javascript', scm: 'js.scm' },
  '.go': { lang: 'go', langId: 'go', scm: 'go.scm' },
  '.cpp': { lang: 'cpp', langId: 'cpp', scm: 'cpp.scm' },
  '.cc': { lang: 'cpp', langId: 'cpp', scm: 'cpp.scm' },
  '.cxx': { lang: 'cpp', langId: 'cpp', scm: 'cpp.scm' },
  '.h': { lang: 'cpp', langId: 'cpp', scm: 'cpp.scm' },
  '.hpp': { lang: 'cpp', langId: 'cpp', scm: 'cpp.scm' },
  '.py': { lang: 'py', langId: 'python', scm: 'py.scm' },
};

export const SUPPORTED_EXTS = Object.keys(BY_EXT);

export function resolveLang(filePath) {
  const cfg = BY_EXT[extname(filePath).toLowerCase()];
  if (!cfg) return null;
  return { ...cfg, query: scm(cfg.scm) };
}
