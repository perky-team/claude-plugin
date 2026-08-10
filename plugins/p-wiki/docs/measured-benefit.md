# p-wiki: what we measured

August 2026. We ran the same questions against a repo with the wiki and without it, and counted what
it cost and how right the answers were. This page is the result, including the parts that came out
against the plugin.

The repositories are private, so they are described by shape, not by name.

## The result

Five comparisons. First number is with the wiki, second is without.

| What we compared | Facts covered | Cost | Time | Verdict |
|---|---|---|---|---|
| Knowledge captured from outside the repo, vs the repo alone | **100% / 14%** | $0.25 / $0.52 | 39 s / 108 s | **The wiki is the whole answer** |
| Compiled pages, vs the long documents they came from | 100% / 97% | $0.24 / $0.30 | 37 s / 59 s | **Cheaper and faster** |
| Wiki **next to** the repo's own docs, vs those docs alone | 96.6% / 93.9% | $0.47 / $0.47 | 90 s / 90 s | No difference we can see |
| Wiki **instead of** the repo's own docs | **80% / 94%** | $0.52 / $0.47 | 110 s / 90 s | **Worse** |
| Pages with `file:line` anchors, vs plain pages | 95% / 96.6% | $0.47 / $0.47 | 79 s / 90 s | No difference |

**The noise floor is ±2.6 points of coverage and ±$0.043 of cost.** Anything smaller than that is not
a result. Rows 3 and 5 are inside it. Rows 1, 2 and 4 are outside it.

"Facts covered" means: each question came with a checklist of facts taken from the source documents,
and a separate grading run counted how many of them the answer actually stated.

## What that means

- **Capture knowledge that lives outside the repo.** Confluence pages, links, pastes. This is the case
  p-wiki is built for and the one place the numbers are dramatic. Without the wiki the agent did not
  just fail — it answered confidently and wrongly, denying that two of the project's branch types
  exist and inventing a commit convention.
- **Don't compile your own docs and then read only the wiki.** A page is a summary, and summaries drop
  exact values. In the fourth row the wiki had lost a protocol reject code that appears 19 times in
  the sources, and an error-reason constant that appears once. Both were simply gone.
- **Compiling your own docs and keeping them both is harmless but not free.** No measured gain, and
  the wiki pages are extra reading (see below).

## Will it pay off in my repo?

Count the pages that have **no other home in the repo** — every entry in their `sources:` frontmatter
sits under `docs/wiki/raw/`, meaning the content was captured from outside.

| Wiki | Pages | Captured from outside | Summary of in-repo docs |
|---|---:|---:|---:|
| Large specification repo | 182 | **0.5%** | 98.9% |
| Small service repo | 9 | **77.8%** | 22.2% |
| Product repo | 10 | 0% | 90% |
| Fourth repo | 0 | — | scaffold only, never filled |

High share → the wiki is carrying knowledge nothing else holds, and it pays off. Low share → it is a
second copy of what is already there.

## Why row 3 comes out at zero

We counted what the agent actually did.

| | Searches | Wiki pages read | Source files read | Files read in total |
|---|---:|---:|---:|---:|
| Wiki + sources | 3.1 | 3.4 | 2.5 | **5.9** |
| Sources only | 4.9 | — | 3.5 | **3.5** |

The wiki does help twice: fewer searches (3.1 against 4.9) and fewer source files (2.5 against 3.5).
But the pages are reading too, so the total goes up. That is why the cost does not fall.

The agent also checks pages against their sources instead of trusting them. That is correct — a
derived page can go stale, which is what `/p-wiki:lint` is for. `/p-wiki:query` now does the check
deliberately and cheaply: it opens the cited source only when the question turns on an exact value.

## What we got wrong

