# disk-cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `git-cleanup` skill with `disk-cleanup`: a bundled Node.js script that reports developer disk usage across the machine as a grouped HTML page, and deletes exactly the rows the user names.

**Architecture:** `scripts/scan.mjs` is a CLI with three commands (`strings`, `report`, `delete`). Each group of rows comes from a collector module with the same shape, `collect(ctx) → Promise<Row[]>`; `ctx` carries every OS dependency (home, temp dir, platform, env, clock, a command runner), so tests run collectors against fixture folders. `report` merges rows, measures sizes, writes `report.json` and `report.html`; `delete` re-checks rows from `report.json` and removes them. `SKILL.md` only drives the script and the conversation.

**Tech Stack:** Node.js ≥ 18.15 (ESM, `node:test`, `fs.statfs`), git, optional `gh`. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-disk-report-design.md`

## Global Constraints

- Node 18.15 or newer, no runtime or dev dependencies; `package.json` has `"type": "module"` and `"engines": {"node": ">=18.15"}`.
- Windows, macOS and Linux. Paths through `node:path`; external commands through `child_process.spawn`/`execFile` with an argument array, never a shell string.
- `report` is read-only: no deletion, no `git fetch`, no network except one optional `gh pr list` per repo with worktrees.
- Never list as deletable: agent session history, memory, settings or plugins (for example `~/.claude/projects/`, `~/.claude/*.json`, `~/.claude/plugins/`); stashes; files outside the categories of the spec.
- Tags: `safe`, `ask`, `keep`, `show`. Only `safe` and `ask` rows can be deleted.
- Thresholds: `node_modules` safe after 30 days untouched; agent temp folders safe after 1 day; "recently modified" = any file changed in the last 24 hours.
- The whole `report` targets under two minutes on a typical developer machine and prints progress lines; one size measurement stops at its deadline and yields `bytes: null` ("size unknown").
- All user-visible report text comes from the strings table (Task 1); paths, sizes and commands are never translated. Missing keys fall back to English.
- The report HTML is one self-contained file: no external assets, colours as CSS variables on `:root` with a `prefers-color-scheme: dark` variant.
- Output files go to `path.join(os.tmpdir(), 'disk-cleanup')`.
- Skill name `disk-cleanup`, repository `sarbash1994/disk-cleanup-skill`; `git-cleanup` is removed.
- `SKILL.md` frontmatter keeps `disable-model-invocation: true`; the `description` value is in double quotes (a colon in it broke YAML once).

## Review Focus

1. Symlinks and Windows junctions (pnpm `node_modules`, linked packages): sizes do not follow them and deletion never touches their targets. Test in Task 2 and Task 9.
2. Folders the user cannot read (permission denied) during a walk: skipped, the walk continues, the report still renders. Test in Task 2.
3. Paths with spaces, non-Latin letters and `<&"` characters: escaped in HTML, passed as single arguments to commands. Test in Task 8 and Task 9.
4. A tool that is not installed (`git`, `gh`, `pnpm`, `docker`, `pip`): its rows are skipped, the rest of the report is unaffected. Test in Task 6 and Task 5.
5. `delete` with ids that do not exist, a missing or old `report.json`, or a row whose folder is gone: a clear per-row message, nothing else deleted. Test in Task 9.

---

## File Structure

```
package.json                         test script, engines, type module
skills/disk-cleanup/
  SKILL.md                           how the agent drives the script and the conversation
  scripts/scan.mjs                   CLI: strings | report | delete
  scripts/lib/row.mjs                Row typedef, makeRow(), GROUPS order
  scripts/lib/strings.mjs            English table, loadStrings(), t()
  scripts/lib/ctx.mjs                makeContext() for the real machine
  scripts/lib/walk.mjs               measureSize(), newestMtime()
  scripts/lib/disks.mjs              listDisks()
  scripts/lib/discover.mjs           defaultRoots(), findRepos()
  scripts/lib/collect/projects.mjs   node_modules and build outputs
  scripts/lib/collect/git.mjs        worktrees, orphans, loose logs, landed-branch count
  scripts/lib/collect/caches.mjs     npm, pnpm, yarn, bun, pip
  scripts/lib/collect/browsers.mjs   Playwright, Puppeteer
  scripts/lib/collect/agents.mjs     agent temp folders
  scripts/lib/collect/heavy.mjs      Docker, Xcode, Android, Gradle (show only)
  scripts/lib/report.mjs             buildReport(), renderHtml(), renderSummary()
  scripts/lib/delete.mjs             parseIds(), deleteRows()
tests/*.test.mjs                     node:test, fixtures in fs.mkdtemp folders
tests/helpers.mjs                    fixture builders (tree, git repo with bare origin, fake ctx)
```

Shared shapes (defined in Task 1, used everywhere):

```js
/** @typedef {'projects'|'caches'|'browsers'|'agents'|'heavy'} Group */
/** @typedef {'safe'|'ask'|'keep'|'show'} Tag */
/** @typedef {{type:'rm', path:string}
 *          | {type:'cmd', cmd:string, args:string[]}
 *          | {type:'worktree', repo:string, path:string, branch:string|null}
 *          | {type:'none'}} Action */
