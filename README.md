# disk-cleanup

An agent skill for when the disk is nearly full. It scans a developer machine, shows what takes the space and why, and deletes only the rows you pick. It replaces the earlier `git-cleanup` skill; the worktree and branch rules of that skill now live in the Projects group.

Compatible with any agent that reads `SKILL.md` files (Claude Code, Codex, Cursor and others via the `skills` CLI). Runs on Windows, macOS and Linux.

## What it shows

One HTML report (`report.html` in the OS temp folder, plus `report.json`), five groups sorted by size, each with a total, a size bar and rows. Every row has a number you can name in chat, a path, a size, a reason in plain words and a tag.

1. **Projects**: `node_modules`, ignored build outputs (`.next`, `dist`, `build`), agent worktrees, orphaned worktree folders and loose logs in them, with days since the project was last touched.
2. **Package caches**: npm, pnpm, yarn, bun, pip.
3. **Test browsers**: Playwright and Puppeteer. The newest revision of each browser is kept; older ones are safe.
4. **Agent temporary files**: Claude Code temp folders in the system temp. Session history, memory, settings and plugins are never listed. Cursor and Codex temp folders are not covered yet.
5. **Heavy tools, show only**: Docker, Xcode DerivedData and simulators, Android SDK and emulators, Gradle. Each row gives the tool's own cleanup command for you to run.

## Tags

- **safe**: regenerable, or already in the default branch. `node_modules` is safe after 30 days untouched; agent temp folders after 1 day.
- **ask**: a judgement call; the reason says what to weigh. Anything modified in the last 24 hours, or a project touched less than 30 days ago, lands here.
- **keep**: shown for completeness, cannot be deleted (open PR, uncommitted changes, local-only commits, locked or busy worktree, newest browser revision).
- **show only**: heavy tools; the skill never runs their cleanup.

## How it works

1. `report` scans and writes the report. It is read-only: no `git fetch`, no network except one optional `gh pr list` per repository that has worktrees.
2. You answer in chat with numbers or ranges ("delete 1, 3, 5-8").
3. `delete` re-checks each chosen row right before removing it and refuses `keep` and `show only` rows, rows that changed since the report, and symlinks or junctions. It then prints freed space per group and free space per disk. Remote branches are deleted only on explicit request.

The skill sets `disable-model-invocation: true`: the agent never runs it on its own, you type `/disk-cleanup`.

The report is in English unless you ask in another language; the agent then translates the strings table once.

## Install

With the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add sarbash1994/disk-cleanup-skill
```

For every project on this machine:

```bash
npx skills add sarbash1994/disk-cleanup-skill -g
```

Manual install for Claude Code: copy `skills/disk-cleanup/` into `.claude/skills/` of a project (or `~/.claude/skills/` for every project) and start a new session.

## Requirements

- Node.js 18.15 or newer. No dependencies.
- `git`.
- Time: on large machines (many projects and worktrees, especially on Windows) the report can take two to four minutes. Progress lines show it is working.
- `gh` (optional), logged in to an account that can read the repositories' PRs. Without it, unmerged pushed branches go to ask.

## Scope

Projects are found under your home folder and, on Windows, the other fixed drives (`--roots` overrides). Inside a repository only agent worktree folders (`.claude/worktrees/`, `.worktrees/`) are scanned for leftovers; linked worktrees elsewhere are removed through `git worktree remove` and their parent folders are never touched. Nothing outside the five groups is ever deleted: no system temp of other apps, Trash, browser caches or documents.

## License

MIT. See [LICENSE](LICENSE).
