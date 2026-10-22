# git-cleanup

An agent skill that cleans up what coding-agent sessions leave behind in a git repository: a linked worktree per task, a branch per worktree, folders whose worktree was already removed, build and test logs.

Compatible with any agent that reads `SKILL.md` files (Claude Code, Codex, Cursor and others via the `skills` CLI).

## What it does

1. **Inventory.** Fetches with `--prune`, lists worktrees, local branches, stashes and, when `gh` is available, every PR of the repository.
2. **Classify.** Each worktree and branch goes into one group:
   - **Delete**: the work is in the default branch. The PR is merged, the branch is an ancestor of the default branch, or `git cherry` shows every commit already there under another hash (rebase, cherry-pick).
   - **Keep**: an open PR, uncommitted changes, commits that exist only locally, a locked worktree, a worktree a running session uses, the current or default branch.
   - **Ask**: the rest, such as a PR closed without merging.
3. **Report.** A table per group with the reason for each item, then one question: which groups to delete.
4. **Delete.** Only what the user approved. Each item is re-checked right before deletion. Remote branches are deleted only with separate approval. Stashes are never touched.

It is a dry run until you answer. The frontmatter sets `disable-model-invocation: true`, so the agent never runs it on its own: you type `/git-cleanup`.

## Install

With the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add sarbash1994/git-cleanup-skill
```

For every project on this machine:

```bash
npx skills add sarbash1994/git-cleanup-skill -g
```

Manual install for Claude Code: copy `skills/git-cleanup/` into `.claude/skills/` of a project (or `~/.claude/skills/` for every project) and start a new session.

## Requirements

- `git` 2.20 or newer.
- `gh` (optional), logged in to an account that can read the repository's PRs. Without it the skill relies on git alone and sends unmerged pushed branches to Ask.

## Scope

Folders are scanned for orphans only in `.claude/worktrees/` and `.worktrees/` inside the repository. Linked worktrees in other places are removed through `git worktree remove`; their parent folders are never scanned or deleted.

## License

MIT. See [LICENSE](LICENSE).
