---
description: "Fork-local guard that refuses shell commands editing files by hand, so the model uses the write/edit tools and keeps the filesystem version guard and read-before-edit policy"
kind: "package-reference"
---

# dsh-shell-edit-guard

English | [中文](README.zh.md)

## Summary

This fork-local plugin refuses shell commands that edit files by hand — `sed -i`, `perl -pi`, inline `python`/`node` scripts, heredocs, redirection, `tee`, `patch`, `dd of=`, `truncate`, and their PowerShell equivalents — and tells the model to use the `write`/`edit` tools instead. Those tools enforce the filesystem version guard and the read-before-edit policy; shell edits bypass both and leave no reviewable diff, so a drifted long context can corrupt a file with no protection at all.

It registers on `ctx.tools.guard`, which runs after the extensible `tools/pre-execute` waterfall: any guard may refuse a call, and no other plugin can force-allow one this guard refused. The guard refuses nothing while the agent has no `write`/`edit` tool to use, so a minimal composition keeps its shell.

`plugins/` packages are never published: this manifest is `private`, and the code is versioned here rather than in `packages/`, which the repository reserves for release members.

## Table of Contents

- [Use this plugin](#use-this-plugin)
- [Rules](#rules)
- [Configuration](#configuration)
- [Verification](#verification)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-plugin"></a>
## Use this plugin

A profile consumes a `plugins/` package the same way it consumes any external plugin: install it into the profile, then leave the row mounted.

```sh
cd /path/to/deepseek-harness
pnpm run build
pnpm dsh plugin --profile web add file:$PWD/plugins/dsh-shell-edit-guard
```

The install records the plugin in the profile's `package.json` and adds `dsh-shell-edit-guard` to `dsh.profile.bundles`, whose `cordis.patch.yml` inserts the row. Restart `dsh web` afterwards: plugin modules load once at boot, so a running host keeps the code it started with.

Without an install, the same row can be dropped beside a patch file (a relative `name` resolves against the patch file's own directory):

```yaml
- insert:
    - id: shell-edit-guard
      name: './index.js'
```

<a id="rules"></a>
## Rules

| rule | Matched idiom |
|---|---|
| `sed-in-place` | `sed -i`, `sed --in-place`, `gsed -i`, including `find … -exec sed -i` |
| `perl-in-place` | `perl -pi`, `perl -i` |
| `inline-interpreter` | `python -c` / `python <<EOF` / `node -e` / `ruby -e` / `php -r` that also names a write |
| `redirect` | `>` / `>>` into a non-temporary file, including a heredoc body |
| `tee` | `tee <file>`, `tee -a <file>` |
| `patch` | `patch -p1 < x.diff`, `git apply x.patch` |
| `dd` | `dd of=<file>` |
| `truncate` | `truncate -s …` |
| `powershell-write` | `Set-Content`, `Add-Content`, `Out-File`, `Clear-Content`, `Export-Csv`, `New-Item`, `[IO.File]::WriteAllText` |
| `extra` | A deployment's own `extraPatterns` |

Commands that write only to temporary paths (`/tmp/`, `$TMPDIR`, `mktemp`, `/dev/null`, `/dev/fd/*`, `/var/folders/`) stay allowed, as do read-only uses (`sed -n`, `perl -ne`, a `node -e` that only reads), project toolchains (`pnpm`/`npm`/`yarn`, builds, tests, formatters, `python3 scripts/gen.py`), and git workflows.

Detection reads the command text only. It never inspects the script file an interpreter runs, so a project's own formatter, code generator, or build command keeps working; only "the shell used as an editor" is refused.

<a id="configuration"></a>
## Configuration

Row fields, validated at load — a mistyped rule id or an invalid pattern fails the row loudly instead of guarding less than intended:

| Field | Default | Meaning |
|---|---|---|
| `tools` | `['bash', 'pwsh']` | Command tools to inspect |
| `disabledRules` | `[]` | Built-in rule ids to switch off; an unknown id fails at load |
| `allowPatterns` | `[]` | Regex sources that allow a matching simple command |
| `extraPatterns` | `[]` | Regex sources that refuse a matching simple command |
| `requireEditorTool` | `true` | Refuse only while `write` or `edit` is visible to that agent |

Both pattern lists are matched per simple command, so `allowPatterns: ['^git apply ']` cannot exempt a `sed -i` chained after a `git apply`.

<a id="verification"></a>
## Verification

```sh
pnpm exec vitest run plugins/dsh-shell-edit-guard
```

The suite covers every rule, the temporary-path exemptions, both pattern lists, the disabled-rule arms, configuration failures, guard disposal, and a Loader-booted `cordis.yml` composition. `pnpm run test:coverage` holds `plugins/*/src` to the same per-file 100% bar as `packages/*/*/src`.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **`tee` to a log file is refused.** The rule judges the write target, not the intent; `… | tee build.log` needs `disabledRules: ['tee']` or a `/tmp` path.
- **`patch` and `git apply` are refused by default** — they are file-writing patch application. Exempt them with `allowPatterns` when a workflow genuinely needs them.
- **The temporary-path exemption is a heuristic.** It classifies the paths a command names; a command mixing one temp path with one source file is judged by the source file.
- **Only command text is judged.** A shell command that delegates to another editor process the guard cannot see (`my-editor --write src/file.ts` where `my-editor` is a project script) passes.
