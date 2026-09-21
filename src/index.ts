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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { DETECTION_RULES, detectShellFileEdit } from './detection.ts'
import type { DetectionHit, DetectionOptions, DetectionRuleId } from './detection.ts'
import { VerdictCache, judgeArguments, modelFrom, probabilityFrom, verdictFor } from './judge.ts'
import type { JudgeOptions, JudgeOutcome } from './judge.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'shell-edit-guard'

/** The tool registry this plugin guards, and the waterfall its judge runs on. */
export const inject = ['tools']

/** Command tools whose commands are inspected when the configuration names none. */
const DEFAULT_TOOLS = ['bash', 'pwsh']

/** The one judgment the judge is asked for, in the terms the rules already encode. */
const DEFAULT_JUDGE_QUESTION = 'Does running this shell command modify files on disk by hand — the way a shell editor '
  + 'does with sed -i, perl -pi, an inline python/node script that writes a file, a heredoc or > redirect into a file, '
  + 'tee into a file, patch, dd of=, truncate, or a PowerShell writer such as Set-Content — rather than only reading or '
  + 'reporting data, such as a SQL query that prints rows, grep/cat/ls, a build, test, lint, formatter, or code '
  + 'generator command, a git workflow, or output redirected to /dev/null or a path under /tmp?'

/** Defaults shared by the schema and the resolved judge options. */
const JUDGE_DEFAULTS = {
  enabled: true,
  tool: 'jev_decide',
  question: DEFAULT_JUDGE_QUESTION,
  denyAt: 0.8,
  allowAt: 0.2,
  timeoutMs: 2000,
  cacheSize: 200,
  mode: 'flagged',
  onError: 'rules',
  onUnsure: 'rules',
} as const

/** Jev judge settings. */
export interface JudgeConfig {
  /** Consult the judge (default true); without the judge tool mounted the rules stand alone. */
  enabled?: boolean
  /** Tool that answers with a calibrated probability (default `jev_decide`). */
  tool?: string
  /** The yes/no question asked about each flagged command. */
  question?: string
  /** Model id passed through to the judge tool; empty uses that tool's own default. */
  model?: string
  /** Probability at or above which the command counts as an edit (default 0.8). */
  denyAt?: number
  /** Probability at or below which the command counts as read-only (default 0.2). */
  allowAt?: number
  /** Bound on one judge call, in milliseconds (default 2000). */
  timeoutMs?: number
  /** Distinct commands whose verdict stays cached (default 200). */
  cacheSize?: number
  /** Judge commands the rules flag, or every command (default `flagged`). */
  mode?: 'flagged' | 'always'
  /** Decision when the judge is unreachable: keep the rule verdict, or allow (default `rules`). */
  onError?: 'rules' | 'allow'
  /** Decision in the band between the two thresholds (default `rules`). */
  onUnsure?: 'rules' | 'allow' | 'deny'
}

/** Configuration for the shell file-edit guard. */
export interface Config {
  /** Command tools to inspect (default `['bash', 'pwsh']`). */
  tools?: string[]
  /** Built-in rule ids to switch off, e.g. `['tee']`; an unknown id fails at load. */
  disabledRules?: string[]
  /** Regex sources that allow a matching simple command before any rule runs. */
  allowPatterns?: string[]
  /** Regex sources that refuse a matching simple command. */
  extraPatterns?: string[]
  /** Require a visible `write`/`edit` tool before refusing (default true). */
  requireEditorTool?: boolean
  /** Judge settings; see {@link JudgeConfig}. */
  judge?: JudgeConfig
}

/** Runtime configuration schema for the shell file-edit guard. */
export const Config: z<Config> = z.object({
  tools: z.array(z.string()).default(DEFAULT_TOOLS),
  disabledRules: z.array(z.string()).default([]),
  allowPatterns: z.array(z.string()).default([]),
  extraPatterns: z.array(z.string()).default([]),
  requireEditorTool: z.boolean().default(true),
  judge: z.object({
    enabled: z.boolean().default(JUDGE_DEFAULTS.enabled),
    tool: z.string().default(JUDGE_DEFAULTS.tool),
    question: z.string().default(JUDGE_DEFAULTS.question),
    model: z.string().default(''),
    denyAt: z.number().default(JUDGE_DEFAULTS.denyAt),
    allowAt: z.number().default(JUDGE_DEFAULTS.allowAt),
    timeoutMs: z.number().default(JUDGE_DEFAULTS.timeoutMs),
    cacheSize: z.number().default(JUDGE_DEFAULTS.cacheSize),
    mode: z.union(['flagged', 'always'] as const).default(JUDGE_DEFAULTS.mode),
    onError: z.union(['rules', 'allow'] as const).default(JUDGE_DEFAULTS.onError),
    onUnsure: z.union(['rules', 'allow', 'deny'] as const).default(JUDGE_DEFAULTS.onUnsure),
  }),
})

