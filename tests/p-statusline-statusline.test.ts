import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'plugins', 'p-statusline', 'statusline', 'statusline.cjs');

// Run statusline.cjs with `input` piped to stdin; return stdout.
// COLUMNS is dropped from the inherited environment: the script trims line 3
// to it, and a value set by whatever launched the test run would truncate the
// session name in tests that are not about width. Tests that care pass it in.
function run(input: object, env?: Record<string, string>): string {
  const inherited = { ...process.env };
  delete inherited.COLUMNS;
  return execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...inherited, ...(env ?? {}) },
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

  // Cache hit % comes from stdin. `current_usage` carries the same three token
  // counts the script used to dig out of the transcript file.
  const ctx = (current_usage: object | null) => ({
    used_percentage: 8, context_window_size: 200000, total_input_tokens: 80000, current_usage,
  });
  const usage = (cr: number, cc: number, it: number) =>
    ({ input_tokens: it, output_tokens: 0, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });

  it('renders cache hit % from context_window.current_usage', () => {
    const out = plain(run({
      context_window: ctx(usage(990, 0, 10)),   // 990 / 1000 = 99%
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('c99%');
  });

  it('takes cache % from stdin, not from the transcript file', () => {
    // transcript_path names a file that is not there, while stdin says 75%. An
    // implementation that went back to reading the transcript would show no
    // figure at all here.
    const out = plain(run({
      context_window: ctx(usage(750, 0, 250)),
      transcript_path: join(tmpdir(), 'p-sl-no-such-transcript.jsonl'),
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('c75%');
  });

  it('shows a dim "c-" when current_usage is null, as it is right after /compact', () => {
    const out = plain(run({
      context_window: ctx(null),
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('c-');
    expect(out).not.toMatch(/c\d+%/);
  });

  // Guard the reason the transcript read was dropped: it re-read up to 512 KB
  // and parsed JSONL backwards on every render for data stdin already carries.
  it('does not read any file — no fs, no transcript_path', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).not.toMatch(/require\(\s*["']fs["']\s*\)/);
    expect(src).not.toContain('transcript_path');
  });

  it('marks a linked worktree from workspace.git_worktree', () => {
    const repo = makeGitRepo();
    const out = plain(run({
      workspace: { current_dir: repo, project_dir: repo, git_worktree: 'feature-x' },
    }));
    expect(out).toContain('wt:work');
  }, 15000);

  it('omits the worktree marker in the main working tree', () => {
    const repo = makeGitRepo();
    const out = plain(run({ workspace: { current_dir: repo, project_dir: repo } }));
    expect(out).not.toContain('wt:');
  }, 15000);

  // The marker is the one thing on the bar saying "you are not in the main
  // tree", so it must not be dim: yellow "wt", gray ":", branch back to magenta.
  it('colours the worktree marker yellow "wt" then gray ":"', () => {
    const repo = makeGitRepo();
    const out = run({
      workspace: { current_dir: repo, project_dir: repo, git_worktree: 'feature-x' },
    });
    expect(out).toContain('\x1b[93mwt\x1b[90m:\x1b[95m');
  }, 15000);

  // Countdown columns are 5 wide for the 5-hour window and 6 for the 7-day one
  // — the widest value each can reach ("4h59m" vs "10h10m" in its last day).
  // A 6-wide slot in the 5-hour window would be a column that never fills.
  const limitsBlock = (out: string) => plain(out).split('\n')[0].split(' | ')[1];

  it('keeps the limits block 30 columns wide in every state', () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      { five: now + 4 * 3600 + 59 * 60, seven: now + 6 * 86400 + 21 * 3600 }, // widest of each
      { five: now + 2 * 3600,           seven: now + 10 * 3600 + 41 * 60 },   // 7d last day: "10h41m"
      { five: now + 3 * 60,             seven: now + 45 * 60 },               // minutes only
    ];
    for (const c of cases) {
      const block = limitsBlock(run({
        rate_limits: {
          five_hour: { used_percentage: 100, resets_at: c.five },
          seven_day: { used_percentage: 100, resets_at: c.seven },
        },
        workspace: { current_dir: nonGit, project_dir: nonGit },
      }));
      expect(block, `block: "${block}"`).toHaveLength(30);
    }
  });

  it('pads the "n/a" placeholders to the same 30 columns', () => {
    const block = limitsBlock(run({ workspace: { current_dir: nonGit, project_dir: nonGit } }));
    expect(block).toHaveLength(30);
  });

  it('renders the session name on line 3', () => {
    const out = plain(run({
      session_name: 'auth-refactor',
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out.split('\n')[2]).toBe('auth-refactor');
  });

  // session_name is absent at session start until Claude Code has written a
  // title, and again right after /clear. Printing "-" keeps the bar three rows
  // tall instead of flipping between two and three.
  it('renders "-" on line 3 when session_name is absent', () => {
    const out = plain(run({ workspace: { current_dir: nonGit, project_dir: nonGit } }));
    expect(out.split('\n')[2]).toBe('-');
  });

  it('always prints exactly three lines', () => {
    const out = plain(run({ workspace: { current_dir: nonGit, project_dir: nonGit } }));
    expect(out.split('\n')).toHaveLength(3);
  });

  it('trims a long session name to the terminal width given in COLUMNS', () => {
    const out = plain(run(
      { session_name: 'x'.repeat(80), workspace: { current_dir: nonGit, project_dir: nonGit } },
      { COLUMNS: '20' },
    ));
    const line3 = out.split('\n')[2];
    expect(line3).toHaveLength(20);
    expect(line3.endsWith('…')).toBe(true);
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
