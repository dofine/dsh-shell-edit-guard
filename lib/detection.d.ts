/**
 * Pure command analysis for `dsh-shell-edit-guard`: decide whether one shell
 * command edits files by hand. No Cordis types reach this module, so the rule
 * table is unit-testable without a registry and the plugin entry owns only
 * wiring and configuration.
 *
 * Rules read the command the way a shell does. Quoted text is data, not syntax:
 * a `>` inside a SQL string is a comparison, not a redirect, and `sed -i`
 * inside a quoted argument is a word, not a program. Two consequences the rules
 * keep explicit: a redirection's target may itself be quoted (`> "a b.txt"`),
 * and a shell invoked as `<shell> -c "<text>"` really runs that text, so the
 * payload is analyzed as its own command.
 *
 * @module @deepseek-ai/dsh-shell-edit-guard/detection
 */
/** Built-in rule ids, each naming one editing idiom the guard refuses. */
export declare const DETECTION_RULES: readonly ["sed-in-place", "perl-in-place", "inline-interpreter", "shell-inline", "redirect", "tee", "patch", "dd", "truncate", "powershell-write"];
/** One built-in rule a deployment may switch off. */
export type DetectionRuleId = (typeof DETECTION_RULES)[number];
/** Every rule id a refusal can name: the built-ins plus a deployment's own pattern. */
export type RuleId = DetectionRuleId | 'extra';
/** Compiled configuration the detection functions read. */
export interface DetectionOptions {
    /** Built-in rules this deployment switched off. */
    readonly disabledRules: ReadonlySet<DetectionRuleId>;
    /** Patterns that allow a matching simple command before any rule runs. */
    readonly allow: readonly RegExp[];
    /** Deployment patterns that refuse a matching simple command. */
    readonly extra: readonly RegExp[];
}
/** The rule that matched a command, with the text quoted back to the model. */
export interface DetectionHit {
    /** Matched rule id. */
    readonly rule: RuleId;
    /** Whitespace-collapsed, length-capped excerpt of the offending command. */
    readonly evidence: string;
}
/**
 * Split a command on unquoted separators, so each rule sees one simple command
 * instead of the whole pipeline.
 *
 * @param command - the raw shell command.
 * @returns the trimmed simple commands, in order.
 */
export declare function splitCommands(command: string): string[];
/**
 * Split one simple command into words, dropping quotes.
 *
 * @param command - a simple command without unquoted separators.
 * @returns its words.
 */
export declare function splitWords(command: string): string[];
/**
 * Replace every quoted span with spaces, keeping the command's length and its
 * quoting structure. Quoted text, including a backtick span, is data as far as
 * the surrounding command's syntax goes, so syntax rules read this view and
 * cannot mistake a comparison or a word for a redirect or a program.
 *
 * @param command - the raw shell command.
 * @returns the same command with quoted and backtick spans blanked out.
 */
export declare function maskQuoted(command: string): string;
/**
 * The command text inside every substitution: backtick spans and `$(…)` spans.
 * A shell runs these, so an editor hidden there is still an editor.
 *
 * @param command - the raw shell command.
 * @returns each substitution's inner text, in order.
 */
export declare function substitutionPayloads(command: string): string[];
/**
 * One file a shell opens for writing through a redirect, with the descriptor
 * the shell redirects.
 */
export interface RedirectWrite {
    /** File descriptor the shell redirected; 1 (stdout) when the command names none. */
    readonly descriptor: 1 | 2;
    /** Target path, quoting stripped. */
    readonly target: string;
}
/**
 * Every file a command redirects into, read the way a shell reads them: an
 * unquoted `>` or `>>` starts the target, which may itself be quoted. A run of
 * digits immediately before the operator is an IO number, and only counts as
 * one when it stands alone as a word — `2>log` redirects descriptor 2, while
 * `x2>log` redirects stdout.
 *
 * @param command - one simple command.
 * @returns the writes, in order; quoting is stripped.
 */
export declare function redirectWrites(command: string): RedirectWrite[];
/**
 * The redirect targets of one simple command.
 *
 * @param command - one simple command.
 * @returns the target paths, in order; quoting is stripped.
 */
export declare function redirectTargets(command: string): string[];
/**
 * The value of an unquoted `name=` assignment, read the way a shell reads it:
 * the value may be a bare word or a quoted one.
 *
 * @param command - the raw command.
 * @param name - the assignment name, e.g. `of`.
 * @returns the value without quotes, or undefined when the command sets none.
 */
export declare function assignmentValue(command: string, name: string): string | undefined;
/**
 * Whether a write target is a temporary scratch path the guard tolerates.
 *
 * @param target - a file path or shell expansion a command would write.
 * @returns true for temp paths, null devices, and temp expansions.
 */
export declare function isTempTarget(target: string): boolean;
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
export declare function detectShellFileEdit(command: unknown, options: DetectionOptions): DetectionHit | undefined;
