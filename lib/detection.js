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
export const DETECTION_RULES = [
    'sed-in-place',
    'perl-in-place',
    'inline-interpreter',
    'shell-inline',
    'redirect',
    'tee',
    'patch',
    'dd',
    'truncate',
    'powershell-write',
];
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
    // Repository-local scratch and output capture, the convention `/tmp/`
    // follows on the host: projects gitignore `tmp/`, `.tmp/`, and `logs/`, so
    // capturing stderr or a log there (`… 2>tmp/stderr-check.txt`,
    // `… > logs/test.log`) is a diagnostic, not a hand edit. The trailing
    // separator is what keeps a real source file such as `tmpfile.txt` out.
    'tmp/',
    './tmp/',
    '.tmp/',
    'logs/',
    './logs/',
    '.logs/',
    '$TMPDIR',
    '${TMPDIR}',
    '$(mktemp',
    '`mktemp',
];
/** Option forms that turn an editor into an in-place rewriter. */
const IN_PLACE_FLAG = /^(?:--in-place(?:=.*)?|-[A-Za-z.]*i[A-Za-z.]*(?:\.[^\s]*)?)$/;
/** Inline-code flags that make an interpreter's payload part of the command. */
const INLINE_FLAGS = new Set(['-c', '-e', '--eval', '-']);
/** Interpreters that can execute model-authored code inside one shell command. */
const INLINE_INTERPRETERS = ['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'php'];
/** Shells whose `-c` payload is a command in its own right. */
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];
/** A heredoc whose body reaches the interpreter that reads it. */
const HEREDOC = /<<-?\s*['"]?[A-Za-z_]/;
/** Writes reachable from inline code; a read-only one-liner stays allowed. */
const INLINE_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|write_bytes|writelines|open\s*\([^)]*,\s*['"][wax]|\.write\s*\(|IO\.write|File\.write|shutil\.copy|os\.replace|os\.rename)\b/;
/** PowerShell cmdlets and .NET calls that write file content. */
const POWERSHELL_WRITE = /(?:^|[\s;&|(])(?:set-content|add-content|out-file|clear-content|export-csv|new-item)\b|\[(?:system\.)?io\.file\]::writealltext/i;
/** A token that looks like a file path rather than an identifier or an operator. */
const PATH_TOKEN = /[^\s'"();,<>|&=]+/g;
/** A redirect target that could name a file, as opposed to an operator or descriptor. */
const PATH_LIKE = /^(?![-=<>!&])[\w.~$@{}()[\]-][\w.~$@{}()[\]/.-]*$/;
/** Inline-code path literals with a file extension (`gen.py`, `out/x.ts`). */
const EXTENSION_TOKEN = /^[\w.~-]+\.[A-Za-z0-9]{1,5}$/;
/** Cap on the quoted excerpt, so one flag cannot carry a whole script into the next request. */
const EVIDENCE_CAP = 160;
/** How deep a shell's `-c` payload is followed before the rules stop descending. */
const MAX_SHELL_DEPTH = 2;
/**
 * Split a command on unquoted separators, so each rule sees one simple command
 * instead of the whole pipeline.
 *
 * @param command - the raw shell command.
 * @returns the trimmed simple commands, in order.
 */
export function splitCommands(command) {
    const out = [];
    let current = '';
    let quote;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote !== undefined) {
            current += char;
            if (char === quote && command[index - 1] !== '\\')
                quote = undefined;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (char === '\n' || char === ';' || char === '|' || char === '&') {
            if (current.trim() !== '')
                out.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim() !== '')
        out.push(current.trim());
    return out;
}
/**
 * Split one simple command into words, dropping quotes.
 *
 * @param command - a simple command without unquoted separators.
 * @returns its words.
 */
export function splitWords(command) {
    const words = [];
    let current = '';
    let quote;
    for (const char of command) {
        if (quote !== undefined) {
            if (char === quote)
                quote = undefined;
            else
                current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current !== '')
                words.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (current !== '')
        words.push(current);
    return words;
}
/**
 * Replace every quoted span with spaces, keeping the command's length and its
 * quoting structure. Quoted text, including a backtick span, is data as far as
 * the surrounding command's syntax goes, so syntax rules read this view and
 * cannot mistake a comparison or a word for a redirect or a program.
 *
 * @param command - the raw shell command.
 * @returns the same command with quoted and backtick spans blanked out.
 */
export function maskQuoted(command) {
    let masked = '';
    let quote;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote !== undefined) {
            masked += ' ';
            if (char === quote && command[index - 1] !== '\\')
                quote = undefined;
            continue;
        }
        // A backtick is a command substitution, but its body is also data as far as
        // the surrounding command's syntax goes; `substitutionPayloads` reads it as
        // a command in its own right.
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            masked += ' ';
            continue;
        }
        masked += char;
    }
    return masked;
}
/**
 * The command text inside every substitution: backtick spans and `$(…)` spans.
 * A shell runs these, so an editor hidden there is still an editor.
 *
 * @param command - the raw shell command.
 * @returns each substitution's inner text, in order.
 */
export function substitutionPayloads(command) {
    const payloads = [];
    let quote;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote !== undefined) {
            if (char === quote && command[index - 1] !== '\\')
                quote = undefined;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '`') {
            const close = command.indexOf('`', index + 1);
            const end = close === -1 ? command.length : close;
            payloads.push(command.slice(index + 1, end));
            index = end;
            continue;
        }
        if (char !== '$' || command[index + 1] !== '(')
            continue;
        let depth = 1;
        let end = index + 2;
        for (; end < command.length && depth > 0; end += 1) {
            const inner = command[end];
            if (inner === '(')
                depth += 1;
            else if (inner === ')')
                depth -= 1;
        }
        payloads.push(command.slice(index + 2, depth === 0 ? end - 1 : command.length));
        index = end - 1;
    }
    return payloads;
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
export function redirectWrites(command) {
    const writes = [];
    let quote;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote !== undefined) {
            if (char === quote && command[index - 1] !== '\\')
                quote = undefined;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char !== '>')
            continue;
        let digits = index;
        while (digits > 0 && /[0-9]/.test(command[digits - 1]))
            digits -= 1;
        const beforeDigits = digits === 0 ? undefined : command[digits - 1];
        const standaloneNumber = digits < index && (beforeDigits === undefined || /[\s;&|(]/.test(beforeDigits));
        const descriptor = standaloneNumber && command.slice(digits, index) === '2' ? 2 : 1;
        let at = index + 1;
        if (command[at] === '>')
            at += 1;
        index = at - 1;
        while (/\s/.test(command[at] ?? ''))
            at += 1;
        const opener = command[at];
        if (opener === '"' || opener === "'") {
            const close = command.indexOf(opener, at + 1);
            const end = close === -1 ? command.length : close;
            writes.push({ descriptor, target: command.slice(at + 1, end) });
            index = end;
            continue;
        }
        let end = at;
        while (end < command.length && !/[\s;&|()<>]/.test(command[end]))
            end += 1;
        if (end > at)
            writes.push({ descriptor, target: command.slice(at, end) });
        index = end - 1;
    }
    return writes;
}
/**
 * The redirect targets of one simple command.
 *
 * @param command - one simple command.
 * @returns the target paths, in order; quoting is stripped.
 */
