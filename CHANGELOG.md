# Changelog

## 1.0.0

Scores changed in this release, so some files will move after you update.

- **Clearer labels:** Familiar (70+), Partial (40–69), Unfamiliar (below 40).
- **CodeLens and "Mark as reviewed":** each file Claude edited shows its score above the first line. Marking it reviewed after Claude changed it adds points (`claudeGrasp.codeLens` turns the lens off).
- **Fairer scores:**
  - A turn that changed more than 3 files splits its plan, question and correction credit between them, unless your prompt named the file.
  - Evidence never fades below 25% of its value.
  - Commits by other people (teammates) no longer count as you changing the file. Add more of your emails in `claudeGrasp.gitEmails`.
  - Deleted files, files git ignores, lockfiles, bundles, source maps and snapshots get no score. Add your own globs in `claudeGrasp.ignore`.
- **Several VS Code windows:** they share one database safely; only one reads sessions at a time.
- **Faster:** git runs off the editor's main thread, scores are recomputed only when something changed, and activation no longer waits for the first read.
- **Quiz:** each question is graded once, an empty answer is refused, and the grader treats the answer as data, not instructions.
- **Windows:** case-insensitive file lookup, `claude.cmd` support, `;`-separated `CLAUDE_GRASP_ROOTS`.
- **Rebuild Data** command, **Show Log** command and a "Claude Grasp" output channel.
- Dashboard shows an error when a file can't be loaded instead of staying blank.

## 0.1.1

- New icon.

## 0.1.0

First release.

- Scores every file Claude Code changed from 0 to 100 for how well you understand it, with every point explained.
- Dashboard with project overview, file map, trend, "Start here" list, file search and a "How to make this green" panel.
- Activity-bar view of projects and files, Explorer badges and a status-bar score for the open file.
- Reads every Claude Code config dir (`~/.claude`, `~/.claude-work`, …) with an account filter.
- Penalties for bare approvals, auto-accept, code volume and failed quiz answers are off by default; unattended edits count. All adjustable in Settings.
- Optional daily explain-back question through your own `claude -p`, off by default and always skippable.
- Light and dark themes, Guide and About tabs, and a demo with sample data.
