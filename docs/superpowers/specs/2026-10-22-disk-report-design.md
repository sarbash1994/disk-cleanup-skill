# Disk report and cleanup: design

Date: 2026-10-22. Status: draft, awaiting owner approval.

## Intent

The owner runs this skill when the disk is nearly full. The first thing they want is a picture of **what takes the space and why**, across the whole developer machine, not only one repository. Then they pick what to delete. The current `git-cleanup` skill (worktrees and landed branches of one repo) becomes one group inside this report.

The repository is public, so the skill must work for other people on Windows, macOS and Linux.

## Goals

- One command shows a grouped report of developer disk usage with a size, a reason and a safety tag on every row.
- The user decides what goes; the skill deletes exactly that and reports what was freed.
- Works on Windows, macOS and Linux without extra installs beyond Node.js and git.

## Non-goals

- No automatic or scheduled cleanup; the skill never runs on its own (`disable-model-invocation: true`).
- No OS-level cleanup: system temp of other apps, Windows Update, Trash, browser caches, user documents.
- No deletion of anything outside the categories below.

## Anti-goals (a failure even if it technically works)

- Deleting work: uncommitted changes, commits that exist only locally, stashes, a worktree a running session uses.
- Deleting agent session history or memory (for example `~/.claude/projects/`, `~/.claude/` memory files).
- Deleting a row the user did not choose, or a row whose state changed since the report.
- A scan that hangs for minutes with no output (the `du` on `node_modules` problem seen in the first run).

## Decided by the owner

- **Trigger:** the owner, manually, when disk space runs low.
- **Scope:** the whole machine: every project regardless of IDE (WebStorm, VS Code, Cursor, terminal), npm and other package caches, Playwright browsers, temporary folders of Claude and other agents.
- **Flow:** the skill only shows; the user decides what to delete.
- **Layout:** groups with a total and a size bar each, rows inside (mockup option B).
- **Platforms:** Windows, macOS, Linux.
- **Language:** the report is in the language the user asked in, any language; English when that is unclear.
- **Name:** the skill is renamed `disk-cleanup` and the repository `disk-cleanup-skill` (GitHub redirects the old URL). `git-cleanup` is removed; its rules live on inside `disk-cleanup`.
- **Groups** (proposed in the conversation, accepted as is):
  1. Projects: `node_modules`, build outputs (`.next`, `dist`, `build`), agent worktrees and git leftovers, with days since the project was last touched.
  2. Package caches: npm, pnpm, yarn, bun, pip.
  3. Test browsers: Playwright, Puppeteer.
  4. Agent temporary files: Claude Code, Cursor, Codex.
  5. Heavy, show only: Docker, Xcode DerivedData and simulators, Android SDK and emulators, Gradle.

## How it works

### Skill and script

`SKILL.md` stays short: run the scan, open the report, ask which rows to delete, run the deletion, report. The work is done by a bundled Node.js script (`scripts/scan.mjs`, Node 18+, no dependencies) so every OS gets the same result without the agent improvising shell commands.

- `node scan.mjs report [--roots <dir>...] [--strings <file.json>]` scans, writes `report.json` and `report.html` to the OS temp dir, prints their paths and a short text summary (group totals, top 5 rows) for the chat.
- `node scan.mjs delete <ids>` reads the saved `report.json`, re-checks each chosen row, deletes it, and prints per row: freed size, or why it was skipped or failed.

### Language

Every user-visible string of the report (headings, tags, group names, reason templates with placeholders such as `{days}`) lives in one English table inside the script; `node scan.mjs strings` prints it as JSON. When the user asked in another language, the agent translates that JSON once, keeps the keys and placeholders, saves it to the temp dir and passes it with `--strings`. A missing or broken key falls back to English. Paths, sizes and commands are never translated.

### Report page (option B)