export function redirectTargets(command) {
    return redirectWrites(command).map(write => write.target);
}
/**
 * The value of an unquoted `name=` assignment, read the way a shell reads it:
 * the value may be a bare word or a quoted one.
 *
 * @param command - the raw command.
 * @param name - the assignment name, e.g. `of`.
 * @returns the value without quotes, or undefined when the command sets none.
 */
export function assignmentValue(command, name) {
    let quote;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote !== undefined) {
            if (char === quote && command[index - 1] !== '\\')
                quote = undefined;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (!command.startsWith(`${name}=`, index))
            continue;
        const at = index + name.length + 1;
        const opener = command[at];
        if (opener === '"' || opener === "'") {
            const close = command.indexOf(opener, at + 1);
            const end = close === -1 ? command.length : close;
            return command.slice(at + 1, end);
        }
        let end = at;
        while (end < command.length && !/[\s;&|()<>]/.test(command[end]))
            end += 1;
        return end > at ? command.slice(at, end) : undefined;
    }
    return undefined;
}
/**
 * Whether a write target is a temporary scratch path the guard tolerates.
 *
 * @param target - a file path or shell expansion a command would write.
 * @returns true for temp paths, null devices, and temp expansions.
 */
export function isTempTarget(target) {
    const value = target.trim();
    return TEMP_MARKERS.some(marker => value === marker || value.startsWith(marker));
}
/** The basename of a word, so `/usr/bin/sed` reads as `sed`. */
function basename(word) {
    const parts = word.split('/');
    return parts[parts.length - 1];
}
/**
 * Whether an inline script mentions at least one path and every path it names
 * is a temporary one. A leading dot disqualifies a token, so `Path('x').write_text`
 * in a read-only script cannot masquerade as a temp-only write.
 */
function writesOnlyTempPaths(command) {
    const candidates = [];
    for (const match of command.matchAll(PATH_TOKEN)) {
        const token = match[0];
        if (token.startsWith('.') || token.startsWith('-'))
            continue;
        if (!token.includes('/') && !EXTENSION_TOKEN.test(token))
            continue;
        candidates.push(token);
    }
    return candidates.length > 0 && candidates.every(isTempTarget);
}
/** Head-truncated matched text, so the model sees what tripped the rule. */
function evidenceFor(command) {
    const collapsed = command.replace(/\s+/g, ' ').trim();
    return collapsed.length <= EVIDENCE_CAP ? collapsed : `${collapsed.slice(0, EVIDENCE_CAP)}…`;
}
/**
 * Match one simple command against every enabled rule.
 *
 * @param command - one simple command.
 * @param disabled - rule ids the configuration disabled.
 * @param full - the complete command, because a heredoc body reaches its
 *   interpreter in a later segment than the one naming that interpreter.
 * @param depth - how many `-c` payloads enclose this command already.
 * @returns the matched rule and evidence, or undefined.
 */
