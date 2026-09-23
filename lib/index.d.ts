/**
 * Refuse shell commands that edit files, so the agent uses the `write`/`edit`
 * tools instead of `sed -i`, `perl -pi`, inline `python`/`node` scripts,
 * heredocs, redirection, `tee`, `patch`, or their PowerShell equivalents. Those
 * edits bypass the filesystem version guard and the read-before-edit policy and
 * leave no reviewable diff, so a long context that drifts into the shell can
 * corrupt a file with no protection at all.
 *
 * Two layers decide. `./detection.ts` reads the command the way a shell does —
 * quoted text is data, not syntax — and settles the clear cases for free. Where
 * shell syntax alone cannot tell a query from an edit, `./judge.ts` asks the
 * mounted `jev_decide` tool (`dsh-jev-decide`) for a calibrated Noul verdict,
 * which can also rescue a command the rules flagged. The final refusal is this
 * plugin's monotonic `ctx.tools.guard`; the judge runs on the extensible
 * `tools/pre-execute` waterfall, the only place an asynchronous decision can
 * live, and hands its verdict to that guard.
 *
 * The judge tool is optional: without it — or when it fails, times out, or
 * answers outside the configured band — the rule verdict stands.
 *
 * @module @deepseek-ai/dsh-shell-edit-guard
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { DetectionOptions } from './detection.ts';
import { VerdictCache } from './judge.ts';
import type { JudgeOptions } from './judge.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "shell-edit-guard";
/** The tool registry this plugin guards, and the waterfall its judge runs on. */
export declare const inject: string[];
/** Jev judge settings. */
export interface JudgeConfig {
    /** Consult the judge (default true); without the judge tool mounted the rules stand alone. */
    enabled?: boolean;
    /** Tool that answers with a calibrated probability (default `jev_decide`). */
    tool?: string;
    /** The yes/no question asked about each flagged command. */
    question?: string;
    /** Model id passed through to the judge tool; empty uses that tool's own default. */
    model?: string;
    /** Probability at or above which the command counts as an edit (default 0.8). */
    denyAt?: number;
    /** Probability at or below which the command counts as read-only (default 0.2). */
    allowAt?: number;
    /** Bound on one judge call, in milliseconds (default 2000). */
    timeoutMs?: number;
    /** Distinct commands whose verdict stays cached (default 200). */
    cacheSize?: number;
    /** Judge commands the rules flag, or every command (default `flagged`). */
    mode?: 'flagged' | 'always';
    /** Decision when the judge is unreachable: keep the rule verdict, or allow (default `rules`). */
    onError?: 'rules' | 'allow';
    /** Decision in the band between the two thresholds (default `rules`). */
    onUnsure?: 'rules' | 'allow' | 'deny';
}
/** Configuration for the shell file-edit guard. */
export interface Config {
    /** Command tools to inspect (default `['bash', 'pwsh']`). */
    tools?: string[];
    /** Built-in rule ids to switch off, e.g. `['tee']`; an unknown id fails at load. */
    disabledRules?: string[];
    /** Regex sources that allow a matching simple command before any rule runs. */
    allowPatterns?: string[];
    /** Regex sources that refuse a matching simple command. */
    extraPatterns?: string[];
    /** Require a visible `write`/`edit` tool before refusing (default true). */
    requireEditorTool?: boolean;
    /** Judge settings; see {@link JudgeConfig}. */
    judge?: JudgeConfig;
}
/** Runtime configuration schema for the shell file-edit guard. */
export declare const Config: z<Config>;
/** Resolved configuration the guard and the judge close over. */
interface ResolvedOptions {
    readonly tools: ReadonlySet<string>;
    readonly requireEditorTool: boolean;
    readonly detection: DetectionOptions;
    readonly judge: JudgeOptions | undefined;
    readonly judgeMode: 'flagged' | 'always';
    readonly onError: 'rules' | 'allow';
    readonly onUnsure: 'rules' | 'allow' | 'deny';
    readonly cache: VerdictCache;
}
/**
 * Validate the row configuration, failing loud on a typo rather than guarding
 * less than the deployment asked for. The schema already rejects a
 * non-string-array value; this checks the values the schema cannot know about.
 *
 * @param config - the parsed `config:` object for this row.
 * @returns the compiled options the guard closes over.
 */
export declare function resolveOptions(config: Config): ResolvedOptions;
/**
 * Register the guard, and the judge that can narrow it.
 *
 * `ctx.tools.guard` runs after the extensible `tools/pre-execute` waterfall, so
 * a refusal is monotonic: no other plugin can force-allow a command this guard
 * refused. That guard is synchronous, so the judge — which awaits the judge
 * tool — runs on the waterfall and records its verdict per call: a `read-only`
 * verdict clears the call before the guard sees it, and every other outcome
 * leaves the rule verdict in place.
 *
 * @param ctx - the Cordis context the row was mounted on.
 * @param config - the parsed row configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
export {};