/** @typedef {{id:number, group:Group, label:string, path:string|null,
 *            bytes:number|null, tag:Tag, reason:{key:string, params:object},
 *            action:Action, command?:string}} Row */
/** ctx: {home, tmp, platform, env, now:number, busy:string[],
 *        run(cmd:string, args:string[], opts?:{cwd?:string, timeoutMs?:number})
 *          → Promise<{code:number|null, stdout:string, stderr:string}>} */
```

`run` resolves with `code: null` when the command is not installed or timed out; it never throws.

---

### Task 1: Repository layout, row model, strings and the `strings` command

**Files:**
- Create: `package.json`, `skills/disk-cleanup/scripts/scan.mjs`, `skills/disk-cleanup/scripts/lib/row.mjs`, `skills/disk-cleanup/scripts/lib/strings.mjs`, `skills/disk-cleanup/scripts/lib/ctx.mjs`, `tests/helpers.mjs`
- Test: `tests/strings.test.mjs`
- Modify: `.gitignore` (add `.superpowers/`)

**Interfaces:**
- Produces: `makeRow(fields): Row` (id 0 until `buildReport` numbers rows; defaults `bytes: null`, `action: {type:'none'}`); `GROUPS = ['projects','caches','browsers','agents','heavy']`; `EN: Record<string,string>`; `loadStrings(file?: string): Record<string,string>` (EN merged with the file's keys that are strings and keep every `{placeholder}` of the English value); `t(strings, key, params): string`; `makeContext({busy}): ctx` with a real `run` built on `execFile` (timeout default 20 s, `windowsHide: true`); test helpers `tmpdir()`, `writeTree(root, {relPath: content|null})` (null = folder), `fakeCtx(overrides)`.

- [ ] **Step 1: Write the failing tests**

```js
test('t fills placeholders', () => {
  assert.equal(t(EN, 'reason.nm_old', {days: 42}), EN['reason.nm_old'].replace('{days}', '42'));
});
test('loadStrings keeps English for missing or broken keys', async () => {
  const f = path.join(await tmpdir(), 's.json');
  await fs.writeFile(f, JSON.stringify({'tag.safe': 'безопасно', 'reason.nm_old': 'без плейсхолдера', 'nope': 1}));
  const s = loadStrings(f);
  assert.equal(s['tag.safe'], 'безопасно');
  assert.equal(s['reason.nm_old'], EN['reason.nm_old']);
});
test('scan.mjs strings prints the English table', async () => {
  const {stdout} = await execFileP(process.execPath, [SCAN, 'strings']);
  assert.deepEqual(JSON.parse(stdout), EN);
});
```

- [ ] **Step 2: Run `npm test` and see the three tests fail** (modules missing).
- [ ] **Step 3: Implement `row.mjs`, `strings.mjs`, `ctx.mjs`, the `strings` command in `scan.mjs` and `tests/helpers.mjs`.** `EN` holds every key later tasks use; add keys in the task that needs them. Starting keys: `title`, `scanned_at`, `disk_free` (`{free} free of {total}`), `group.projects|caches|browsers|agents|heavy`, `tag.safe|ask|keep|show`, `size_unknown`, `reason.nm_old` (`untouched for {days} days, reinstalls with the lockfile`), `reason.nm_recent` (`project touched {days} days ago`), `answer_hint` (`Reply in chat with row numbers, for example 1, 3, 5-8`). `scan.mjs` dispatches on `process.argv[2]` and exits 2 with a usage line for anything else.
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat(disk-cleanup): row model, strings table and CLI skeleton`.

### Task 2: Walking folders: sizes and newest change

**Files:**
- Create: `skills/disk-cleanup/scripts/lib/walk.mjs`
- Test: `tests/walk.test.mjs`

**Interfaces:**
- Produces: `measureSize(dir: string, {deadline: number}): Promise<number|null>` (sum of `size` of regular files, `lstat`, symlinks and junctions not followed, each `dev:ino` counted once with `bigint: true`, unreadable entries skipped, `null` when `Date.now() > deadline`); `newestMtime(dir: string, {skip: string[], limit: number}): Promise<number>` (max `mtimeMs` of files, not descending into names in `skip`, stops after `limit` entries; default skip `['node_modules', '.git']`, limit 20000).