function matchCommand(command, disabled, full, depth) {
    const syntax = maskQuoted(command);
    const words = splitWords(syntax);
    const enabled = (rule) => !disabled.has(rule);
    const hit = (rule) => ({ rule, evidence: evidenceFor(command) });
    const indexOf = (...names) => words.findIndex(word => names.includes(basename(word)));
    const inPlaceAfter = (index) => words.slice(index + 1, index + 6).some(word => IN_PLACE_FLAG.test(word));
    const lastTargetAfter = (index) => [...words.slice(index + 1)].reverse().find(word => !word.startsWith('-'));
    if (enabled('sed-in-place')) {
        const index = indexOf('sed', 'gsed');
        if (index >= 0 && inPlaceAfter(index)) {
            const target = lastTargetAfter(index);
            if (target === undefined || !isTempTarget(target))
                return hit('sed-in-place');
        }
    }
    if (enabled('perl-in-place')) {
        const index = indexOf('perl');
        if (index >= 0 && inPlaceAfter(index)) {
            const target = lastTargetAfter(index);
            if (target === undefined || !isTempTarget(target))
                return hit('perl-in-place');
        }
    }
    if (enabled('inline-interpreter')) {
        const index = indexOf(...INLINE_INTERPRETERS);
        if (index >= 0) {
            const window = words.slice(index + 1, index + 4);
            const inline = window.some(word => INLINE_FLAGS.has(word)) || HEREDOC.test(full);
            if (inline && INLINE_WRITE.test(full) && !writesOnlyTempPaths(full))
                return hit('inline-interpreter');
        }
    }
    if (enabled('shell-inline') && depth < MAX_SHELL_DEPTH) {
        const payloads = indexOf(...SHELLS) >= 0
            ? splitWords(command).filter(word => !word.startsWith('-') && (word.includes(' ') || /[;&|><]/.test(word)))
            : [];
        for (const payload of [...payloads, ...substitutionPayloads(command)]) {
            const nested = matchCommand(payload, disabled, payload, depth + 1);
            if (nested !== undefined)
                return hit('shell-inline');
        }
    }
    if (enabled('patch') && (indexOf('patch') >= 0 || (indexOf('git') >= 0 && words.includes('apply')))) {
        return hit('patch');
    }
    if (enabled('dd') && indexOf('dd') >= 0) {
        const target = assignmentValue(command, 'of');
        if (target !== undefined && !isTempTarget(target))
            return hit('dd');
    }
    if (enabled('truncate')) {
        const index = indexOf('truncate');
        if (index >= 0) {
            const target = lastTargetAfter(index);
            if (target === undefined || !isTempTarget(target))
                return hit('truncate');
        }
    }
    if (enabled('powershell-write') && POWERSHELL_WRITE.test(syntax)) {
        const targets = words.filter((word, at) => at > 0 && !word.startsWith('-')
            && (word.includes('/') || EXTENSION_TOKEN.test(word)));
        if (targets.length === 0 || !targets.every(isTempTarget))
            return hit('powershell-write');
    }
    if (enabled('redirect')) {
        for (const write of redirectWrites(command)) {
            // Capturing stderr writes what a tool printed, never text the agent
            // authored, so it is a diagnostic like `/tmp` output rather than an edit.
            if (write.descriptor === 2)
                continue;
            if (!PATH_LIKE.test(write.target))
                continue;
            if (!isTempTarget(write.target))
                return hit('redirect');
        }
    }
    if (enabled('tee')) {
        const index = indexOf('tee');
        if (index >= 0) {
            const targets = words.slice(index + 1).filter(word => !word.startsWith('-'));
            if (targets.length > 0 && !targets.every(isTempTarget))
                return hit('tee');
        }
    }
    return undefined;
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
export function detectShellFileEdit(command, options) {
    if (typeof command !== 'string' || command.trim() === '')
        return undefined;
    const full = command.replace(/\\\r?\n/g, ' ');
    for (const simple of splitCommands(full)) {
        if (options.allow.some(pattern => pattern.test(simple)))
            continue;
        if (options.extra.some(pattern => pattern.test(simple))) {
            return { rule: 'extra', evidence: evidenceFor(simple) };
        }
        const match = matchCommand(simple, options.disabledRules, full, 0);
        if (match !== undefined)
            return match;
    }
    return undefined;
}
//# sourceMappingURL=detection.js.map