- **One result was withdrawn.** A sixth comparison, on questions needing many documents at once,
  looked like a 22–33% saving. Then the transcripts showed the runs had not done comparable work: some
  fanned out to subagents and some did not, unevenly across sides. On the single question where
  neither side fanned out, the ordering held — wiki-only $1.01, wiki+sources $1.50, sources-only $1.75
  — but one question is a hint, not a result. What did survive: all four wrong statements in that
  round came from sides holding a wiki, and the sources-only side made none.
- **Row 2 is weaker than it looks.** The pages side also kept `.claude/rules/p-wiki.md`, which points
  the agent at `docs/wiki/pages/`; nothing pointed the other side at its documents. Part of the saving
  is that pointer, not the compiling. The captured documents also still named pages that had been
  deleted, and two runs wasted calls on them.
- **An idea we were confident about did nothing.** We added 264 `[src: file:line]` anchors to 28 pages
  so the agent could verify a fact by reading three lines instead of a whole file. Row 5 is the result:
  nothing. The agent was already reading in ranges. An anchor replaces a search call, and search calls
  are cheap; what costs is the extra step.
- **An earlier draft of this page had errors.** An independent audit found a bug in our own counting
  script — reads with a relative path were classed as source files instead of wiki pages, 44 of them —
  and a case where we quoted the run-to-run spread of a single arm as though it were the margin for
  comparing two arms. Both are fixed above. It also caught two internal figures quoted verbatim from a
  private repo, now generalised.

## Method

- Two copies of one repo: one with `docs/wiki/` and the p-wiki rule, one with both removed. The source
  documents are byte-identical between copies (`diff -rq`). Wiki mentions were also stripped from the
  baseline's `CLAUDE.md` so it would not hunt for a missing directory.
- Answers from `claude -p --output-format json`, model `sonnet`, no human in the loop. That JSON is
  where the cost, time and token numbers come from. Tool use counted from the session transcripts.
- Checklists built from the sources, never from the wiki, so a wiki that drops a detail scores lower
  instead of setting its own bar.
- The noise floor is the standard error of the 16 paired question-by-question comparisons. The three
  differences in row 3 are +2.7 points (SE 2.6), +$0.005 (SE $0.043) and −78k input tokens (SE 78k) —
  each within about one standard error of zero.

### Where the method is weak

- 8 questions × 2 runs for rows 3–5, 5 questions for rows 1–2, 3 for the withdrawn one. Small.
- One model, one point in time. A stronger model may navigate raw documents better, which moves
  everything.
- Two repositories. One had an unusually good baseline — glossary, dozens of cross-linked decision
  records, an error catalog — so row 3 says as much about that baseline as about p-wiki.
- Grading was consistent but not truly blind: answers cite their files, and a `docs/wiki/` citation
  gives the side away.
- We meant to allow only reading tools. That did not hold: 75 `Bash` calls across 77 runs, and not
  evenly — 3 on the wiki side against 13 on the baseline in row 1, four of those reading file content.
  Row 1's conclusion does not rest on file counts.
- `/p-wiki:query` ran once in 77 runs. Otherwise these numbers describe a wiki read as plain files,
  not the plugin's own search.
- Everything here is an agent reading. What a wiki is worth to a **person** — 3.14× less text, 13.7
  links per page, a Confluence mirror for people without the repo — was not measured.

Total cost of the study: **$64.93** for 77 answer runs, 77 grading runs and the anchoring of 28 pages.

## What we changed because of it

- `docs/wiki/CLAUDE.md` gained an **Identifiers verbatim** compile rule — keep the source's exact
  codes, keys, numbers and file names on any fact the page states. `compile` repeats it, so it applies
  to wikis whose copy of that file predates the rule.
- `/p-wiki:query` gained the source check described above.
- `pwiki upgrade-schema` was added, because `/p-wiki:init` writes `docs/wiki/CLAUDE.md` once and never
  rewrites it — so rule changes used to reach new wikis only.

The identifiers rule is not measured yet. It targets the one defect that showed up in every
comparison, but so did the anchors idea that failed.