- [ ] **Step 1: Write the failing tests**

```js
test('measureSize sums files and counts a hard link once', async () => {
  const d = await tmpdir(); await writeTree(d, {'a.txt': 'x'.repeat(1000), 'sub/b.txt': 'y'.repeat(500)});
  await fs.link(path.join(d, 'a.txt'), path.join(d, 'sub/a-link.txt'));
  assert.equal(await measureSize(d, {deadline: Date.now() + 5000}), 1500);
});
test('measureSize does not follow a symlink or junction', async () => {
  const outside = await tmpdir(); await writeTree(outside, {'big.bin': 'z'.repeat(4000)});
  const d = await tmpdir(); await fs.symlink(outside, path.join(d, 'link'), 'junction');
  assert.equal(await measureSize(d, {deadline: Date.now() + 5000}), 0);
});
test('measureSize returns null past the deadline', async () => {
  const d = await tmpdir(); await writeTree(d, {'a.txt': 'x'});
  assert.equal(await measureSize(d, {deadline: Date.now() - 1}), null);
});
test('measureSize skips an unreadable folder', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const d = await tmpdir(); await writeTree(d, {'ok.txt': 'x'.repeat(10), 'locked/secret.txt': 'y'});
  await fs.chmod(path.join(d, 'locked'), 0o000);
  assert.equal(await measureSize(d, {deadline: Date.now() + 5000}), 10);
  await fs.chmod(path.join(d, 'locked'), 0o755);
});
test('newestMtime ignores node_modules', async () => {
  const d = await tmpdir(); await writeTree(d, {'src/a.js': '1', 'node_modules/x/i.js': '2'});
  const old = new Date('2026-01-01'); await fs.utimes(path.join(d, 'src/a.js'), old, old);
  assert.equal(await newestMtime(d, {}), old.getTime());
});
```

- [ ] **Step 2: Run `npm test`; the walk tests fail.**
- [ ] **Step 3: Implement with `fs.promises.opendir` and an explicit stack (no recursion), up to 64 concurrent `lstat` calls.**
- [ ] **Step 4: Run `npm test`; expect PASS** (the chmod test is skipped on Windows and for root).
- [ ] **Step 5: Commit** `feat(disk-cleanup): folder sizes without following links`.

### Task 3: Disks and project discovery

**Files:**
- Create: `skills/disk-cleanup/scripts/lib/disks.mjs`, `skills/disk-cleanup/scripts/lib/discover.mjs`
- Test: `tests/discover.test.mjs`

