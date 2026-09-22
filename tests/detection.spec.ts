/**
 * Rule-table coverage for the shell file-edit guard: which shell idioms refuse a
 * command, which stay allowed, and how the compiled pattern lists interact with
 * the built-in rules.
 */

import { describe, expect, it } from 'vitest'
import {
  DETECTION_RULES,
  assignmentValue,
  detectShellFileEdit,
  isTempTarget,
  maskQuoted,
  redirectTargets,
  redirectWrites,
  splitCommands,
  splitWords,
  substitutionPayloads,
} from '../src/detection.ts'
import type { DetectionOptions, DetectionRuleId } from '../src/detection.ts'

/** Compiled options with no pattern lists, for the built-in rules. */
function options(overrides: Partial<DetectionOptions> = {}): DetectionOptions {
  return {
    disabledRules: new Set<DetectionRuleId>(),
    allow: [],
    extra: [],
    ...overrides,
  }
}

const detect = (command: unknown, overrides: Partial<DetectionOptions> = {}) =>
  detectShellFileEdit(command, options(overrides))

describe('refused editing idioms', () => {
  const cases: ReadonlyArray<readonly [string, string, DetectionRuleId]> = [
    ['sed -i', "sed -i 's/old/new/' src/file.ts", 'sed-in-place'],
    ['sed -i with a backup suffix', "sed -i.bak -e 's/a/b/' src/file.ts", 'sed-in-place'],
    ['sed --in-place', "sed --in-place 's/a/b/' src/file.ts", 'sed-in-place'],
    ['sed reachable through find -exec', "find . -name '*.ts' -exec sed -i 's/a/b/' {} +", 'sed-in-place'],
    ['sed called by absolute path', "/usr/bin/sed -i 's/a/b/' file", 'sed-in-place'],
    ['gsed -i', "gsed -i 's/a/b/' file", 'sed-in-place'],
    ['perl -pi', "perl -pi -e 's/a/b/' src/file.ts", 'perl-in-place'],
    ['perl -i', "perl -i -pe 's/a/b/' src/file.ts", 'perl-in-place'],
    ['python -c writing', `python3 -c "open('src/file.ts','w').write('x')"`, 'inline-interpreter'],
    ['python heredoc writing', "python3 - <<'PY'\nopen('src/file.ts','w').write('x')\nPY", 'inline-interpreter'],
    ['python - reading stdin', "python3 - <<'PY'\nopen('src/file.ts','w').write('x')\nPY", 'inline-interpreter'],
    ['node -e writing', `node -e "require('fs').writeFileSync('src/file.ts','x')"`, 'inline-interpreter'],
    ['ruby -e writing', `ruby -e "File.write('src/file.ts', 'x')"`, 'inline-interpreter'],
    ['heredoc redirect', "cat > src/file.ts <<'EOF'\nhello\nEOF", 'redirect'],
    ['append redirect', 'printf "%s\\n" "line" >> src/file.ts', 'redirect'],
    ['redirect into a file whose name only starts with tmp', 'pnpm run test > tmpfile.txt', 'redirect'],
    ['redirect into a nested tmp directory', 'pnpm run test > src/tmp/t.log', 'redirect'],
    ['redirect into a nested log directory', 'pnpm run test > src/logs/t.log', 'redirect'],
    ['redirect into a report next to the sources', 'pnpm run test > report.txt', 'redirect'],
    ['a redirect whose descriptor only looks like one', 'echo x2>out.log', 'redirect'],
    ['double-quoted redirect target', 'echo hi > "src/file.ts"', 'redirect'],
    ['tee into a source file', 'npx tsc --noEmit | tee build/report.txt', 'tee'],
    ['tee append', 'make 2>&1 | tee -a notes.md', 'tee'],
    ['patch', 'patch -p1 < change.diff', 'patch'],
    ['git apply', 'git apply fix.patch', 'patch'],
    ['dd', 'dd if=/dev/zero of=src/file.ts bs=1 count=10', 'dd'],
    ['dd writing a quoted target', 'dd if=/dev/zero of="src/file.ts" bs=1 count=10', 'dd'],
    ['dd writing a single-quoted target', "dd if=/dev/zero of='src/file.ts' bs=1 count=10", 'dd'],
    ['truncate', 'truncate -s 0 src/file.ts', 'truncate'],
    ['truncate with no target', 'truncate', 'truncate'],
    ['python reading a heredoc without an inline flag', "python3 <<'PY'\nopen('src/file.ts','w').write('x')\nPY", 'inline-interpreter'],
    ['Set-Content with a dotted target', "Set-Content -Path notes.md -Value 'x'", 'powershell-write'],
    ['Set-Content with no path at all', "Set-Content -Value 'x'", 'powershell-write'],
    ['Set-Content', "Set-Content -Path src/file.ts -Value 'x'", 'powershell-write'],
    ['Out-File', 'Get-Content a | Out-File src/file.ts', 'powershell-write'],
    ['a later command in a chain', 'pnpm run build && sed -i "s/a/b/" src/file.ts', 'sed-in-place'],
    ['a continued command line', "sed \\\n  -i 's/a/b/' src/file.ts", 'sed-in-place'],
    ['an editor inside a shell payload', `bash -c "sed -i 's/a/b/' src/file.ts"`, 'shell-inline'],
    ['an editor one shell deeper', `sh -c 'bash -c "perl -pi -e s/a/b/ f.ts"'`, 'shell-inline'],
    ['an editor inside a backtick substitution', "echo `sed -i 's/a/b/' src/file.ts`", 'shell-inline'],
    ['an editor inside a command substitution', 'echo $(sed -i s/a/b/ src/file.ts)', 'shell-inline'],
  ]

  it.each(cases)('refuses %s', (_label, command, rule) => {
    expect(detect(command)?.rule).toBe(rule)
  })

  it('quotes the offending command back to the model, capped', () => {
    const long = `sed -i '${'x'.repeat(400)}' src/file.ts`
    const hit = detect(long)
    expect(hit?.evidence.endsWith('…')).toBe(true)
    expect(hit?.evidence.length).toBe(161)
  })

  it('caps evidence per offending command, not per chain', () => {
    const hit = detect("pnpm run build && sed -i 's/a/b/' src/file.ts")
    expect(hit?.evidence).toBe("sed -i 's/a/b/' src/file.ts")
  })

  it('checks every built-in rule id has at least one refusing case', () => {
    const covered = new Set(cases.map(([, , rule]) => rule))
    expect([...covered].sort()).toEqual([...DETECTION_RULES].sort())
  })
})

