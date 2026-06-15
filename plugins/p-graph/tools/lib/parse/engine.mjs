import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));        // tools/lib/parse
const VENDOR = join(here, '..', '..', 'vendor');            // tools/vendor
const GRAMMARS = join(here, '..', 'grammars');              // tools/lib/grammars

let _ts = null;
async function ts() {
  if (_ts) return _ts;
  const mod = await import(pathToFileURL(join(VENDOR, 'web-tree-sitter.js')).href);
  await mod.Parser.init({ locateFile: () => join(VENDOR, 'tree-sitter.wasm') });
  _ts = mod;
  return _ts;
}

const _langCache = new Map();
export async function loadLanguage(langId) {
  if (_langCache.has(langId)) return _langCache.get(langId);
  const { Language } = await ts();
  const lang = await Language.load(join(GRAMMARS, `${langId}.wasm`));
  _langCache.set(langId, lang);
  return lang;
}

export async function parseAndQuery(lang, scm, source) {
  const { Parser, Query } = await ts();
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const query = new Query(lang, scm);
  const out = [];
  for (const m of query.matches(tree.rootNode)) {
    for (const c of m.captures) {
      out.push({
        name: c.name,
        text: c.node.text,
        startLine: c.node.startPosition.row + 1,
        endLine: c.node.endPosition.row + 1,
        startCol: c.node.startPosition.column,
        endCol: c.node.endPosition.column,
        node: c.node,
      });
    }
  }
  return out;
}
