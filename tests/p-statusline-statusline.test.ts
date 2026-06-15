import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'plugins', 'p-statusline', 'statusline', 'statusline.cjs');

// Run statusline.cjs with `input` piped to stdin; return stdout.
function run(input: object): string {
  return execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  });
}

// Strip ANSI colour escapes so assertions read against plain text.
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const tempDirs: string[] = [];

// A throwaway directory that is NOT a git repository.
function makeNonGitDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'p-sl-plain-'));
  tempDirs.push(d);
  return d;
}

// A throwaway git repository with one commit on branch `work`.
function makeGitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'p-sl-git-'));
  tempDirs.push(d);
  const g = (args: string[]) => execFileSync('git', args, { cwd: d, stdio: 'ignore' });
  g(['init', '-b', 'work']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(d, 'file.txt'), 'hello');
  g(['add', '.']);
  g(['commit', '-m', 'initial']);
  return d;
}

let nonGit: string;
beforeAll(() => { nonGit = makeNonGitDir(); });
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

describe('p-statusline statusline.cjs', () => {
  it('renders context %, token count, and cache % from context_window', () => {
    const out = plain(run({
      context_window: { used_percentage: 8, context_window_size: 200000, total_input_tokens: 80000 },
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('8%');
    expect(out).toContain('80k');
  });

  it('falls back to "n/a" when rate_limits is absent', () => {
    const out = plain(run({ workspace: { current_dir: nonGit, project_dir: nonGit } }));
    expect(out).toContain('5h n/a');
    expect(out).toContain('7d n/a');
  });

  it('renders rate-limit percentages when rate_limits is present', () => {
    const now = Math.floor(Date.now() / 1000);
    const out = plain(run({
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: now + 3600 },
        seven_day: { used_percentage: 5, resets_at: now + 6 * 86400 },
      },
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    // Percentages are right-aligned to 3 chars inside the fixed-width
    // limits sub-segment, so there may be leading spaces between the label
    // and the number (e.g. "5h  20%", "7d   5%").
    expect(out).toMatch(/5h\s+20%/);
    expect(out).toMatch(/7d\s+5%/);
  });

  it('renders an explicit "no git" segment when cwd is not a git repository', () => {
    const out = plain(run({ workspace: { current_dir: nonGit, project_dir: nonGit } }));
    expect(out).toContain('⎇ no git');
  });

  it('renders model, effort, and a RAM percentage', () => {
    const out = plain(run({
      model: { display_name: 'Opus 4.7' },
      effort: { level: 'high' },
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('Opus 4.7');
    expect(out).toContain('high');
    expect(out).toMatch(/RAM \d{1,3}%/);
  });

  it('shows the branch name when cwd is a git repository', () => {
    const repo = makeGitRepo();
    const out = plain(run({ workspace: { current_dir: repo, project_dir: repo } }));
    expect(out).toContain('work');
  });

  it('shows the short commit hash on a detached HEAD', () => {
    const repo = makeGitRepo();
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    execFileSync('git', ['checkout', '--detach'], { cwd: repo, stdio: 'ignore' });
    const out = plain(run({ workspace: { current_dir: repo, project_dir: repo } }));
    expect(out).toContain(hash);
    // Extended timeout: this test spawns a git repo and the script then runs
    // several git subprocesses — slow enough on Windows to exceed the 5s default.
  }, 15000);

  it('does not mark dirty when only untracked files are present', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'untracked.txt'), 'new');
    const out = plain(run({ workspace: { current_dir: repo, project_dir: repo } }));
    expect(out).toContain('work');
    expect(out).not.toMatch(/work\*/);
  }, 15000);

  it('marks dirty when a tracked file is modified', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'file.txt'), 'changed');
    const out = plain(run({ workspace: { current_dir: repo, project_dir: repo } }));
    expect(out).toMatch(/work\*/);
  }, 15000);

  it('produces output without throwing on an empty input object', () => {
    const out = run({});
    expect(typeof out).toBe('string');
  });

  // Write a JSONL transcript in a throwaway dir and return its path.
  function writeTranscript(lines: string[]): string {
    const d = mkdtempSync(join(tmpdir(), 'p-sl-tx-'));
    tempDirs.push(d);
    const p = join(d, 'transcript.jsonl');
    writeFileSync(p, lines.join('\n') + '\n');
    return p;
  }

  const assistantUsage = (cr: number, cc: number, it: number) =>
    JSON.stringify({ type: 'assistant', message: { usage: { cache_read_input_tokens: cr, cache_creation_input_tokens: cc, input_tokens: it } } });

  it('renders cache hit % from the last assistant usage in the transcript', () => {
    const tp = writeTranscript([
      assistantUsage(100, 100, 800),   // older turn — should be ignored
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistantUsage(990, 0, 10),      // latest turn → 990/1000 = 99%
    ]);
    const out = plain(run({
      context_window: { used_percentage: 8, context_window_size: 200000, total_input_tokens: 80000 },
      transcript_path: tp,
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('c99%');
  });

  it('reads the latest usage even when the transcript is larger than the tail window', () => {
    // >512 KB of leading filler so the read is truncated; the final usage line
    // must still be found (proves the tail-read scans the end, not the start).
    const filler = Array.from({ length: 9000 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(80), n: i } }));
    const tp = writeTranscript([...filler, assistantUsage(750, 0, 250)]); // 75%
    const out = plain(run({
      context_window: { used_percentage: 8, context_window_size: 200000, total_input_tokens: 80000 },
      transcript_path: tp,
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('c75%');
  });

  it('omits the cache segment when the transcript has no assistant usage', () => {
    const tp = writeTranscript([JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
    const out = plain(run({
      context_window: { used_percentage: 8, context_window_size: 200000, total_input_tokens: 80000 },
      transcript_path: tp,
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).not.toMatch(/c\d+%/);
  });

  // The status line re-renders ~every 300ms; a hung git must not freeze it.
  // Guard the invariant statically: every git execSync carries a timeout.
  it('gives every git execSync call a timeout', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    const gitCalls = src.match(/execSync\(\s*["'`]git[^]*?\)/g) ?? [];
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const call of gitCalls) {
      expect(call, `git execSync without timeout: ${call.slice(0, 60)}…`).toMatch(/timeout\s*:/);
    }
  });
});
