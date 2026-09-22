---
description: "Fork-local guard that refuses shell commands editing files by hand: shell-aware rules plus a Jev (System One) verdict, so the model uses the write/edit tools and keeps the filesystem version guard and read-before-edit policy"
kind: "package-reference"
---

# dsh-shell-edit-guard

English | [中文](README.zh.md)

## Summary

This fork-local plugin refuses shell commands that edit files by hand — `sed -i`, `perl -pi`, inline `python`/`node` scripts, heredocs, redirection, `tee`, `patch`, a shell running one of those through `-c`, and their PowerShell equivalents — and tells the model to use the `write`/`edit` tools instead. Those tools enforce the filesystem version guard and the read-before-edit policy; shell edits bypass both and leave no reviewable diff, so a drifted long context can corrupt a file with no protection at all.

Two layers decide. The rules read the command the way a shell does — quoted text is data, not syntax, so a `>` compared inside a SQL string is not a redirect — and settle the clear cases for free. Where shell syntax alone cannot tell a query from an edit, the plugin asks the mounted [`dsh-jev-decide`](https://github.com/deepseek-ai/deepseek-harness/discussions/7315) tool for a calibrated Noul probability and thresholds it. The judge is optional: without it, or when it fails, times out, or answers inside the configured band, the rule verdict stands.

The refusal comes from `ctx.tools.guard`, which runs after the extensible `tools/pre-execute` waterfall: any guard may refuse a call, and no other plugin can force-allow one this guard refused. Nothing is refused while the agent has no `write`/`edit` tool to use, so a minimal composition keeps its shell.

`plugins/` packages are never published: this manifest is `private`, and the code is versioned here rather than in `packages/`, which the repository reserves for release members.

## Table of Contents

- [Use this plugin](#use-this-plugin)
- [Rules](#rules)
- [The judge](#the-judge)
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
pnpm dsh plugin --profile web add link:$PWD/plugins/dsh-shell-edit-guard
```

Use `link:`, not `file:`: `file:` copies the package into the profile's `node_modules`, so a later `pnpm run build` never reaches the profile, while `link:` keeps resolving this directory. With a link, a code change needs only a rebuild and a restart.

The install records the plugin in the profile's `package.json` and adds `dsh-shell-edit-guard` to `dsh.profile.bundles`, whose `cordis.patch.yml` inserts the row. Restart `dsh web` afterwards: plugin modules load once at boot, so a running host keeps the code it started with.

To give the guard its judge, install and mount the judge tool too:

```sh
pnpm dsh plugin --profile web add dsh-jev-decide
```

`dsh-jev-decide` publishes no bundle, so it needs one row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-jev-decide
      name: dsh-jev-decide
```

<a id="rules"></a>
## Rules

| rule | Matched idiom |
|---|---|
| `sed-in-place` | `sed -i`, `sed --in-place`, `gsed -i`, including `find … -exec sed -i` |
| `perl-in-place` | `perl -pi`, `perl -i` |
| `inline-interpreter` | `python -c` / `python <<EOF` / `node -e` / `ruby -e` / `php -r` that also names a write |
| `shell-inline` | `sh -c "…"` / `bash -c "…"` whose payload is one of these idioms |
| `redirect` | `>` / `>>` into a non-temporary file, read the way a shell reads it (a quoted target counts; a `>` inside quotes does not; `2>` / `2>>` names stderr, which captures output instead of writing text the model chose) |
| `tee` | `tee <file>`, `tee -a <file>` |
| `patch` | `patch -p1 < x.diff`, `git apply x.patch` |
| `dd` | `dd of=<file>` |
| `truncate` | `truncate -s …` |
| `powershell-write` | `Set-Content`, `Add-Content`, `Out-File`, `Clear-Content`, `Export-Csv`, `New-Item`, `[IO.File]::WriteAllText` |
| `extra` | A deployment's own `extraPatterns` |

Commands that write only to temporary paths (`/tmp/`, `$TMPDIR`, `mktemp`, `/dev/null`, `/dev/fd/*`, `/var/folders/`, or a repository-local scratch or output directory such as `tmp/`, `.tmp/`, or `logs/`) stay allowed, as does capturing a command's stderr anywhere (`… 2>logs/run.log`), as do read-only uses (`sed -n`, `perl -ne`, a `node -e` that only reads), project toolchains (`pnpm`/`npm`/`yarn`, builds, tests, formatters, `python3 scripts/gen.py`), git workflows, and queries that print rows — a `psql -c "SELECT … WHERE dt >= '20260901'"` compares inside a quoted string, which no shell reads as a redirect.

<a id="the-judge"></a>
## The judge

When a command trips a rule, the guard asks one Noul question through the `jev_decide` tool — is this a hand file edit, or only reading and reporting? The judge tool owns the TypeSafe endpoint, the credential, the retry policy, and the error mapping; this plugin owns the question, the thresholds, and the fallback.

| probability | verdict | what happens |
|---|---|---|
| ≥ `denyAt` (0.8) | `edit` | refused, with the model name and probability in the reason |
| ≤ `allowAt` (0.2) | `read-only` | allowed, overriding the rule that flagged it |
| in between | `unsure` | `onUnsure`, default: keep the rule verdict; a deployment that would rather let a false positive through sets `allow`, which also passes stdout captures the rules cannot tell from an edit |

The judge runs on `tools/pre-execute`, the only place an asynchronous decision can live, and hands its verdict to the synchronous `ctx.tools.guard` per call. A verdict is cached per command text, so a repeated command costs one call. The judge tool itself is never inspected, so the guard cannot recurse into its own judge.

Credential: `TYPESAFE_API_KEY` in the environment, or `~/.dsh/.credentials.yaml` under `refs.TYPESAFE_AI_API_KEY` — both read by `dsh-jev-decide`, not by this plugin. Without one, the judge is unavailable and the rules stand alone.

<a id="configuration"></a>
## Configuration

Row fields, validated at load — a mistyped rule id, an invalid pattern, an inverted threshold pair, or an empty question fails the row loudly instead of guarding less than intended:

| Field | Default | Meaning |
|---|---|---|
| `tools` | `['bash', 'pwsh']` | Command tools to inspect |
| `disabledRules` | `[]` | Built-in rule ids to switch off; an unknown id fails at load |
| `allowPatterns` | `[]` | Regex sources that allow a matching simple command |
| `extraPatterns` | `[]` | Regex sources that refuse a matching simple command |
| `requireEditorTool` | `true` | Refuse only while `write` or `edit` is visible to that agent |
| `judge.enabled` | `true` | Consult the judge tool |
| `judge.tool` | `jev_decide` | Tool that answers with a calibrated probability |
| `judge.question` | the policy question above | The yes/no question asked about each flagged command |
| `judge.model` | the tool's own default | Model id passed through to the judge tool |
| `judge.denyAt` / `judge.allowAt` | `0.8` / `0.2` | Edit and read-only thresholds |
| `judge.timeoutMs` | `2000` | Bound on one judge call |
| `judge.cacheSize` | `200` | Distinct commands whose verdict stays cached |
| `judge.mode` | `flagged` | Judge commands the rules flag, or every command (`always`) |
| `judge.onError` | `rules` | Judge unreachable: keep the rule verdict, or `allow` |
| `judge.onUnsure` | `rules` | Inside the band: `rules`, `allow`, or `deny` |

Both pattern lists are matched per simple command, so `allowPatterns: ['^git apply ']` cannot exempt a `sed -i` chained after a `git apply`.

<a id="verification"></a>
## Verification

```sh
pnpm exec vitest run plugins/dsh-shell-edit-guard
```

The suite covers every rule, the shell-syntax readers (quoted spans, redirect targets, assignments), the temporary-path exemptions, both pattern lists, the disabled-rule arms, the judge thresholds and cache, the judge wiring against a registered `jev_decide` fixture (rescue, refusal, failure, timeout, band, cache, `always` mode, recursion), configuration failures, guard disposal, and a Loader-booted `cordis.yml` composition. `pnpm run test:coverage` holds `plugins/*/src` to the same per-file 100% bar as `packages/*/*/src`.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **`tee` to a log file is refused.** The rule judges the write target, not the intent; `… | tee build.log` needs `disabledRules: ['tee']` or a `/tmp` path.
- **`patch` and `git apply` are refused by default** — they are file-writing patch application. Exempt them with `allowPatterns` when a workflow genuinely needs them.
- **The temporary-path exemption is a heuristic.** It classifies the paths a command names; a command mixing one temp path with one source file is judged by the source file.
- **Only command text is judged.** A command that delegates to an editor the guard cannot see (`my-editor --write src/file.ts`, where `my-editor` is a project script) passes unless `judge.mode: always` catches it through the judge.
- **The judge adds one call per flagged command**, with its own latency on the critical path; the rule verdict covers the clear cases and stands whenever the judge is unavailable.
