import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const here = dirname(fileURLToPath(import.meta.url));

export const repoRoot = (): string => resolve(here, '..');

export interface MarketplaceEntry {
  name: string;
  source: string;
  description: string;
}

export interface Marketplace {
  name: string;
  description?: string;
  owner?: { name?: string; email?: string };
  plugins: MarketplaceEntry[];
}

export const readMarketplace = (): { path: string; data: Marketplace } => {
  const path = join(repoRoot(), '.claude-plugin', 'marketplace.json');
  const data = JSON.parse(readFileSync(path, 'utf-8')) as Marketplace;
  return { path, data };
};

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: { name?: string; email?: string };
}

export interface Plugin {
  dir: string;
  name: string;
  manifestPath: string;
  manifest: PluginManifest;
  readmePath: string;
}

const listDirs = (parent: string): string[] =>
  existsSync(parent)
    ? readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];

export const findPlugins = (): Plugin[] => {
  const pluginsDir = join(repoRoot(), 'plugins');
  return listDirs(pluginsDir)
    .map((name): Plugin | null => {
      const dir = join(pluginsDir, name);
      const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
      if (!existsSync(manifestPath)) return null;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      return {
        dir,
        name,
        manifestPath,
        manifest,
        readmePath: join(dir, 'README.md'),
      };
    })
    .filter((p): p is Plugin => p !== null);
};

export interface Skill {
  dir: string;
  name: string;
  skillMdPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

export const findSkills = (pluginDir: string): Skill[] => {
  const skillsDir = join(pluginDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return listDirs(skillsDir)
    .filter((name) => !name.startsWith('_'))
    .map((name): Skill | null => {
      const dir = join(skillsDir, name);
      const skillMdPath = join(dir, 'SKILL.md');
      if (!existsSync(skillMdPath)) return null;
      const raw = readFileSync(skillMdPath, 'utf-8');
      const parsed = matter(raw);
      return {
        dir,
        name,
        skillMdPath,
        frontmatter: parsed.data,
        body: parsed.content,
        raw,
      };
    })
    .filter((s): s is Skill => s !== null);
};

export interface Template {
  path: string;
  filename: string;
  content: string;
}

export const findTemplates = (pluginDir: string): Template[] => {
  const templatesDir = join(pluginDir, 'skills', '_shared', 'templates');
  if (!existsSync(templatesDir)) return [];
  return readdirSync(templatesDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const p = join(templatesDir, e.name);
      return {
        path: p,
        filename: e.name,
        content: readFileSync(p, 'utf-8'),
      };
    });
};