**Interfaces:**
- Consumes: `ctx` (Task 1).
- Produces: `listDisks(ctx, paths: string[]): Promise<{mount:string,total:number,free:number}[]>` (`fs.statfs` per distinct root: drive letter on Windows, `/` and the home mount elsewhere; one entry per mount); `defaultRoots(ctx): Promise<string[]>` (home; on Windows also every `X:\` for C–Z that exists, minus the drive of home; plus folders from the IDE recent-project lists that exist and are not under another root — VS Code and Cursor `User/globalStorage/storage.json` keys `openedPathsList`/`backupWorkspaces`, JetBrains `options/recentProjects.xml` under every product folder; unreadable lists are ignored); `findRepos(roots: string[], ctx, {maxDepth: number}): Promise<string[]>` (folders that contain `.git`, file or directory; does not descend into a repo, `node_modules`, names in `SKIP_DIRS`, or hidden folders; default `maxDepth` 8); `SKIP_DIRS` per platform as in the spec, plus `$Recycle.Bin`, `System Volume Information`, `Library` under home on macOS, `.cache` under home on Linux.

- [ ] **Step 1: Write the failing tests**

```js
test('findRepos finds repos and does not descend into them or node_modules', async () => {
  const r = await tmpdir();
  await writeTree(r, {'a/.git/HEAD': 'x', 'a/inner/.git/HEAD': 'x', 'b/c/.git': 'gitdir: x',
                      'node_modules/d/.git/HEAD': 'x', '.hidden/e/.git/HEAD': 'x', 'AppData/f/.git/HEAD': 'x'});
  const found = (await findRepos([r], fakeCtx({platform: 'win32'}), {maxDepth: 8})).map(p => path.relative(r, p)).sort();
  assert.deepEqual(found, ['a', path.join('b', 'c')]);
});
test('defaultRoots adds an existing folder from the VS Code recent list', async () => {
  const home = await tmpdir(); const proj = await tmpdir();
  await writeTree(home, {'.config/Code/User/globalStorage/storage.json': JSON.stringify({openedPathsList: {entries: [{folderUri: pathToFileURL(proj).href}]}})});
  assert.ok((await defaultRoots(fakeCtx({home, platform: 'linux'}))).includes(proj));
});
```

- [ ] **Step 2: Run `npm test`; the discovery tests fail.**
- [ ] **Step 3: Implement.** IDE settings folders: Windows `%APPDATA%\Code`, `%APPDATA%\Cursor`, `%APPDATA%\JetBrains\*`; macOS `~/Library/Application Support/{Code,Cursor,JetBrains/*}`; Linux `~/.config/{Code,Cursor,JetBrains/*}`.
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat(disk-cleanup): find projects on every disk and from IDE recent lists`.

### Task 4: Projects collector: `node_modules` and build outputs

**Files:**
- Create: `skills/disk-cleanup/scripts/lib/collect/projects.mjs`
- Test: `tests/projects.test.mjs`

**Interfaces:**
- Consumes: `newestMtime` (Task 2), `makeRow` (Task 1), `ctx.run` for `git log -1 --format=%ct` and `git check-ignore`.
- Produces: `collect(ctx, repos: string[]): Promise<Row[]>`, group `projects`. For each repo: a row for top-level `node_modules` (and `node_modules` of workspace packages one level down under `packages/*`, `apps/*`); untouched days = `(ctx.now - max(lastCommitMs, newestMtime(repo))) / 86400000`, floored; `safe` with `reason.nm_old` at 30 days or more, otherwise `ask` with `reason.nm_recent`. A row for each of `.next`, `dist`, `build`, `out`, `.turbo`, `.parcel-cache`, `coverage` at the repo top level only when `git check-ignore -q <name>` exits 0; tag `safe`, reason `reason.build_ignored` (`build output, ignored by git, rebuilds`). Action `{type:'rm', path}`. Label `<repo folder name>/<name>`.

- [ ] **Step 1: Write the failing tests**

```js
test('old project: node_modules safe; ignored .next safe; tracked dist not listed', async () => {
  const repo = await gitRepo({files: {'package.json': '{}', '.gitignore': 'node_modules\n.next\n', 'dist/keep.js': '1'},
                              commitDate: '2026-08-01T00:00:00Z'});
  await writeTree(repo, {'node_modules/x/i.js': '1', '.next/cache/a': '1'});
  await setAllMtimes(repo, new Date('2026-08-01'));
  const rows = await collect(fakeCtx({now: Date.parse('2026-10-22')}), [repo]);
  assert.deepEqual(rows.map(r => [path.basename(r.path), r.tag]).sort(), [['.next', 'safe'], ['node_modules', 'safe']]);
});
test('recent project: node_modules ask with the age', async () => {
  const repo = await gitRepo({files: {'package.json': '{}', '.gitignore': 'node_modules\n'}, commitDate: '2026-10-20T00:00:00Z'});
  await writeTree(repo, {'node_modules/x/i.js': '1'});
  const [row] = await collect(fakeCtx({now: Date.parse('2026-10-22')}), [repo]);
  assert.equal(row.tag, 'ask'); assert.equal(row.reason.key, 'reason.nm_recent');
});
```

`gitRepo({files, commitDate})` and `setAllMtimes(dir, date)` are added to `tests/helpers.mjs` here (commit with `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, `user.name`/`user.email` set per repo).

- [ ] **Step 2: Run `npm test`; the projects tests fail.**
- [ ] **Step 3: Implement `collect`; add the two reason keys to `EN`.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat(disk-cleanup): node_modules and build output rows`.

### Task 5: Git collector: worktrees, orphans, loose logs, landed branches

**Files:**
- Create: `skills/disk-cleanup/scripts/lib/collect/git.mjs`
- Test: `tests/git.test.mjs`

**Interfaces:**
- Consumes: `newestMtime` (Task 2), `ctx.run`, `ctx.busy`, `ctx.now`.
- Produces: `classifyBranch(repo, branch, {prs, base, current}, ctx): Promise<{landed:boolean, keep:string|null}>` (exported for Task 9); `collect(ctx, repos): Promise<Row[]>` (group `projects`), handling only repos with linked worktrees or a non-empty `.claude/worktrees/` or `.worktrees/`. `base` = `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to `origin/main`, then `origin/master`; no remote → the repo is skipped. `prs` = one `gh pr list --state all --limit 500 --json number,state,headRefName` with `cwd: repo`, or `null` when `gh` fails.

Rules, ported from the current `skills/git-cleanup/SKILL.md` without `git fetch`:
- landed: PR `MERGED`; or `git merge-base --is-ancestor <b> <base>`; or `git cherry <base> <b>` has no `+` line.
- keep (first that applies, the reason key names it): default or current branch (`reason.git_current`); open PR (`reason.git_open_pr`); `git -C <wt> status --porcelain` not empty (`reason.git_dirty`); `locked` in porcelain (`reason.git_locked`); path under any `ctx.busy` dir or `newestMtime(wt) > ctx.now - 24h` (`reason.git_busy`); `git log <b> --not --remotes` not empty and not landed by cherry (`reason.git_local_commits`).
- With `prs === null`, a branch that is not an ancestor and not cherry-landed is `ask` (`reason.git_no_pr_data`), never `safe`.
- Worktree rows: `safe` when landed (`reason.git_landed`, params `{pr}` when known), `keep` per above, otherwise `ask` (`reason.git_unmerged`, for example a PR closed without merging). Detached HEAD: `safe` when clean and `git branch -r --contains <sha>` is not empty, else `keep`. Action `{type:'worktree', repo, path, branch}`.
- Orphan rows: folders in `.claude/worktrees/` and `.worktrees/` not known to `git worktree list`, compared by folder name; `safe`, `reason.git_orphan`, action `rm`. Loose files (`*.log`, `*.txt`) directly in those folders: one `safe` row per file, `reason.git_loose_log`, action rm.
- One extra row per repo when landed local branches without a worktree exist: tag `show`, `bytes: 0`, reason `reason.git_branch_count` (`{count} landed local branches without a worktree`), action `none`.

- [ ] **Step 1: Write the failing tests.** Fixture: `gitRepoWithOrigin()` in helpers creates a bare origin and a clone, `main` pushed, `origin/HEAD` set.

```js
test('landed worktree is safe, dirty one keep, local-only commits keep', async () => {
  const {repo} = await gitRepoWithOrigin();
  const landed = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const dirty = await addWorktree(repo, 'feat/dirty', {commit: true, mergeIntoMainAndPush: true, untracked: 'x.txt'});
  const local = await addWorktree(repo, 'feat/local', {commit: true});
  const rows = await collect(fakeCtx({now: Date.now() + 2 * 86400000, run: realRun}), [repo]);
  const tag = p => rows.find(r => r.path === p).tag;
  assert.equal(tag(landed), 'safe'); assert.equal(tag(dirty), 'keep'); assert.equal(tag(local), 'keep');
});
test('cherry-picked branch counts as landed', async () => { /* commit on feat/cp, cherry-pick onto main, push main; expect safe */ });
test('worktree under a busy dir or changed in the last 24 h is keep', async () => { /* ctx.busy = [wt]; and now = Date.now() */ });
test('without gh data an unmerged pushed branch is ask', async () => { /* run returns code null for gh */ });
test('orphan folder and a loose log are safe rows', async () => { /* mkdir .claude/worktrees/ghost, write a.log */ });
test('repo without worktrees yields no rows', async () => { /* plain clone */ });
```

`addWorktree(repo, branch, opts)` and `realRun` are helpers; each test that is a comment above is written out in full with the same assertion style.

- [ ] **Step 2: Run `npm test`; the git tests fail.**
- [ ] **Step 3: Implement `classifyBranch` and `collect`; add the reason keys to `EN`.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat(disk-cleanup): worktree, orphan and branch rows from the git-cleanup rules`.

