/**
 * Pure command analysis for `dsh-shell-edit-guard`: decide whether one shell
 * command edits files by hand. No Cordis types reach this module, so the rule
 * table is unit-testable without a registry and the plugin entry owns only
 * wiring and configuration.
 *
 * @module @deepseek-ai/dsh-shell-edit-guard/detection
 */

/** Built-in rule ids, each naming one editing idiom the guard refuses. */
export const DETECTION_RULES = [
  'sed-in-place',
  'perl-in-place',
  'inline-interpreter',
  'redirect',
  'tee',
  'patch',
  'dd',
  'truncate',
  'powershell-write',
] as const

/** One built-in rule a deployment may switch off. */
export type DetectionRuleId = (typeof DETECTION_RULES)[number]

/** Every rule id a refusal can name: the built-ins plus a deployment's own pattern. */
export type RuleId = DetectionRuleId | 'extra'

/** Compiled configuration the detection functions read. */
export interface DetectionOptions {
  /** Built-in rules this deployment switched off. */
  readonly disabledRules: ReadonlySet<DetectionRuleId>
  /** Patterns that allow a matching simple command before any rule runs. */
  readonly allow: readonly RegExp[]
  /** Deployment patterns that refuse a matching simple command. */
  readonly extra: readonly RegExp[]
}

/** The rule that matched a command, with the text quoted back to the model. */
export interface DetectionHit {
  /** Matched rule id. */
  readonly rule: RuleId
  /** Whitespace-collapsed, length-capped excerpt of the offending simple command. */
  readonly evidence: string
}

/** Paths and shell expansions whose writes the guard never refuses. */
const TEMP_MARKERS = [
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/',
  '/tmp/',
  '/private/tmp/',
  '/var/tmp/',
  '/var/folders/',
  '$TMPDIR',
  '${TMPDIR}',
  '$(mktemp',
  '`mktemp',
]

/** Option forms that turn an editor into an in-place rewriter. */
const IN_PLACE_FLAG = /^(?:--in-place(?:=.*)?|-[A-Za-z.]*i[A-Za-z.]*(?:\.[^\s]*)?)$/

/** Inline-code flags that make an interpreter's payload part of the command. */
const INLINE_FLAGS = new Set(['-c', '-e', '--eval', '-'])

/** Interpreters that can execute model-authored code inside one shell command. */
const INLINE_INTERPRETERS = ['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'php']

/** A heredoc whose body reaches the interpreter that reads it. */
const HEREDOC = /<<-?\s*['"]?[A-Za-z_]/

/** Writes reachable from inline code; a read-only one-liner stays allowed. */
const INLINE_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|write_bytes|writelines|open\s*\([^)]*,\s*['"][wax]|\.write\s*\(|IO\.write|File\.write|shutil\.copy|os\.replace|os\.rename)\b/

/** PowerShell cmdlets and .NET calls that write file content. */
const POWERSHELL_WRITE = /(?:^|[\s;&|(])(?:set-content|add-content|out-file|clear-content|export-csv|new-item)\b|\[(?:system\.)?io\.file\]::writealltext/i

/** A redirect whose target is a real file, capturing the target verbatim. */
const REDIRECT = /(?:^|[^0-9&])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|()<>]+))/g

/** `dd of=<file>` writes the file it names. */
const DD_OUTPUT = /(?:^|\s)of=(?:"([^"]+)"|'([^']+)'|([^\s;&|()]+))/

