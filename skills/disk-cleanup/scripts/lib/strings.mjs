import fs from 'node:fs';

/** English table: the source of truth for all user-visible report text. */
export const EN = {
  'title': 'Disk cleanup report',
  'scanned_at': 'Scanned at {time}',
  'disk_free': '{free} free of {total}',
  'group.projects': 'Projects',
  'group.caches': 'Package caches',
  'group.browsers': 'Browser downloads',
  'group.agents': 'Agent temp folders',
  'group.heavy': 'Heavy tools',
  'tag.safe': 'safe',
  'tag.ask': 'ask',
  'tag.keep': 'keep',
  'tag.show': 'show only',
  'size_unknown': 'size unknown',
  'reason.nm_old': 'untouched for {days} days, reinstalls with the lockfile',
  'reason.nm_recent': 'project touched {days} days ago',
  'reason.build_ignored': 'build output, ignored by git, rebuilds',
  'reason.git_landed': 'work is already in the default branch',
  'reason.git_detached_pushed': 'detached worktree whose commit is on a remote',
  'reason.git_unmerged': 'work is not in the default branch, for example a PR closed without merging',
  'reason.git_no_pr_data': 'work is not in the default branch and there is no PR data (gh unavailable)',
  'reason.git_current': 'default or current branch',
  'reason.git_open_pr': 'PR #{pr} is open',
  'reason.git_dirty': 'uncommitted changes in the worktree',
  'reason.git_locked': 'worktree is locked',
  'reason.git_busy': 'in use: a session runs here or a file changed in the last 24 hours',
  'reason.git_local_commits': 'has commits that are on no remote',
  'reason.git_orphan': 'folder that git does not know as a worktree',
  'reason.git_orphan_repo': 'folder that git does not know as a worktree, but it holds a .git: it may have commits, stashes or changes',
  'reason.git_loose_log': 'loose log file in the agent worktree folder',
  'reason.git_branch_count': '{count} landed local branches without a worktree',
  'reason.cache_clean': 'package cache, downloads again when needed',
  'reason.pnpm_prune': 'frees only packages no project uses',
  'reason.agent_busy': 'a session may use it: changed in the last 24 hours or in use',
  'reason.agent_old': 'agent temp folder, untouched for {days} days',
  'reason.heavy_show': 'large tool data, shown for information; use the command',
  'reason.browser_newest': 'newest version, tests use it',
  'reason.browser_old': 'older version, the newest is {newest}',
  'answer_hint': 'Reply in chat with row numbers, for example 1, 3, 5-8',
  'delete.deleted': 'deleted',
  'delete.not_in_report': 'not in the report',
  'delete.not_deletable': 'tagged {tag}, never deleted',
  'delete.no_action': 'nothing to delete for this row',
  'delete.missing': 'the path no longer exists',
  'delete.link': 'the path is a link; links are never followed or deleted',
  'delete.not_file_or_dir': 'the path is neither a file nor a folder',
  'delete.changed': 'changed since the report: {reason}',
  'delete.not_worktree': 'no longer a git worktree',
  'delete.now_worktree': 'git now lists this folder as a worktree',
  'delete.branch_changed': 'the worktree now has another branch checked out',
  'delete.no_base': 'cannot check again: the repo has no origin default branch',
  'delete.git_failed': 'cannot check again: git failed in the repo',
  'delete.failed': 'failed: {error}',
  'delete.cmd_unavailable': 'the command is not installed or timed out',
  'delete.cmd_exit': 'the command exited with code {code}',
  'delete.branch_kept': 'deleted, but branch {branch} was kept: {error}',
  'delete.no_report': 'No report found at {file}. Run the report command first.',
  'delete.bad_report': 'The report at {file} has an unknown format. Run the report command again.',
  'delete.bad_ids': 'Row numbers not understood: {error}. Use a list like 1, 3, 5-8.',
  'delete.old_report': 'Warning: the report is older than 24 hours; every row is checked again before deletion.',
  'delete.freed': 'Freed per group:',
  'delete.disks': 'Free space now:',
};

const placeholders = (s) => s.match(/\{\w+\}/g) || [];

/**
 * EN merged with a translation file. A key is taken from the file only when
 * its value is a string that keeps every {placeholder} of the English value.
 * A missing or unreadable file yields plain EN.
 * @param {string} [file]
 */
export function loadStrings(file) {
  const out = {...EN};
  if (!file) return out;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object') return out;
  for (const key of Object.keys(EN)) {
    const v = data[key];
    if (typeof v !== 'string') continue;
    if (!placeholders(EN[key]).every((p) => v.includes(p))) continue;
    out[key] = v;
  }
  return out;
}

/**
 * Looks up `key` (falling back to English, then to the key itself) and fills {params}.
 * @param {Record<string,string>} strings
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(strings, key, params = {}) {
  const text = strings[key] ?? EN[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}