- Header: free and total space of each disk scanned, scan time.
- Groups sorted by total size, each with a total and a bar proportional to the largest group.
- Rows sorted by size: a short number (`#12`) to name it in chat, label, path (monospace), size, reason in plain words, tag.
- Tags: **safe** (regenerable or already in the default branch), **ask** (judgement call; the reason says what to weigh), **keep** (shown for completeness, cannot be selected), **show only** (heavy tools; the row gives the tool's own cleanup command for the user to run).
- The user answers in chat with numbers or ranges ("delete 1, 3, 5-8"). The page is read-only.

### Finding projects

- Roots: the user's home directory and, on Windows, other fixed drives (`D:\` and so on). `--roots` overrides.
- Skip system and app folders (Windows: `Windows`, `Program Files*`, `ProgramData`, `AppData`; macOS: `/System`, `/Library`, `~/Library`; Linux: `/proc`, `/sys`, `/usr`, `/var`, `~/.cache` is handled by the caches group instead), hidden folders except the ones a category needs, and never descend into `node_modules`.
- A folder with `.git` is a project; stop descending there except for agent worktree folders (`.claude/worktrees/`, `.worktrees/`).
- Recent-project lists of VS Code, Cursor and JetBrains are extra hints that add roots, not the only source.

### Classification rules

- `node_modules`: safe when the project was untouched for 30 days or more (newest commit and newest file mtime outside `node_modules`); otherwise ask, with the age in the reason.
- Build outputs: only folders that `git check-ignore` reports as ignored; safe.
- Git analysis is local and read-only during `report`: no `git fetch`, no network, so the scan never changes refs and stays fast. The full worktree check runs only in repos that have linked worktrees or agent worktree folders; `gh pr list` (one call per such repo, optional) is the only network use. Landed local branches without a worktree free no space, so they are not rows; the git group shows their count in one line. `delete` runs `git fetch --prune` in a repo before re-checking its rows.
- In use: `SKILL.md` passes the working directories of running agent sessions when the harness can list them (`--busy <dir>...`). The script also treats a worktree or agent temp folder with any file modified in the last 24 hours as in use. In use means keep for worktrees and ask for temp folders. When the script cannot tell, the row is ask, never safe.
- Worktrees and branches: the current `git-cleanup` rules (landed via merged PR, ancestor of the default branch, or `git cherry` all `-`; keep on open PR, dirty tree, local-only commits, locked worktree, running session). Orphaned folders in agent worktree folders and loose logs there: safe.
- Package caches: safe; deleted through the tool's own command where one exists (`npm cache clean --force`, `pnpm store prune`, `yarn cache clean`, `pip cache purge`), otherwise by removing the cache folder.
- Playwright and Puppeteer: the newest installed revision of each browser is keep; older revisions are safe.
- Agent temporary files: OS temp folders created by the agents (for example the `claude` folder in the system temp with scratchpads and task outputs) are safe when older than one day; session history, memory, settings and plugins are never listed as deletable.
- Heavy tools: show only, with the command (`docker system df` / `docker system prune`, Xcode DerivedData path, `xcrun simctl delete unavailable`, Android AVD manager, `gradle --stop` plus caches path).

### Deleting

- Re-check before each deletion (dirty state, new commits, a lock, the path still exists and is still the same kind of thing).
- Rows tagged keep or show only are refused even if named.
- Remote branches are deleted only if the user says so explicitly, as now.
- End with freed space per group and the new free space per disk.

### Scan speed

- The whole scan targets under two minutes on a typical developer machine, with progress lines while it runs.
- Size per target has a timeout; on timeout the row shows "size unknown" instead of blocking the report.

## Left to the builder

- How sizes are measured per OS, as long as the speed targets hold.
- HTML and styling of the report within the option B layout; the report works offline (no external assets).
- Internal structure of the script and its tests.

## Calls made by Claude (not discussed with the owner)

- The report is an HTML file plus a short chat summary; selection happens in chat, not with checkboxes on the page.
- The script is Node.js because anyone installing skills through `npx` has Node.
- Thresholds: 30 days for `node_modules`, one day for agent temp folders.
- No `git fetch` during the report; full git check only in repos with worktrees; landed branches without worktrees are counted, not listed.
- "In use" = a session directory passed by the agent, or a file modified in the last 24 hours; unknown means ask.