/** Resolved configuration the guard and the judge close over. */
interface ResolvedOptions {
  readonly tools: ReadonlySet<string>
  readonly requireEditorTool: boolean
  readonly detection: DetectionOptions
  readonly judge: JudgeOptions | undefined
  readonly judgeMode: 'flagged' | 'always'
  readonly onError: 'rules' | 'allow'
  readonly onUnsure: 'rules' | 'allow' | 'deny'
  readonly cache: VerdictCache
}

/** Compile one configured pattern list, naming the offending entry on failure. */
function compilePatterns(sources: readonly string[], field: string): RegExp[] {
  return sources.map((source) => {
    try {
      return new RegExp(source)
    } catch (error: unknown) {
      throw new TypeError(`shell-edit-guard: "${field}" entry ${JSON.stringify(source)} is not a valid regex: ${String(error)}`)
    }
  })
}

/**
 * Validate the row configuration, failing loud on a typo rather than guarding
 * less than the deployment asked for. The schema already rejects a
 * non-string-array value; this checks the values the schema cannot know about.
 *
 * @param config - the parsed `config:` object for this row.
 * @returns the compiled options the guard closes over.
 */
export function resolveOptions(config: Config): ResolvedOptions {
  // Schemastery filled every field from the schema defaults before `apply` ran;
  // these casts record that runtime fact for the optional interface.
  const tools = config.tools as string[]
  const disabledRules = config.disabledRules as DetectionRuleId[]
  const known = new Set<string>(DETECTION_RULES)
  for (const rule of disabledRules) {
    if (!known.has(rule)) {
      throw new TypeError(`shell-edit-guard: unknown rule ${JSON.stringify(rule)}; known rules: ${DETECTION_RULES.join(', ')}`)
    }
  }
  const judgeConfig = config.judge as Required<JudgeConfig>
  if (judgeConfig.enabled) {
    if (judgeConfig.question.trim() === '') {
      throw new TypeError('shell-edit-guard: judge.question must not be empty')
    }
    if (!(judgeConfig.allowAt >= 0 && judgeConfig.denyAt <= 1 && judgeConfig.allowAt < judgeConfig.denyAt)) {
      throw new TypeError('shell-edit-guard: judge thresholds must satisfy 0 <= allowAt < denyAt <= 1')
    }
    if (judgeConfig.timeoutMs <= 0 || !Number.isSafeInteger(judgeConfig.timeoutMs)) {
      throw new TypeError('shell-edit-guard: judge.timeoutMs must be a positive integer')
    }
  }
  return {
    // The judge tool is never inspected: its own call carries the command under
    // judgment, and guarding it would recurse into the judge.
    tools: new Set(tools.filter(name => !judgeConfig.enabled || name !== judgeConfig.tool)),
    requireEditorTool: config.requireEditorTool as boolean,
    detection: {
      disabledRules: new Set(disabledRules),
      allow: compilePatterns(config.allowPatterns as string[], 'allowPatterns'),
      extra: compilePatterns(config.extraPatterns as string[], 'extraPatterns'),
    },
    judgeMode: judgeConfig.mode,
    onError: judgeConfig.onError,
    onUnsure: judgeConfig.onUnsure,
    cache: new VerdictCache(judgeConfig.cacheSize),
    judge: judgeConfig.enabled
      ? {
          tool: judgeConfig.tool,
          question: judgeConfig.question,
          model: judgeConfig.model === '' ? undefined : judgeConfig.model,
          denyAt: judgeConfig.denyAt,
          allowAt: judgeConfig.allowAt,
          timeoutMs: judgeConfig.timeoutMs,
          cacheSize: judgeConfig.cacheSize,
        }
      : undefined,
  }
}

/** The command string of a shell-shaped call, or undefined for any other argument object. */
function commandOf(exec: Readonly<ToolExecution>): unknown {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  return (args as { command?: unknown }).command
}

/** Whether this call's agent can reach a filesystem tool that owns the version guard. */
function editorToolVisible(ctx: Context, exec: Readonly<ToolExecution>): boolean {
  return ctx.tools.get('edit', exec.agent) !== undefined || ctx.tools.get('write', exec.agent) !== undefined
}

/** The refusal a rule produced. */
function refusal(toolName: string, hit: DetectionHit): string {
  return `Refused by shell-edit-guard: ${toolName} must not edit files (rule: ${hit.rule}; matched: ${hit.evidence}). ${REMEDY}`
}

/** The refusal the judge produced, naming the model and its probability. */
function judgeRefusal(toolName: string, command: string, outcome: JudgeOutcome): string {
  const collapsed = command.replace(/\s+/g, ' ').trim()
  const evidence = collapsed.length <= 160 ? collapsed : `${collapsed.slice(0, 160)}…`
  return `Refused by shell-edit-guard: ${toolName} looks like a hand file edit (${outcome.model} p=${outcome.probability.toFixed(2)}; matched: ${evidence}). ${REMEDY}`
}

