import { describe, expect, it } from 'vitest';
import { findAgents, findPlugins } from './helpers.js';

const DESCRIPTION_MIN_CHARS = 30;
const BODY_MIN_CHARS = 100;

describe('agents', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const agents = findAgents(plugin.dir);

    // Agents are optional per-plugin. Skip plugins that don't ship any
    // to avoid an empty describe block.
    if (agents.length === 0) continue;

    describe(`plugin: ${plugin.name}`, () => {
      for (const agent of agents) {
        describe(`agent: ${agent.name}`, () => {
          it('agent .md raw content is non-empty', () => {
            expect(agent.raw.length).toBeGreaterThan(0);
          });

          it('frontmatter has a string "name"', () => {
            expect(typeof agent.frontmatter.name).toBe('string');
            expect((agent.frontmatter.name as string).length).toBeGreaterThan(0);
          });

          it('frontmatter.name matches the agent filename (sans .md)', () => {
            expect(agent.frontmatter.name).toBe(agent.name);
          });

          it('frontmatter has a non-empty string "description"', () => {
            expect(typeof agent.frontmatter.description).toBe('string');
            expect((agent.frontmatter.description as string).length).toBeGreaterThan(DESCRIPTION_MIN_CHARS);
          });

          it('frontmatter "tools" is a non-empty comma-separated string', () => {
            const v = agent.frontmatter.tools;
            expect(typeof v).toBe('string');
            const tools = (v as string).split(',').map((t) => t.trim()).filter(Boolean);
            expect(tools.length).toBeGreaterThan(0);
          });

          it('frontmatter "tools" must NOT include Write or Edit (read-only)', () => {
            const v = agent.frontmatter.tools as string;
            const tools = v.split(',').map((t) => t.trim());
            expect(tools).not.toContain('Write');
            expect(tools).not.toContain('Edit');
          });

          it('body declares a "What is NOT your scope" section', () => {
            expect(agent.body).toContain('## What is NOT your scope');
          });

          it('frontmatter "model" is a non-empty string when present', () => {
            const v = agent.frontmatter.model;
            if (v !== undefined) {
              expect(typeof v).toBe('string');
              expect((v as string).length).toBeGreaterThan(0);
            }
          });

          it('markdown body is non-trivial (>100 chars)', () => {
            expect(agent.body.trim().length).toBeGreaterThan(BODY_MIN_CHARS);
          });
        });
      }
    });
  }
});