### Task 6: Caches and test browsers

**Files:**
- Create: `skills/disk-cleanup/scripts/lib/collect/caches.mjs`, `skills/disk-cleanup/scripts/lib/collect/browsers.mjs`
- Test: `tests/caches.test.mjs`

**Interfaces:**
- Produces: `collect(ctx): Promise<Row[]>` in each module.
- caches (group `caches`, tag `safe`, one row per tool whose folder exists; a tool whose command fails is skipped):

| Tool | Folder | Action |
|---|---|---|
| npm | `npm config get cache` | cmd `npm cache clean --force` |
| pnpm | `pnpm store path` | cmd `pnpm store prune` (reason `reason.pnpm_prune`: frees only packages no project uses) |
| yarn | `yarn cache dir` | cmd `yarn cache clean` |
| bun | `$BUN_INSTALL/install/cache` or `~/.bun/install/cache` | rm |
| pip | `python3 -m pip cache dir`, on Windows `py -m pip cache dir` | cmd same launcher `-m pip cache purge` |

  On Windows the command runner calls `npm.cmd`, `pnpm.cmd`, `yarn.cmd`.
- browsers (group `browsers`): Playwright folder = `$PLAYWRIGHT_BROWSERS_PATH`, else Windows `%LOCALAPPDATA%\ms-playwright`, macOS `~/Library/Caches/ms-playwright`, Linux `~/.cache/ms-playwright`. Entries `<name>-<revision>`; per name the highest revision is `keep` (`reason.browser_newest`), the rest `safe` (`reason.browser_old`, `{newest}`), action rm. Puppeteer: `$PUPPETEER_CACHE_DIR` or `~/.cache/puppeteer`, entries `<browser>/<platform>-<version>`; same rule per browser, versions compared numerically by dot parts.

