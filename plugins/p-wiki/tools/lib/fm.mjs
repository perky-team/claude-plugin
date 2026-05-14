import { parseYaml, stringifyYaml } from './yaml.mjs';

const FENCE = '---';

export function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== FENCE) {
    throw new Error('frontmatter: missing opening --- fence');
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) { end = i; break; }
  }
  if (end === -1) throw new Error('frontmatter: missing closing --- fence');
  const fmText = lines.slice(1, end).join('\n') + '\n';
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter: parseYaml(fmText), body };
}

export function serializeFrontmatter(frontmatter, body) {
  return `${FENCE}\n${stringifyYaml(frontmatter)}${FENCE}\n${body}`;
}