describe('allowed commands', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['a package script', 'pnpm run lint:fix'],
    ['a formatter', 'pnpm exec prettier --write src/file.ts'],
    ['a linter fix', 'pnpm exec eslint . --fix'],
    ['a build', 'pnpm run build'],
    ['a test run', 'pnpm exec vitest run packages/fs'],
    ['a project generator script', 'python3 scripts/generate_catalog.py'],
    ['a node script file', 'node scripts/build.mjs'],
    ['git workflow', 'git add -A && git commit -m "x"'],
    ['sed reading', "sed -n '1,20p' src/file.ts"],
    ['perl reading', "perl -ne 'print' src/file.ts"],
    ['node read-only one-liner', `node -e "console.log(require('fs').readFileSync('a.txt','utf8'))"`],
    ['python read-only one-liner', `python3 -c "print(open('a.txt').read())"`],
    ['redirect to /dev/null', 'pnpm run test > /dev/null 2>&1'],
    ['redirect to a temp expansion', 'pnpm run build > "$TMPDIR/build.log" 2>&1'],
    ['redirect to /tmp', 'pnpm run test > /tmp/t.log 2>&1'],
    ['stderr capture into a repository scratch dir', 'uv run ykdata mc-fetch 20260922082057652gu93ad54o1a --format json 2>tmp/stderr-check.txt'],
    ['stderr capture into a log dir', 'uv run ykdata mc-fetch 20260922082057652gu93ad54o1a --format json 2>logs/stderr-check.txt'],
    ['stderr append into a log file', 'pnpm run test 2>>logs/stderr.log'],
    ['stdout capture into a log dir', 'pnpm run test > logs/test.log 2>&1'],
    ['stdout capture into a dot-log dir', 'pnpm run build > .logs/build.log'],
    ['stdlib capture into a relative log dir', 'pnpm run build > ./logs/build.log'],
    ['stderr capture into a quoted path', 'pnpm run test 2>"logs/a b.log"'],
    ['redirect into a repository scratch dir', 'pnpm run test > tmp/t.log 2>&1'],
    ['redirect into a relative scratch dir', 'pnpm run build > ./tmp/build.log'],
    ['redirect into a dot-scratch dir', 'pnpm run build > .tmp/build.log'],
    ['tee into a repository scratch dir', 'pnpm run test | tee tmp/t.log'],
    ['tee to a temp file', 'pnpm run test | tee /tmp/t.log'],
    ['in-place edit of a scratch file', "sed -i 's/a/b/' /tmp/scratch.txt"],
    ['perl in-place edit of a scratch file', "perl -pi -e 's/a/b/' /tmp/scratch.txt"],
    ['python one-liner writing only temp', `python3 -c "open('/tmp/x','w').write('y')"`],
    ['dd to a temp file', 'dd if=/dev/zero of=/tmp/zeros bs=1 count=10'],
    ['truncate a temp file', 'truncate -s 0 /tmp/scratch.txt'],
    ['Set-Content to a temp file', "Set-Content -Path /tmp/x.txt -Value 'y'"],
    ['dd with no output target', 'dd if=/dev/zero bs=1 count=10'],
    ['redirect of a file descriptor', 'pnpm run test >&2'],
    ['cargo', 'cargo build --release'],
    ['go generate', 'go generate ./...'],
    ['docker build', 'docker build -t app .'],
    ['a SQL query whose comparison operators look like redirects', `psql -c "SELECT 1 WHERE dt >= '20260901' AND dt <= '20260920'"`],
    ['the reported warehouse query', 'uv run ykdata mc-submit --sql "SELECT dt, COUNT(1) AS rows_cnt FROM t WHERE dt >= \'20260901\'" 2>&1 | tail -3'],
    ['a quoted redirect-looking string', 'echo "a > b"'],
    ['a quoted word that looks like an editor', `echo "sed -i 's/a/b/' src/file.ts"`],
    ['a shell payload that edits nothing', 'bash -c "echo hello"'],
    ['a backtick substitution that edits nothing', 'echo `date +%Y-%m-%d`'],
    ['a comparison inside a backtick substitution', 'echo `printf "a > b"`'],
    ['an empty command', '   '],
  ]

  it.each(cases)('allows %s', (_label, command) => {
    expect(detect(command)).toBeUndefined()
  })

  it('refuses an inline write when the only argument is not a path', () => {
    expect(detect(`python3 -c "open(f,'w').write('y')"`)?.rule).toBe('inline-interpreter')
    expect(detect(`python3 -c "open(os.environ['F'],'w').write('y')"`)?.rule).toBe('inline-interpreter')
  })

  it('ignores a non-string or missing command', () => {
    expect(detect(undefined)).toBeUndefined()
    expect(detect({ command: 'sed -i x' })).toBeUndefined()
  })
})