- [ ] **Step 1: Write the failing tests**

```js
test('Playwright: newest revision keep, older safe', async () => {
  const pw = await tmpdir(); await writeTree(pw, {'chromium-1100/x': '1', 'chromium-1129/x': '1', 'ffmpeg-1010/x': '1'});
  const rows = await browsers.collect(fakeCtx({env: {PLAYWRIGHT_BROWSERS_PATH: pw}}));
  assert.deepEqual(rows.map(r => [path.basename(r.path), r.tag]).sort(),
    [['chromium-1100', 'safe'], ['chromium-1129', 'keep'], ['ffmpeg-1010', 'keep']]);
});
test('npm cache row uses the npm command; missing pnpm is skipped', async () => {
  const cache = await tmpdir(); await writeTree(cache, {'_cacache/a': '1'});
  const run = async (cmd, args) => /^npm/.test(cmd) && args[0] === 'config' ? {code: 0, stdout: cache + '\n', stderr: ''} : {code: null, stdout: '', stderr: ''};
  const rows = await caches.collect(fakeCtx({run}));
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].action.args, ['cache', 'clean', '--force']);
});
```

- [ ] **Step 2: Run `npm test`; these fail.**
- [ ] **Step 3: Implement both collectors; add reason keys.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat(disk-cleanup): package caches and test browser rows`.

### Task 7: Agent temp folders and heavy tools

**Files:**
- Create: `skills/disk-cleanup/scripts/lib/collect/agents.mjs`, `skills/disk-cleanup/scripts/lib/collect/heavy.mjs`
- Test: `tests/agents-heavy.test.mjs`

**Interfaces:**
- agents (group `agents`): `AGENT_TEMP` table of `{agent, dir(ctx)}`. Claude Code: `path.join(ctx.tmp, 'claude')`, one row per child folder. Each row: `ask` with `reason.agent_busy` when under a `ctx.busy` dir or `newestMtime > now - 24h`, else `safe` with `reason.agent_old` (`{days}`); action rm. Cursor and Codex: before adding an entry, look up the official documentation or the installed app for a folder that holds only cache or temp data; add it with a comment citing the source, or leave the agent out if nothing is confirmed. History, memory, settings and plugin folders are never entries.
- heavy (group `heavy`, tag `show`, action `none`, `command` filled): Docker when `docker system df` exits 0 (bytes parsed from `docker system df --format "{{.Size}}"` summed, or `null`; command `docker system prune`); Xcode DerivedData `~/Library/Developer/Xcode/DerivedData` (command `rm -rf ~/Library/Developer/Xcode/DerivedData`), CoreSimulator `~/Library/Developer/CoreSimulator` (command `xcrun simctl delete unavailable`) on macOS; Android AVDs `~/.android/avd` (command: delete in Android Studio Device Manager) and SDK `$ANDROID_HOME`/`$ANDROID_SDK_ROOT` or the platform default; Gradle `~/.gradle/caches` (command `gradle --stop`, then delete the folder). Only rows whose folder exists.

- [ ] **Step 1: Write the failing tests**

```js
test('Claude temp: old session folder safe, fresh one ask', async () => {
  const tmp = await tmpdir(); await writeTree(tmp, {'claude/old/a.txt': '1', 'claude/new/a.txt': '1'});
  const old = new Date(Date.now() - 3 * 86400000); await setAllMtimes(path.join(tmp, 'claude/old'), old);
  const rows = await agents.collect(fakeCtx({tmp, now: Date.now()}));
  assert.deepEqual(rows.map(r => [path.basename(r.path), r.tag]).sort(), [['new', 'ask'], ['old', 'safe']]);
});
test('Gradle cache is show only with a command', async () => {
  const home = await tmpdir(); await writeTree(home, {'.gradle/caches/x': '1'});
  const [row] = (await heavy.collect(fakeCtx({home, platform: 'linux'}))).filter(r => r.path?.includes('.gradle'));
  assert.equal(row.tag, 'show'); assert.ok(row.command); assert.equal(row.action.type, 'none');
});
test('~/.claude/projects is never a row', async () => {
  const home = await tmpdir(); const tmp = await tmpdir(); await writeTree(home, {'.claude/projects/x/s.jsonl': '1'});
  const rows = [...await agents.collect(fakeCtx({home, tmp})), ...await heavy.collect(fakeCtx({home, tmp}))];
  assert.ok(rows.every(r => !r.path?.includes(path.join('.claude', 'projects'))));
});
```

- [ ] **Step 2: Run `npm test`; these fail.**
- [ ] **Step 3: Implement both collectors; add reason and command keys.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat(disk-cleanup): agent temp folders and heavy tool rows`.

