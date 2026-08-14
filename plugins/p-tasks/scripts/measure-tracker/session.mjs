import { spawnSync } from 'node:child_process';

// The same sentence in every session and every arm. It must not hint at what
// has already been done — remembering that is the tracker's job, and telling
// the agent would hand the `none` arm the very thing it is missing.
export const PROMPT = 'Continue the work on the feature described in SPEC.md.';

// A session that spends its whole cap was stopped by the cap, not by finishing.
// The CLI does not say so in its envelope, so read it from the money: anything
// within 2% of the cap was cut off.
const CAP_MARGIN = 0.98;

/**
 * Run one session in `dir`.
 *
 * The contract has two halves, and the difference between them matters:
 *
 * - **Nothing the CLI does throws.** Any failure out there — an API error, a
 *   non-zero exit, output that is not JSON — comes back as a row with `error`
 *   set. Losing 40 good sessions to one hiccup is not acceptable.
 * - **A caller mistake throws at once.** A missing binary or a `ptasks` arm
 *   with no plugin directory would still produce perfectly ordinary-looking
 *   rows — the plugin simply would not be there, and the arm would quietly
 *   become a second `none`. A study that silently measures the wrong thing is
 *   worse than one that stops on the first session.
 */
export function runSession({
  dir, arm, pluginDir, settingsFile, capUsd = 5, model = 'sonnet', claudeBin, runner,
}) {
  if (!claudeBin && !runner) throw new Error('runSession needs claudeBin');
  if (arm === 'ptasks' && !pluginDir) {
    throw new Error('the ptasks arm needs pluginDir — without it the plugin is '
      + 'never loaded and the arm is a second `none` arm wearing its name');
  }

  const args = ['-p', '--output-format', 'json', '--model', model,
    '--permission-mode', 'bypassPermissions', '--max-budget-usd', String(capUsd)];
  if (settingsFile) args.push('--settings', settingsFile);
  if (arm === 'ptasks') args.push('--plugin-dir', pluginDir);

  const [cmd, pre] = runner ? [runner, [claudeBin]] : [claudeBin, []];
  const r = spawnSync(cmd, [...pre, ...args], {
    cwd: dir, encoding: 'utf-8', maxBuffer: 1 << 28, input: PROMPT,
  });

  const blank = { cost_usd: null, num_turns: null, usage: null, session_id: null, hit_cap: false };
  if (r.error) return { ...blank, error: String(r.error.message) };
  if (!r.stdout) return { ...blank, error: `claude exited ${r.status}: ${(r.stderr ?? '').slice(0, 300)}` };

  let out;
  try { out = JSON.parse(r.stdout); }
  catch { return { ...blank, error: `unreadable output: ${r.stdout.slice(0, 200)}` }; }

  const cost = out.total_cost_usd ?? null;
  return {
    cost_usd: cost,
    num_turns: out.num_turns ?? null,
    usage: out.usage ?? null,
    session_id: out.session_id ?? null,
    hit_cap: cost !== null && cost >= capUsd * CAP_MARGIN,
    error: null,
  };
}