describe('configured pattern lists', () => {
  it('refuses a command matched by extraPatterns', () => {
    const hit = detect('rm -rf src', { extra: [/rm -rf src/] })
    expect(hit?.rule).toBe('extra')
    expect(hit?.evidence).toBe('rm -rf src')
  })

  it('lets allowPatterns exempt one simple command', () => {
    const allow = [/^git apply /]
    expect(detect('git apply fix.patch', { allow })).toBeUndefined()
    expect(detect('sed -i s/a/b/ f.ts', { allow })?.rule).toBe('sed-in-place')
    expect(detect('make deploy && sed -i s/a/b/ f.ts', { allow: [/^make /] })?.rule).toBe('sed-in-place')
  })

  it('drops every built-in rule when all are disabled', () => {
    const disabledRules = new Set<DetectionRuleId>(DETECTION_RULES)
    const commands = [
      "sed -i 's/a/b/' src/file.ts",
      "perl -pi -e 's/a/b/' src/file.ts",
      `python3 -c "open('src/file.ts','w').write('x')"`,
      'patch -p1 < change.diff',
      'dd if=/dev/zero of=src/file.ts bs=1 count=10',
      'truncate -s 0 src/file.ts',
      "Set-Content -Path src/file.ts -Value 'x'",
      'echo hi > src/file.ts',
      'make | tee notes.md',
    ]
    for (const command of commands) expect(detect(command, { disabledRules })).toBeUndefined()
  })

  it('drops a disabled rule', () => {
    const disabledRules = new Set<DetectionRuleId>(['tee'])
    expect(detect('make | tee notes.md', { disabledRules })).toBeUndefined()
    expect(detect('sed -i s/a/b/ f.ts', { disabledRules })?.rule).toBe('sed-in-place')
  })
})

describe('command splitting', () => {
  it('splits on unquoted separators and keeps quoted ones', () => {
    expect(splitCommands('a; b | c && d')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitCommands('printf "a;b" && c')).toEqual(['printf "a;b"', 'c'])
    expect(splitCommands('printf "a\'b;c"')).toEqual(['printf "a\'b;c"'])
    expect(splitCommands('printf "a\\"; b')).toEqual(['printf "a\\"; b'])
    expect(splitCommands('\n\n')).toEqual([])
  })

  it('splits words and drops quotes', () => {
    expect(splitWords(`sed -i 's/a b/c/' file`)).toEqual(['sed', '-i', 's/a b/c/', 'file'])
    expect(splitWords('  ')).toEqual([])
  })

  it('recognizes temporary and non-temporary targets', () => {
    expect(isTempTarget(' /tmp/x ')).toBe(true)
    expect(isTempTarget('/tmp/')).toBe(true)
    expect(isTempTarget('/dev/null')).toBe(true)
    expect(isTempTarget('${TMPDIR}/x')).toBe(true)
    expect(isTempTarget('tmp/stderr-check.txt')).toBe(true)
    expect(isTempTarget('./tmp/t.log')).toBe(true)
    expect(isTempTarget('.tmp/build.log')).toBe(true)
    expect(isTempTarget('tmpfile.txt')).toBe(false)
    expect(isTempTarget('logs/test.log')).toBe(true)
    expect(isTempTarget('./logs/test.log')).toBe(true)
    expect(isTempTarget('src/tmp/out.txt')).toBe(false)
    expect(isTempTarget('src/logs/t.log')).toBe(false)
    expect(isTempTarget('src/file.ts')).toBe(false)
  })
})