### Task 8: Report: numbering, HTML page, chat summary, the `report` command

**Files:**
- Create: `skills/disk-cleanup/scripts/lib/report.mjs`
- Modify: `skills/disk-cleanup/scripts/scan.mjs` (add `report`)
- Test: `tests/report.test.mjs`

**Interfaces:**
- Consumes: every `collect` (Tasks 4–7), `measureSize`, `listDisks`, `defaultRoots`, `findRepos`, `loadStrings`, `t`.
- Produces: `buildReport(rows: Row[], disks, {now}): Report` where `Report = {version: 1, createdAt, disks, groups: {group, bytes, rows: Row[]}[]}`; groups sorted by total bytes descending (null counts as 0), rows by bytes descending, then ids assigned 1..n in display order; `renderHtml(report, strings): string`; `renderSummary(report, strings, {top: 5}): string` (one line per group with its total, then the five largest deletable rows with id, label, size, tag). Sizes use 1024-based units with one decimal, labelled `KB`, `MB`, `GB` (`formatBytes(8.4 * 1024 ** 3) === '8.4 GB'`).
- `scan.mjs report [--roots <dir>...] [--busy <dir>...] [--strings <file>]`: builds `ctx`, finds repos, runs collectors, measures sizes for rows with `bytes === null` and a path, with at most 4 measurements at a time and a 20 s deadline each, prints `progress: <group> <n>/<total>` lines to stderr, writes `report.json` and `report.html` into `os.tmpdir()/disk-cleanup/`, prints the summary and both paths to stdout. Exit 0.
- Page layout (option B): header with title, scan time and each disk's free/total; then per group a heading with total, a bar whose width is `group.bytes / largest.bytes`, and rows: `#id`, label, path in monospace, size or `size_unknown`, reason, tag badge; `show` rows also print `command`; the footer prints `answer_hint`. All text through `strings`; every interpolated value HTML-escaped.

- [ ] **Step 1: Write the failing tests**

```js
test('groups sorted by size and ids follow display order', () => {
  const r = buildReport([row('caches', 900), row('projects', 100), row('projects', 300)], [], {now: 0});
  assert.deepEqual(r.groups.map(g => g.group), ['caches', 'projects']);
  assert.deepEqual(r.groups.flatMap(g => g.rows.map(x => [x.id, x.bytes])), [[1, 900], [2, 300], [3, 100]]);
});
test('renderHtml escapes paths and uses translated strings', () => {
  const r = buildReport([row('projects', 10, {path: 'C:\\a <b> & "c"'})], [], {now: 0});
  const html = renderHtml(r, {...EN, 'group.projects': 'Проекты'});
  assert.ok(html.includes('C:\\a &lt;b&gt; &amp; &quot;c&quot;')); assert.ok(html.includes('Проекты'));
  assert.ok(!/https?:\/\//.test(html));
});
test('report command writes both files and prints their paths', async () => {
  const home = await tmpdir();
  const {stdout} = await execFileP(process.execPath, [SCAN, 'report', '--roots', home], {env: {...process.env, HOME: home, USERPROFILE: home}});
  assert.match(stdout, /report\.html/); assert.match(stdout, /report\.json/);
});
```

`row(group, bytes, extra)` is a test helper around `makeRow`.

