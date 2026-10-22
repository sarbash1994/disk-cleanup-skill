---
name: git-cleanup
description: Clean up what coding-agent sessions left behind in a git repository: linked worktrees, local branches whose work is already in the default branch, orphaned worktree folders and loose logs. Builds a report first and deletes only the groups the user approves.
disable-model-invocation: true
---

Run from the main checkout, not from a linked worktree. The default is a **dry run**: build the report, show it, stop. Delete only after the user answers in chat, and only the groups they approved.

## 1. Inventory

1. `git fetch --prune origin`. Find the default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` (for example `origin/main`); call it `<base>` below.
2. `git worktree list --porcelain`, `git branch -vv`, `git stash list`.
3. If `gh` is installed and `gh auth status` succeeds: `gh pr list --state all --limit 500 --json number,state,headRefName` once, and match branches to PRs by `headRefName`. Without `gh`, there is no PR data: treat every branch as if it might have an open PR, so a branch is Delete only through the git checks below.
4. Agent worktree folders: `.claude/worktrees/` and `.worktrees/` inside the repository, nothing else. Linked worktrees elsewhere are cleaned through `git worktree`, but their parent folders are never scanned. List subfolders that `git worktree list` does not know, and loose files (`*.log`, `*.txt`) in those folders. Compare folder names, not paths: on Windows Git prints `C:/…` and bash prints `/c/…`. Do not run `du` on worktrees: `node_modules` makes it take minutes.

## 2. Classify

Each worktree and each local branch goes into exactly one group, checked top to bottom.

A branch is **landed** when any of these holds:

- its PR is `MERGED`;
- `git merge-base --is-ancestor <branch> <base>`;
- `git cherry <base> <branch>` prints only `-` lines: every commit is already in the default branch under another hash (rebase, squash of a single commit, cherry-pick).

| Group | Condition | Action |
|---|---|---|
| Keep | `<base>`, the current branch; an open PR; a worktree with output from `git -C <path> status --porcelain`; a `locked` worktree; a worktree an agent session is running in (ask the harness if it can list sessions); commits not on any remote (`git log <branch> --not --remotes`) unless the branch is landed by `git cherry` | do not touch, say why |
| Delete | landed | remove the worktree, delete the branch |
| Ask | everything else: a closed PR that was not merged, a pushed branch with no PR | the user decides per item |

A detached-HEAD worktree is Delete when `git branch -r --contains <HEAD>` is not empty and the worktree is clean, otherwise Keep.

## 3. Report

One table per group: worktree folder, branch, PR (number and state), last commit date (`git log -1 --format=%cs`), reason. Then the remote branches that would go (landed, not the default branch), orphaned folders, loose files, and stashes (report only, never dropped). End with the counts and one question: which groups to delete, and whether remote branches go too.

## 4. Delete

1. Re-check each item right before deleting it: the state may have changed since the report.
2. Worktree: `git worktree remove <path>`. If it fails on Windows over long paths, and the worktree is still clean, `rm -rf <path>`. A folder locked by a running process (a dev server) is reported, not forced.
3. Local branch: `git branch -d`; use `-D` only for a branch classified as landed (squash and rebase merges hide it from `-d`).
4. Remote branch: `git push origin --delete <branch>`, only for landed branches and only if the user approved remote deletion explicitly.
5. Orphaned folders and loose files in the agent worktree folders: delete.
6. Finish with `git worktree prune` and `git worktree list`. Report what was deleted, what failed (with the error line) and what was kept.

Never delete: the default branch, the current branch, anything in Keep, stashes, files outside the agent worktree folders.
