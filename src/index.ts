/**
 * Refuse shell commands that edit files, so the agent uses the `write`/`edit`
 * tools instead of `sed -i`, `perl -pi`, inline `python`/`node` scripts,
 * heredocs, redirection, `tee`, `patch`, or their PowerShell equivalents. Those
 * edits bypass the filesystem version guard and the read-before-edit policy and
 * leave no reviewable diff, so a long context that drifts into the shell can
 * corrupt a file with no protection at all.
 *
 * The rule table lives in `./detection.ts`; this entry owns configuration and
 * the registry guard.
 *
 * @module @deepseek-ai/dsh-shell-edit-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { DETECTION_RULES, detectShellFileEdit } from './detection.ts'
import type { DetectionHit, DetectionOptions, DetectionRuleId } from './detection.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'shell-edit-guard'

/** The tool registry this plugin guards. */
export const inject = ['tools']

/** Command tools whose commands are inspected when the configuration names none. */
const DEFAULT_TOOLS = ['bash', 'pwsh']

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
}

/** Runtime configuration schema for the shell file-edit guard. */
export const Config: z<Config> = z.object({
  tools: z.array(z.string()).default(DEFAULT_TOOLS),
  disabledRules: z.array(z.string()).default([]),
  allowPatterns: z.array(z.string()).default([]),
  extraPatterns: z.array(z.string()).default([]),
  requireEditorTool: z.boolean().default(true),
})

/** Resolved configuration the guard closes over. */
interface ResolvedOptions {
  readonly tools: ReadonlySet<string>
  readonly requireEditorTool: boolean
  readonly detection: DetectionOptions
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
  return {
    tools: new Set(tools),
    requireEditorTool: config.requireEditorTool as boolean,
    detection: {
      disabledRules: new Set(disabledRules),
      allow: compilePatterns(config.allowPatterns as string[], 'allowPatterns'),
      extra: compilePatterns(config.extraPatterns as string[], 'extraPatterns'),
    },
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

/** The refusal the model sees, naming the rule and the tools it should use instead. */
function refusal(toolName: string, hit: DetectionHit): string {
  return `Refused by shell-edit-guard: ${toolName} must not edit files (rule: ${hit.rule}; matched: ${hit.evidence}). `
    + 'Use the edit tool for targeted changes or write for a whole file: those enforce the version guard and the '
    + 'read-before-edit policy and produce a reviewable diff. Running the project\'s own formatter, code generator, '
    + 'or build command is still expected.'
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

/**
 * Register the guard. `ctx.tools.guard` runs after the extensible
 * `tools/pre-execute` waterfall, so the refusal is monotonic: no other plugin
 * can force-allow a command this guard refused.
 *
 * @param ctx - the Cordis context the row was mounted on.
 * @param config - the parsed row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const options = resolveOptions(config)
  ctx.tools.guard(exec => guardCall(ctx, exec, options))
}