/** A token that looks like a file path rather than an identifier or method call. */
const PATH_TOKEN = /[^\s'"();,<>|&=]+/g

/** Inline-code path literals with a file extension (`gen.py`, `out/x.ts`). */
const EXTENSION_TOKEN = /^[\w.~-]+\.[A-Za-z0-9]{1,5}$/

/** Cap on the quoted excerpt, so one flag cannot carry a whole script into the next request. */
const EVIDENCE_CAP = 160

/**
 * Split a command on unquoted separators, so each rule sees one simple command
 * instead of the whole pipeline.
 *
 * @param command - the raw shell command.
 * @returns the trimmed simple commands, in order.
 */
export function splitCommands(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string
    if (quote !== undefined) {
      current += char
      if (char === quote && command[index - 1] !== '\\') quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      if (current.trim() !== '') out.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') out.push(current.trim())
  return out
}

/**
 * Split one simple command into words, dropping quotes.
 *
 * @param command - a simple command without unquoted separators.
 * @returns its words.
 */
export function splitWords(command: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: string | undefined
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current !== '') words.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') words.push(current)
  return words
}

/**
 * Whether a write target is a temporary scratch path the guard tolerates.
 *
 * @param target - a file path or shell expansion a command would write.
 * @returns true for temp paths, null devices, and temp expansions.
 */
export function isTempTarget(target: string): boolean {
  const value = target.trim()
  return TEMP_MARKERS.some(marker => value === marker || value.startsWith(marker))
}

/** The basename of a word, so `/usr/bin/sed` reads as `sed`. */
function basename(word: string): string {
  const parts = word.split('/')
  return parts[parts.length - 1] as string
}

/**
 * Whether an inline script mentions at least one path and every path it names
 * is a temporary one. A leading dot disqualifies a token, so `Path('x').write_text`
 * in a read-only script cannot masquerade as a temp-only write.
 */
function writesOnlyTempPaths(command: string): boolean {
  const candidates: string[] = []
  for (const match of command.matchAll(PATH_TOKEN)) {
    const token = match[0]
    if (token.startsWith('.') || token.startsWith('-')) continue
    if (!token.includes('/') && !EXTENSION_TOKEN.test(token)) continue
    candidates.push(token)
  }
  return candidates.length > 0 && candidates.every(isTempTarget)
}

/** Head-truncated matched text, so the model sees what tripped the rule. */
function evidenceFor(command: string): string {
  const collapsed = command.replace(/\s+/g, ' ').trim()
  return collapsed.length <= EVIDENCE_CAP ? collapsed : `${collapsed.slice(0, EVIDENCE_CAP)}…`
}

/**
 * Match one simple command against every enabled rule.
 *
 * @param command - one simple command.
 * @param disabled - rule ids the configuration disabled.
 * @param full - the complete command, because a heredoc body reaches its
 *   interpreter in a later segment than the one naming that interpreter.
 * @returns the matched rule and evidence, or undefined.
 */
function matchCommand(
  command: string,
  disabled: ReadonlySet<DetectionRuleId>,
  full: string,
): DetectionHit | undefined {
  const words = splitWords(command)
  const enabled = (rule: DetectionRuleId): boolean => !disabled.has(rule)
  const hit = (rule: RuleId): DetectionHit => ({ rule, evidence: evidenceFor(command) })
  const indexOf = (...names: string[]): number =>
    words.findIndex(word => names.includes(basename(word)))
  const inPlaceAfter = (index: number): boolean =>
    words.slice(index + 1, index + 6).some(word => IN_PLACE_FLAG.test(word))
  const lastTargetAfter = (index: number): string | undefined =>
    [...words.slice(index + 1)].reverse().find(word => !word.startsWith('-'))

  if (enabled('sed-in-place')) {
    const index = indexOf('sed', 'gsed')
    if (index >= 0 && inPlaceAfter(index)) {
      const target = lastTargetAfter(index)
      if (target === undefined || !isTempTarget(target)) return hit('sed-in-place')
    }
  }
  if (enabled('perl-in-place')) {
    const index = indexOf('perl')
    if (index >= 0 && inPlaceAfter(index)) {
      const target = lastTargetAfter(index)
      if (target === undefined || !isTempTarget(target)) return hit('perl-in-place')
    }
  }
  if (enabled('inline-interpreter')) {
    const index = indexOf(...INLINE_INTERPRETERS)
    if (index >= 0) {
      const window = words.slice(index + 1, index + 4)
      const inline = window.some(word => INLINE_FLAGS.has(word)) || HEREDOC.test(full)
      if (inline && INLINE_WRITE.test(full) && !writesOnlyTempPaths(full)) return hit('inline-interpreter')
    }
  }
  if (enabled('patch') && (indexOf('patch') >= 0 || (indexOf('git') >= 0 && words.includes('apply')))) {
    return hit('patch')
  }
  if (enabled('dd') && indexOf('dd') >= 0) {
    const output = DD_OUTPUT.exec(command)
    const target = output === null ? undefined : output[1] ?? output[2] ?? output[3]
    if (target !== undefined && !isTempTarget(target)) return hit('dd')
  }
  if (enabled('truncate')) {
    const index = indexOf('truncate')
    if (index >= 0) {
      const target = lastTargetAfter(index)
      if (target === undefined || !isTempTarget(target)) return hit('truncate')
    }
  }
  if (enabled('powershell-write') && POWERSHELL_WRITE.test(command)) {
    const targets = words.filter((word, at) => at > 0 && !word.startsWith('-')
      && (word.includes('/') || EXTENSION_TOKEN.test(word)))
    if (targets.length === 0 || !targets.every(isTempTarget)) return hit('powershell-write')
  }
  if (enabled('redirect')) {
    const redirect = new RegExp(REDIRECT.source, 'g')
    let match = redirect.exec(command)
    while (match !== null) {
      const target = match[1] ?? match[2] ?? match[3]
      if (target !== undefined && !target.startsWith('&') && !isTempTarget(target)) return hit('redirect')
      match = redirect.exec(command)
    }
  }
  if (enabled('tee')) {
    const index = indexOf('tee')
    if (index >= 0) {
      const targets = words.slice(index + 1).filter(word => !word.startsWith('-'))
      if (targets.length > 0 && !targets.every(isTempTarget)) return hit('tee')
    }
  }
  return undefined
}

/**
 * Detect a shell editing idiom in a command.
 *
 * Both pattern lists are tested per simple command, not against the whole
 * command line: `allowPatterns: ['^git apply ']` must not exempt a `sed -i`
 * chained after a `git apply`.
 *
 * @param command - the complete command a shell tool would run.
 * @param options - compiled allow, extra, and disabled rules.
 * @returns the matched rule and evidence, or undefined when the command is allowed.
 */
export function detectShellFileEdit(
  command: unknown,
  options: DetectionOptions,
): DetectionHit | undefined {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  const full = command.replace(/\\\r?\n/g, ' ')
  for (const simple of splitCommands(full)) {
    if (options.allow.some(pattern => pattern.test(simple))) continue
    if (options.extra.some(pattern => pattern.test(simple))) {
      return { rule: 'extra', evidence: evidenceFor(simple) }
    }
    const match = matchCommand(simple, options.disabledRules, full)
    if (match !== undefined) return match
  }
  return undefined
}
