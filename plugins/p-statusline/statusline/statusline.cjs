const { execSync } = require("child_process");
const os = require("os");
let data = "";
process.stdin.on("data", c => data += c);
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(data);
    const cw = j.context_window || {};
    const pct = cw.used_percentage;
    const size = cw.context_window_size;
    // Tokens currently in the context window. `total_input_tokens` is the
    // real field (includes cache reads/writes); fall back to an estimate
    // derived from the percentage on older Claude Code versions that lack it.
    const used = cw.total_input_tokens != null ? cw.total_input_tokens
               : (pct != null && size != null) ? Math.round(size * pct / 100)
               : null;
    const fmtK = n => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

    // Colour ramp (xterm-256). The first 9 colours (green -> orange-red) are
    // spread evenly across 0-50%; at 50% and above it is solid red. So every
    // ~5.5% below the halfway mark is a visibly distinct, warmer colour.
    const GRAD = [46, 118, 154, 190, 226, 220, 214, 208, 202, 196];
    const gradColor = p => {
      p = p || 0;
      const last = GRAD.length - 1;
      const idx = p >= 50 ? last : Math.min(last - 1, Math.floor(p / (50 / last)));
      return `\x1b[38;5;${GRAD[idx]}m`;
    };

    // Limit ramp: keyed on the full 0-100% range — one GRAD step redder per
    // 10% (unlike gradColor, which saturates at 50%). For rate-limit usage
    // higher is worse, so every 10% closer to the cap is visibly warmer.
    const limitColor = p => {
      p = p || 0;
      const idx = Math.min(GRAD.length - 1, Math.floor(p / 10));
      return `\x1b[38;5;${GRAD[idx]}m`;
    };

    // Reset-time ramp: cool (far from reset) -> warm (reset imminent). Keyed
    // on the fraction of the window still left, so the 5h and 7d windows are
    // compared on the same proportional scale. Ends at bright yellow — no
    // orange/red, to stay distinct from limitColor on the percentage beside
    // it. Returns dim gray when the reset time is unknown.
    const RESET_RAMP = [26, 32, 39, 45, 51, 229, 227, 226];
    const resetColor = (label, epoch) => {
      if (!epoch) return "\x1b[90m";
      const winSec = label === "5h" ? 5 * 3600 : 7 * 86400;
      let frac = (epoch - Date.now() / 1000) / winSec;
      frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
      const idx = Math.min(RESET_RAMP.length - 1, Math.floor((1 - frac) * RESET_RAMP.length));
      return `\x1b[38;5;${RESET_RAMP[idx]}m`;
    };

    // Cache hit % — how much of the last API call's input came from the prompt
    // cache. Claude Code hands us those token counts on stdin as
    // `context_window.current_usage`, so nothing has to be read from disk. An
    // earlier version of this script tailed 512 KB of the transcript and parsed
    // JSONL backwards on every ~300ms render to derive the same three numbers.
    // `current_usage` is null before the first API call of the session, and
    // again right after /compact until the next call refills it.
    let cachePct = null;
    const cu = cw.current_usage;
    if (cu) {
      const cr = cu.cache_read_input_tokens || 0;
      const cc = cu.cache_creation_input_tokens || 0;
      const it = cu.input_tokens || 0;
      if (cr + cc + it > 0) cachePct = (cr / (cr + cc + it)) * 100;
    }
    // Strip any trailing parenthetical from the display name (e.g. the
    // "(1M context)" suffix Claude Code appends in 1M-context sessions) so
    // line 2 shows just the bare model name.
    const model = ((j.model && j.model.display_name) || "").replace(/\s*\([^)]*\)\s*$/, "");
    const effort = (j.effort && j.effort.level) || "";
    const cwd = (j.workspace && j.workspace.current_dir) || j.cwd || "";
    // Displayed name = the session launch directory (workspace.project_dir);
    // it stays fixed even if the working directory changes mid-session.
    // Falls back to cwd on older Claude Code versions that lack the field.
    const projDir = (j.workspace && j.workspace.project_dir) || cwd;
    const dirPath = projDir ? projDir.replace(/\\/g, "/") : "";

    // Git branch + dirty flag.
    // Every git call carries a 1s timeout: the status line re-renders every
    // ~300ms, so a stuck git (index lock, slow/network FS, AV scan) must
    // degrade to "no branch" rather than freeze the whole line. A timeout
    // throws, which the surrounding try/catch already swallows.
    // `git branch --show-current` reports the branch even on an unborn branch
    // (a repo with no commits yet), where `rev-parse --abbrev-ref HEAD` fails
    // with "ambiguous argument HEAD". It prints nothing on a detached HEAD, so
    // fall back to the short commit hash there.
    let gitSeg = "";
    if (cwd) {
      // Detect a non-repo cwd explicitly so the segment can say so, instead of
      // collapsing to empty (which is indistinguishable from "rendered, no
      // branch info available").
      let inRepo = false;
      try {
        execSync("git rev-parse --is-inside-work-tree", { cwd, timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
        inRepo = true;
      } catch (_) {}
      if (!inRepo) {
        gitSeg = "\x1b[90m⎇ no git\x1b[0m";
      } else try {
        let branch = "";
        try {
          branch = execSync("git branch --show-current", { cwd, timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        } catch (_) {}
        if (!branch) {
          branch = execSync("git rev-parse --short HEAD", { cwd, timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        }
        if (branch) {
          let dirty = "";
          try {
            const status = execSync("git status --porcelain --untracked-files=no", { cwd, timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString();
            // Bold bright-white "*" so uncommitted changes stand out against
            // the magenta branch name. The trailing reset is supplied by the
            // segment wrapper (C.reset), since "*" is the last character.
            if (status.trim().length > 0) dirty = "\x1b[1;97m*";
          } catch (_) {}
          // Linked-worktree marker. Claude Code reports the worktree name on
          // stdin as `workspace.git_worktree` and omits the field in the main
          // working tree, so detecting a worktree costs no git call at all —
          // this used to compare `git rev-parse --git-dir --git-common-dir`.
          // Yellow "wt", gray ":", then back to bright magenta (95m, matching
          // C.git) for the branch name: the marker has to catch the eye,
          // because it is the one thing saying you are not in the main tree.
          const worktreeMark = (j.workspace && j.workspace.git_worktree)
            ? "\x1b[93mwt\x1b[90m:\x1b[95m"
            : "";
          // Commits ahead/behind the upstream branch, always shown as
          // "↑N↓M". rev-list --left-right --count @{upstream}...HEAD prints
          // "<behind>\t<ahead>"; it fails (caught) with no upstream, leaving
          // the 0/0 default. Arrows stay gray and a zero count stays gray; a
          // non-zero count is green. So synced and no-upstream render fully
          // gray, while real divergence highlights just the digits.
          let abAhead = 0, abBehind = 0;
          try {
            const ab = execSync("git rev-list --left-right --count @{upstream}...HEAD", { cwd, timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
              .toString().trim().split(/\s+/);
            if (ab.length === 2) {
              abBehind = parseInt(ab[0], 10) || 0;
              abAhead = parseInt(ab[1], 10) || 0;
            }
          } catch (_) {}
          const abNum = n => (n > 0 ? "\x1b[38;5;82m" : "\x1b[90m") + n;
          const aheadBehind = " \x1b[90m↑" + abNum(abAhead) + "\x1b[90m↓" + abNum(abBehind);
          // Leading U+2387 glyph marks the segment as git; it inherits the
          // magenta segment colour. Order: icon, "wt:", branch, "*", ahead/behind.
          gitSeg = "⎇ " + worktreeMark + branch + dirty + aheadBehind;
        }
      } catch (_) {}
    }

    // Rate-limit usage (5-hour & 7-day windows) for Claude.ai Pro/Max
    // subscribers. Claude Code passes this on stdin as `rate_limits`; each
    // window carries `used_percentage` (0-100) and `resets_at` (Unix epoch
    // SECONDS). The field is absent until the first API response of the
    // session, and each window may be independently absent — fall back to
    // "n/a" in that case.
    //
    // NOTE: do NOT query the GET /api/oauth/usage HTTP endpoint instead — it
    // rate-limits (HTTP 429) aggressively and stays stuck for the whole
    // session. The stdin field is the supported, request-free source.
    // Fixed-width sub-segments: "5h XXX%[XXXXX]" is 14 visible chars,
    // "7d XXX%[XXXXXX]" is 15, and the "5h n/a" / "7d n/a" placeholders are
    // padded to the same widths. Right-align the percentage (max "100") and
    // the countdown so the landmarks ('%', '[', ']') stay in fixed columns.
    // The two countdown widths differ because the widest value each window can
    // reach differs: "4h59m" (5) in the 5-hour window, "10h10m" (6) in the
    // 7-day one during its last day. A 6-wide slot in the 5-hour window would
    // hold a permanently empty column.
    const RESET_W = { "5h": 5, "7d": 6 };
    // Sub-segment width: label(2) + space + pct(3) + "%" + "[" + countdown + "]".
    const padLim = (label, s) => s + " ".repeat(Math.max(0, 9 + RESET_W[label] - s.length));
    let limitsSeg = `\x1b[90m${padLim("5h", "5h n/a")} ${padLim("7d", "7d n/a")}\x1b[0m`;
    (() => {
      try {
        const rl = j.rate_limits || {};
        const fh = rl.five_hour;
        const sd = rl.seven_day;
        const fiveHr   = fh && fh.used_percentage != null ? Math.round(fh.used_percentage) : null;
        const sevenDay = sd && sd.used_percentage != null ? Math.round(sd.used_percentage) : null;
        if (fiveHr == null && sevenDay == null) return;
        // Compact countdown until the window resets: "3h12m", "2d4h", "45m".
        const fmtReset = epoch => {
          if (!epoch) return "?";
          const ms = epoch * 1000 - Date.now();
          if (!(ms > 0)) return "now";
          const m = Math.floor(ms / 60000);
          const d = Math.floor(m / 1440);
          const h = Math.floor((m % 1440) / 60);
          if (d > 0) return `${d}d${h}h`;
          if (h > 0) return `${h}h${m % 60}m`;
          return `${m % 60}m`;
        };
        const seg = (label, p, epoch) => p == null
          ? `\x1b[90m${padLim(label, `${label} n/a`)}\x1b[0m`
          : `\x1b[90m${label} \x1b[0m${limitColor(p)}${String(p).padStart(3)}%\x1b[0m\x1b[90m[\x1b[0m${resetColor(label, epoch)}${fmtReset(epoch).padStart(RESET_W[label])}\x1b[0m\x1b[90m]\x1b[0m`;
        limitsSeg = `${seg("5h", fiveHr, fh && fh.resets_at)} ${seg("7d", sevenDay, sd && sd.resets_at)}`;
      } catch (_) {}
    })();

    // ANSI colors
    const C = {
      dir:   "\x1b[33m",  // yellow
      git:   "\x1b[95m",  // bright magenta
      sep:   "\x1b[90m",  // dim gray
      reset: "\x1b[0m",
    };
    const SEP = `${C.sep} | ${C.reset}`;

    const parts = [];

    // Segment 1: context %  +  consumed tokens  +  cache hit % — "8% 80k c99%"
    // The % and token count share the 10-step green->red gradient keyed on context usage.
    // Before the first API response of the session nothing has been consumed
    // yet (`pct` and `used` are both 0/absent) — show a dim "-%" placeholder
    // rather than a misleading "0".
    // `cacheBit` is tracked apart from the left bits so the alignment padding
    // below can be inserted between them — keeping "c99%" flush against the
    // following " | " separator.
    let seg1Left = "";
    let cacheBit = "";
    if (!pct && !used) {
      seg1Left = `${C.sep}-%${C.reset}`;
    } else {
      const ctxBits = [];
      if (pct != null)  ctxBits.push(`${gradColor(pct)}${Math.round(pct)}%${C.reset}`);
      if (used != null) ctxBits.push(`${gradColor(pct != null ? pct : 0)}${fmtK(used)}${C.reset}`);
      seg1Left = ctxBits.join(" ");
      // Cache hit % — always dim gray: it is informational, not a warning.
      // A dim "c-" stands in when the figure is not known yet (right after
      // /compact, until the next API call), so the segment keeps its shape
      // instead of silently losing a field.
      cacheBit = cachePct != null
        ? `${C.sep}c${Math.round(cachePct)}%${C.reset}`
        : `${C.sep}c-${C.reset}`;
    }
    if (seg1Left || cacheBit) {
      parts.push(seg1Left + (seg1Left && cacheBit ? " " : "") + cacheBit);
    }

    // Segment 2: rate limits with reset countdowns
    parts.push(limitsSeg);

    // Segment 3: git branch — "*" marks uncommitted changes
    if (gitSeg)  parts.push(`${C.git}${gitSeg}${C.reset}`);

    // System RAM fill — "RAM 59%", the percentage coloured by the limit ramp
    // (greener when free, redder as it fills). os.freemem() reports available
    // physical memory, so used% = (total - free) / total.
    let ramSeg = "";
    try {
      const totalB = os.totalmem(), freeB = os.freemem();
      if (totalB > 0) {
        const ramPct = Math.round((totalB - freeB) / totalB * 100);
        ramSeg = `${limitColor(ramPct)}RAM ${ramPct}%${C.reset}`;
      }
    } catch (_) {}

    // Visible width of a string, ignoring ANSI escape sequences.
    const vlen = s => s.replace(/\x1b\[[0-9;]*m/g, "").length;

    // Line 1: context / limits / git joined by " | ".
    // Line 2: model + effort, the project path, the session name, then RAM.
    const modelEffort = [];
    if (model)  modelEffort.push(`\x1b[90m${model}${C.reset}`);
    if (effort) modelEffort.push(`\x1b[90m${effort}${C.reset}`);
    let modelSeg = modelEffort.join(" ");

    // Pad the narrower of the two leading segments — context on line 1,
    // model+effort on line 2 — so the first " | " separator lines up
    // vertically across both lines. On line 1 the gap goes before the cache
    // bit, so "c99%" stays right-aligned flush against the separator.
    if (parts.length && modelSeg) {
      const w = Math.max(vlen(parts[0]), vlen(modelSeg));
      const gap = " ".repeat(w - vlen(parts[0]));
      parts[0] = cacheBit
        ? seg1Left + (seg1Left ? " " : "") + gap + cacheBit
        : parts[0] + gap;
      modelSeg += " ".repeat(w - vlen(modelSeg));
    }

    let out = parts.join(SEP);
    // Match the path width to the limits-section width so the trailing " | "
    // separator lines up vertically with line 1. Longer paths are truncated
    // from the start with a "..." prefix (keeping the folder name visible);
    // shorter paths get a trailing space pad.
    const limitsVlen = parts[1] ? vlen(parts[1]) : 0;
    let dirDisplay = dirPath;
    if (dirPath && limitsVlen > 0) {
      if (dirPath.length > limitsVlen) {
        dirDisplay = limitsVlen <= 3
          ? dirPath.slice(dirPath.length - limitsVlen)
          : "..." + dirPath.slice(dirPath.length - (limitsVlen - 3));
      } else if (dirPath.length < limitsVlen) {
        dirDisplay = dirPath + " ".repeat(limitsVlen - dirPath.length);
      }
    }
    const line2 = [];
    if (modelSeg)    line2.push(modelSeg);
    if (dirDisplay)  line2.push(`${C.dir}${dirDisplay}${C.reset}`);

    // Then the session name — the one set with --name or /rename, or else the
    // title Claude Code writes from the first prompt. The field is absent at
    // session start until that title exists, and again right after /clear;
    // print a dim "-" then, so the segment never vanishes and RAM keeps its
    // column. Trim the name to whatever room is left on the line: the width
    // arrives in COLUMNS — Claude Code captures our stdout, so the script
    // cannot measure the terminal itself. With no room left the name is
    // dropped rather than wrapping line 2 onto a second row.
    const sessionName = typeof j.session_name === "string" ? j.session_name.trim() : "";
    const cols = parseInt(process.env.COLUMNS, 10) || 0;
    let nameSeg = sessionName || "-";
    if (cols > 0) {
      // Everything but the name: the segments already queued, RAM (which
      // follows the name), and one SEP for each of them.
      const others = line2.length + (ramSeg ? 1 : 0);
      const used = line2.reduce((n, seg) => n + vlen(seg), 0) + vlen(ramSeg) + others * vlen(SEP);
      const room = cols - used;
      if (room < nameSeg.length) nameSeg = room > 1 ? nameSeg.slice(0, room - 1) + "…" : "";
    }
    if (nameSeg) line2.push(`${C.sep}${nameSeg}${C.reset}`);
    if (ramSeg)  line2.push(ramSeg);
    if (line2.length) out += "\n" + line2.join(SEP);

    process.stdout.write(out);
  } catch (e) {}
});
