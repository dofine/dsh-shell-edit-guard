/**
 * Rule-table coverage for the shell file-edit guard: which shell idioms refuse a
 * command, which stay allowed, and how the compiled pattern lists interact with
 * the built-in rules.
 */

import { describe, expect, it } from 'vitest'
import { DETECTION_RULES, detectShellFileEdit, isTempTarget, splitCommands, splitWords } from '../src/detection.ts'
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
    ['Set-Content', "Set-Content -Path src/file.ts -Value 'x'", 'powershell-write'],
    ['Out-File', 'Get-Content a | Out-File src/file.ts', 'powershell-write'],
    ['a later command in a chain', 'pnpm run build && sed -i "s/a/b/" src/file.ts', 'sed-in-place'],
    ['a continued command line', "sed \\\n  -i 's/a/b/' src/file.ts", 'sed-in-place'],
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
    expect(isTempTarget('src/file.ts')).toBe(false)
  })
})
