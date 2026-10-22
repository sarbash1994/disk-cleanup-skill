---
name: disk-cleanup
description: "Show what takes disk space on a developer machine and why (projects, node_modules, build outputs, agent worktrees and branches, package caches, test browsers, agent temp folders, Docker and mobile SDKs), then delete only the rows the user picks."
disable-model-invocation: true
---

`scripts/scan.mjs` is relative to this skill's folder: resolve it against the directory this file is in, not the working directory. Below, `scan` means `node <skill folder>/scripts/scan.mjs`.

## 1. Language

If the user writes in a language other than English: run `scan strings`, translate the values, keep the keys and `{placeholders}`, save the JSON in the temp dir and pass `--strings <file>` to `report`.

## 2. Busy sessions

If the harness can list running agent sessions, pass each session's working directory as `--busy <dir>`. Pass the same `--busy` list to `delete`.

## 3. Report

Run `scan report [--busy ...] [--strings ...]` in the background. Never pass `--roots` unless the user names a folder. Progress lines on stderr: relay them if the run takes long.

## 4. Show

Open the `report.html` path the script prints (the harness's file or browser view; otherwise give the path). Post the summary the script printed. Then ask which rows to delete; the user answers with numbers or ranges.

## 5. Delete

Run `scan delete <ids> [--busy ...]` with exactly the ids the user gave.

The script refuses and says why: `keep` and `show` rows, rows that changed since the report, links. Relay each refusal. Never delete by hand what the script skipped, and never retry it another way.

Remote branches only when the user asks for them by name: `git push origin --delete <branch>`, after the same landed check the report used.

## 6. Result

Relay the script's result lines: freed space per group and free space per disk.

## Rules

- Delete only rows the report lists.
- Never edit `report.json`.
- For `show` rows, give the user the row's own command; do not run it.