/** What every refusal tells the model to do instead. */
const REMEDY = 'Use the edit tool for targeted changes or write for a whole file: those enforce the version guard and the '
  + 'read-before-edit policy and produce a reviewable diff. Running the project\'s own formatter, code generator, '
  + 'or build command is still expected.'

/** Nested call id for one judge call; the brand is compile-time only, so a derived string is the whole value. */
function judgeCallId(exec: Readonly<ToolExecution>, sequence: number): ToolCallId {
  return `${exec.callId}:judge:${String(sequence)}` as unknown as ToolCallId
}

/**
 * Ask the judge tool about one command. Every failure — no judge tool mounted
 * for this agent, a tool error, a timeout, or a value that is not a Noul answer
 * — resolves to undefined, which leaves the decision to the rules.
 *
 * @param ctx - the Cordis context the row was mounted on.
 * @param exec - the call being judged.
 * @param command - the command text.
 * @param options - resolved configuration, including the verdict cache.
 * @param sequence - per-plugin counter that keeps nested call ids distinct.
 * @returns the verdict with its probability, or undefined when unavailable.
 */
async function askJudge(
  ctx: Context,
  exec: Readonly<ToolExecution>,
  command: string,
  options: ResolvedOptions,
  sequence: number,
): Promise<JudgeOutcome | undefined> {
  const judge = options.judge as JudgeOptions
  const cached = options.cache.get(command)
  if (cached !== undefined) return cached
  if (ctx.tools.get(judge.tool, exec.agent) === undefined) return undefined
  const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(judge.timeoutMs)])
  // `exactOptionalPropertyTypes` rejects an explicit undefined for `agent`; the
  // registry reads a present-but-undefined agent exactly like an absent one.
  const input = {
    callId: judgeCallId(exec, sequence),
    name: judge.tool,
    arguments: judgeArguments(command, judge),
    agent: exec.agent,
    signal,
  } as ToolExecutionInput
  let result: ToolExecutionResult
  try {
    result = await ctx.tools.execute(input)
  } catch {
    /* v8 ignore next -- the registry normalizes tool failures into error results; only an internal invariant violation reaches here */
    return undefined
  }
  if (result.isError === true) return undefined
  const probability = probabilityFrom(result.value)
  if (probability === undefined) return undefined
  const outcome: JudgeOutcome = {
    verdict: verdictFor(probability, judge),
    probability,
    model: modelFrom(result.value, judge.model ?? judge.tool),
  }
  options.cache.set(command, outcome)
  return outcome
}

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
export function apply(ctx: Context, config: Config): void {
  const options = resolveOptions(config)
  const judge = options.judge
  /** Call ids the judge cleared; `tools/result` drops any the guard never saw. */
  const cleared = new Set<string>()
  let sequence = 0
  ctx.on('tools/result', (exec) => {
    cleared.delete(exec.callId)
  })
  if (judge !== undefined) {
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (!options.tools.has(exec.name)) return next()
      if (options.requireEditorTool && !editorToolVisible(ctx, exec)) return next()
      const command = commandOf(exec)
      if (typeof command !== 'string' || command.trim() === '') return next()
      const hit = detectShellFileEdit(command, options.detection)
      if (options.judgeMode === 'flagged' && hit === undefined) return next()
      sequence += 1
      const outcome = await askJudge(ctx, exec, command, options, sequence)
      if (outcome === undefined) {
        if (options.onError === 'allow') cleared.add(exec.callId)
        return next()
      }
      if (outcome.verdict === 'read-only') {
        cleared.add(exec.callId)
        return next()
      }
      if (outcome.verdict === 'edit') return { kind: 'deny', reason: judgeRefusal(exec.name, command, outcome) }
      if (options.onUnsure === 'allow') {
        cleared.add(exec.callId)
        return next()
      }
      if (options.onUnsure === 'deny') return { kind: 'deny', reason: judgeRefusal(exec.name, command, outcome) }
      return next()
    })
  }
  ctx.tools.guard((exec) => (cleared.delete(exec.callId) ? undefined : guardCall(ctx, exec, options)))
}

/** This plugin's monotonic guard: a reason string refuses the call, undefined delegates. */
function guardCall(
  ctx: Context,
  exec: Readonly<ToolExecution>,
  options: ResolvedOptions,
): string | undefined {
  if (!options.tools.has(exec.name)) return undefined
  if (options.requireEditorTool && !editorToolVisible(ctx, exec)) return undefined
  const hit = detectShellFileEdit(commandOf(exec), options.detection)
  return hit === undefined ? undefined : refusal(exec.name, hit)
}