describe('shell-syntax readers', () => {
  it('blanks quoted spans and keeps the command length', () => {
    const command = `echo "a > b" 'c; d'`
    const masked = maskQuoted(command)
    expect(masked).toHaveLength(command.length)
    expect(masked).not.toContain('>')
    expect(masked).not.toContain('"')
    expect(masked).not.toContain("'")
    expect(maskQuoted(`echo 'unclosed`)).toBe('echo ' + ' '.repeat(9))
  })

  it('reads redirect targets a shell would act on', () => {
    expect(redirectTargets('echo hi > out.txt')).toEqual(['out.txt'])
    expect(redirectTargets('echo hi >> "a b.txt"')).toEqual(['a b.txt'])
    expect(redirectTargets("echo hi >'a b.txt'")).toEqual(['a b.txt'])
    expect(redirectTargets("psql -c \"SELECT 1 WHERE dt >= 'x'\"")).toEqual([])
    // `>&2` duplicates a descriptor; the reader reports no file at all.
    expect(redirectTargets('echo hi >&2')).toEqual([])
    // A quoted target that never closes still names the file after the operator.
    expect(redirectTargets('echo hi > "unclosed')).toEqual(['unclosed'])
    expect(redirectTargets('echo hi >')).toEqual([])
    expect(redirectTargets('echo "unclosed > out.txt')).toEqual([])
  })

  it('reads which descriptor each redirect writes', () => {
    expect(redirectWrites('run 2>err.log')).toEqual([{ descriptor: 2, target: 'err.log' }])
    expect(redirectWrites('run 2>>err.log')).toEqual([{ descriptor: 2, target: 'err.log' }])
    expect(redirectWrites('run 1>out.log >tail.log')).toEqual([
      { descriptor: 1, target: 'out.log' },
      { descriptor: 1, target: 'tail.log' },
    ])
    expect(redirectWrites('echo x2>out.log')).toEqual([{ descriptor: 1, target: 'out.log' }])
    expect(redirectWrites('run 2>err.log >out.log')).toEqual([
      { descriptor: 2, target: 'err.log' },
      { descriptor: 1, target: 'out.log' },
    ])
    expect(redirectWrites('run 2>&1')).toEqual([])
    // An IO number at the start of the command still stands alone as a word.
    expect(redirectWrites('2>err.log')).toEqual([{ descriptor: 2, target: 'err.log' }])
    expect(redirectWrites('2>>err.log; run')).toEqual([{ descriptor: 2, target: 'err.log' }])
  })

  it('reads an assignment value with or without quotes', () => {
    expect(assignmentValue('dd if=/dev/zero of=src/file.ts bs=1', 'of')).toBe('src/file.ts')
    expect(assignmentValue('dd of="a b.bin" bs=1', 'of')).toBe('a b.bin')
    expect(assignmentValue("dd of='a b.bin' bs=1", 'of')).toBe('a b.bin')
    expect(assignmentValue('dd of="unclosed', 'of')).toBe('unclosed')
    expect(assignmentValue('dd of= bs=1', 'of')).toBeUndefined()
    expect(assignmentValue('dd if=/dev/zero bs=1', 'of')).toBeUndefined()
    expect(assignmentValue('echo "of=x"', 'of')).toBeUndefined()
  })

  it('reads substitution payloads, including nested and unclosed ones', () => {
    expect(substitutionPayloads('echo `date` $(pwd)')).toEqual(['date', 'pwd'])
    expect(substitutionPayloads('echo "a" `b`')).toEqual(['b'])
    expect(substitutionPayloads('echo `date')).toEqual(['date'])
    expect(substitutionPayloads('echo $(echo $(date))')).toEqual(['echo $(date)'])
    expect(substitutionPayloads('echo $(sed -i s/a/b/ f.ts')).toEqual(['sed -i s/a/b/ f.ts'])
    expect(substitutionPayloads('echo nothing')).toEqual([])
  })
})