- [ ] **Step 2: Run `npm test`; these fail.**
- [ ] **Step 3: Implement `report.mjs` and the `report` command.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat(disk-cleanup): grouped HTML report and chat summary`.

### Task 9: Deleting chosen rows, the `delete` command

**Files:**
- Create: `skills/disk-cleanup/scripts/lib/delete.mjs`
- Modify: `skills/disk-cleanup/scripts/scan.mjs` (add `delete`)
- Test: `tests/delete.test.mjs`

**Interfaces:**
- Consumes: `Report` (Task 8), `classifyBranch` (Task 5), `measureSize`, `listDisks`.
- Produces: `parseIds(text: string): number[]` (accepts `1, 3, 5-8`, spaces optional, duplicates removed, throws on anything else); `deleteRows(report, ids, ctx): Promise<{id, status:'deleted'|'skipped'|'failed', freed:number, message:string}[]>`.
- `scan.mjs delete <ids> [--busy <dir>...]` reads `os.tmpdir()/disk-cleanup/report.json`; missing file or `version !== 1` → exit 1 with a message to run `report` first; a report older than 24 hours → a warning line, rows still re-checked. Prints one line per id and then freed bytes per group and the new free space per disk.
- Per row, in this order: unknown id → skipped (`not in the report`); tag `keep` or `show` → skipped; `path` no longer exists → skipped; `rm` → re-check that the path is a real directory or file, not a symlink, (`lstat`), then `fs.rm(path, {recursive: true, force: false, maxRetries: 3})`; `cmd` → `ctx.run(cmd, args, {timeoutMs: 600000})`, failed on non-zero exit with the last stderr line; `worktree` → once per repo `git fetch --prune origin`, then `classifyBranch` again plus the dirty and busy checks; still landed and clean → `git worktree remove <path>`, on failure (long paths on Windows) `fs.rm` after one more clean check, then `git worktree prune` and `git branch -D <branch>` when a branch exists; otherwise skipped with the new reason. `freed` = bytes measured just before deletion.
- Remote branches are not deleted by this command.

- [ ] **Step 1: Write the failing tests**

```js
test('parseIds handles lists and ranges', () => {
  assert.deepEqual(parseIds('1, 3,5-7 3'), [1, 3, 5, 6, 7]);
  assert.throws(() => parseIds('1; rm -rf'));
});
test('keep, show and unknown rows are skipped, safe rm row deleted', async () => { /* report with three rows on fixture folders */ });
test('rm through a symlink is refused and the target survives', async () => { /* row.path is a symlink to a folder with a file */ });
test('worktree that got a new local commit after the report is skipped', async () => { /* gitRepoWithOrigin, landed worktree, commit after building the report */ });
test('folder name with spaces and non-Latin letters is deleted', async () => { /* path "проект с пробелом" */ });
test('delete without report.json exits 1 and deletes nothing', async () => { /* run CLI with TMPDIR/TEMP pointed at an empty dir */ });
```

Each commented test is written out in full with the same assertion style.

- [ ] **Step 2: Run `npm test`; these fail.**
- [ ] **Step 3: Implement `delete.mjs` and the `delete` command.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat(disk-cleanup): delete chosen rows with a re-check`.

### Task 10: Skill, docs, rename, real-machine check

**Files:**
- Create: `skills/disk-cleanup/SKILL.md`
- Delete: `skills/git-cleanup/`
- Modify: `README.md`
- Test: manual run on the owner's Windows machine; `npm test`

**Interfaces:**
- Consumes: the `strings`, `report` and `delete` commands.

- [ ] **Step 1: Write `SKILL.md`.** Frontmatter: `name: disk-cleanup`, `description: "Show what takes disk space on a developer machine and why (projects, node_modules, build outputs, agent worktrees and branches, package caches, test browsers, agent temp folders, Docker and mobile SDKs), then delete only the rows the user picks."`, `disable-model-invocation: true`. Body, in steps: (1) if the user's language is not English, run `node <skill>/scripts/scan.mjs strings`, translate the values keeping keys and `{placeholders}`, save to the temp dir, and pass `--strings`; (2) collect running agent session directories if the harness can list them and pass each with `--busy`; (3) run `report` in the background and relay progress if it runs long; (4) open `report.html` for the user (the harness's file or browser view, or print the path) and post the summary; (5) ask which rows to delete; (6) run `delete <ids>` with the same `--busy`; remote branches only on explicit request, through `git push origin --delete` after the same landed check; (7) relay the result lines. Rules: never delete anything the script did not list; never edit `report.json`.
- [ ] **Step 2: Rewrite `README.md`** for `disk-cleanup`: what it shows (the five groups), the tags, install with `npx skills add sarbash1994/disk-cleanup-skill`, requirements (Node 18.15+, git; gh optional), the scope line about agent worktree folders, a note that the old `git-cleanup` skill is replaced.
- [ ] **Step 3: Delete `skills/git-cleanup/`; run `npm test`; expect PASS.**
- [ ] **Step 4: Real-machine check.** On the owner's machine run `node skills/disk-cleanup/scripts/scan.mjs report` and record: wall time (target under 2 minutes), number of rows per group, any row with `size unknown`, and that `report.html` opens and reads correctly. Do not run `delete` here. If the time exceeds 2 minutes, report which group is slow before changing anything.
- [ ] **Step 5: Commit** `feat: replace git-cleanup with disk-cleanup`.
- [ ] **Step 6: Rename and push.** `gh repo rename disk-cleanup-skill -R sarbash1994/git-cleanup-skill --yes`, `git remote set-url origin https://github.com/sarbash1994/disk-cleanup-skill.git`, `git push`, then `npx skills add sarbash1994/disk-cleanup-skill -l` in an empty temp folder and expect `disk-cleanup` listed with its description.
