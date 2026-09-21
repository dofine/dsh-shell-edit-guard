/**
 * Registry-level behavior of the shell file-edit guard: what its monotonic
 * `tools.guard` refuses, what it delegates, and how row configuration changes
 * both. The rule table itself is covered by `detection.spec.ts`; these cases
 * drive the real tool pipeline, so a refusal must also prove the shell body
 * never ran.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ShellEditGuard from 'dsh-shell-edit-guard'

const signal = new AbortController().signal

/** A command tool that records the commands it was allowed to run. */
function commandTool(name: string, ran: string[]) {
  return defineContentToolFixture({
    name,
    description: `fixture ${name}`,
    parameters: { command: { type: 'string', required: true } },
    execute(args) {
      ran.push(args.command)
      return [{ type: 'text', text: `ran: ${args.command}` }]
    },
  })
}

/** A mutator stand-in, so the guard sees the tools a refusal sends the model to. */
function mutator(name: string) {
  return defineContentToolFixture({
    name,
    description: `fixture ${name}`,
    parameters: { file_path: { type: 'string', required: true } },
    execute() {
      return [{ type: 'text', text: `${name} ok` }]
    },
  })
}

/**
 * A `jev_decide` stand-in whose canonical value is the judge tool's own Noul
 * answer, so the guard reads it exactly as it reads the real plugin's result.
 */
function judgeTool(answers: Readonly<Record<string, number>>, asked: string[] = []) {
  return defineTool({
    name: 'jev_decide',
    description: 'fixture judge',
    parameters: {
      state: { type: 'string', required: true },
      question: { type: 'string', required: true },
      type: { type: 'string' },
      command: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          type: { type: 'string', required: true },
          answer: { required: true, oneOf: [{ type: 'number' }, { type: 'string' }] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args) {
      asked.push(args.state)
      const probability = answers[args.state]
      if (probability === undefined) throw new Error('fixture judge: no answer')
      return { model: 'jev-fixture', type: 'noul', answer: probability }
    },
  })
}

/** A judge that never settles until its call is aborted, for the timeout path. */
function hangingJudge() {
  return defineTool({
    name: 'jev_decide',
    description: 'hanging judge',
    parameters: { state: { type: 'string', required: true }, question: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { type: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(_args, exec) {
      return new Promise((resolve) => {
        exec.signal.addEventListener('abort', () => { resolve({ type: 'noul', answer: 0.99 }) })
      })
    },
  })
}

/** Mount the tool registry, the fixtures, and the guard under test. */
async function setup(options?: ShellEditGuard.Config, editors = true, judge?: ReturnType<typeof judgeTool>) {
  const ctx = new Context()
  const ran: string[] = []
  // ToolRuntime injects systemPrompt, so the registry stays pending without it.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(commandTool('bash', ran))
  ctx.tools.register(commandTool('pwsh', ran))
  if (editors) {
    ctx.tools.register(mutator('edit'))
    ctx.tools.register(mutator('write'))
  }
  if (judge !== undefined) ctx.tools.register(judge)
  const fiber = await ctx.plugin(ShellEditGuard, options)
  return { ctx, ran, fiber }
}

let callCounter = 0

async function run(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  callCounter += 1
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${String(callCounter)}`),
    name,
    arguments: args,
  })
}

/** Model-facing text of a settled call. */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('shell file-edit guard', () => {
  it('refuses a hand edit and never dispatches the shell', async () => {
    const { ctx, ran } = await setup()
    const result = await run(ctx, 'bash', { command: "sed -i 's/a/b/' src/file.ts" })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Refused by shell-edit-guard')
    expect(text(result)).toContain('rule: sed-in-place')
    expect(text(result)).toContain('edit tool')
    expect(ran).toEqual([])
  })

  it('delegates ordinary commands', async () => {
    const { ctx, ran } = await setup()
    const result = await run(ctx, 'bash', { command: 'pnpm run build' })
    expect(result.isError).toBe(false)
    expect(ran).toEqual(['pnpm run build'])
  })

  it('stands down when the agent has no write/edit tool to use', async () => {
    const { ctx, ran } = await setup(undefined, false)
    const result = await run(ctx, 'bash', { command: "sed -i 's/a/b/' src/file.ts" })
    expect(result.isError).toBe(false)
    expect(ran).toEqual(["sed -i 's/a/b/' src/file.ts"])
  })

  it('refuses without an editor tool when requireEditorTool is false', async () => {
    const { ctx } = await setup({ requireEditorTool: false }, false)
    const result = await run(ctx, 'bash', { command: "sed -i 's/a/b/' src/file.ts" })
    expect(result.isError).toBe(true)
  })

  it('inspects only the configured tools', async () => {
    const { ctx, ran } = await setup({ tools: ['pwsh'] })
    const viaBash = await run(ctx, 'bash', { command: "sed -i 's/a/b/' src/file.ts" })
    expect(viaBash.isError).toBe(false)
    const viaPwsh = await run(ctx, 'pwsh', { command: "Set-Content src/file.ts 'x'" })
    expect(viaPwsh.isError).toBe(true)
    expect(ran).toEqual(["sed -i 's/a/b/' src/file.ts"])
  })

  it('never refuses a call whose arguments carry no command string', async () => {
    const { ctx } = await setup()
    // The guard delegates both shapes; the tool's own schema may still reject
    // the call, which is not this plugin's refusal.
    expect(text(await run(ctx, 'bash', {}))).not.toContain('Refused by shell-edit-guard')
    expect(text(await run(ctx, 'bash', 'not-an-object'))).not.toContain('Refused by shell-edit-guard')
  })

  it('ignores a tool outside its list even when the arguments carry a command', async () => {
    const { ctx } = await setup()
    ctx.tools.register(commandTool('read', []))
    const result = await run(ctx, 'read', { command: "sed -i 's/a/b/' src/file.ts" })
    expect(result.isError).toBe(false)
  })

  it('drops a disabled rule', async () => {
    const { ctx } = await setup({ disabledRules: ['tee'] })
    expect((await run(ctx, 'bash', { command: 'pnpm run build | tee notes.md' })).isError).toBe(false)
    expect((await run(ctx, 'bash', { command: "sed -i 's/a/b/' src/file.ts" })).isError).toBe(true)
  })

  it('exempts one allowed simple command without exempting a chain', async () => {
    const { ctx } = await setup({ allowPatterns: ['^git apply '] })
    expect((await run(ctx, 'bash', { command: 'git apply fix.patch' })).isError).toBe(false)
    expect((await run(ctx, 'bash', { command: 'git apply fix.patch && sed -i s/a/b/ f.ts' })).isError).toBe(true)
  })

  it('refuses a deployment pattern from extraPatterns', async () => {
    const { ctx } = await setup({ extraPatterns: ['rm -rf src'] })
    const result = await run(ctx, 'bash', { command: 'rm -rf src' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rule: extra')
  })

  it('fails loud on an unknown rule id', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(ShellEditGuard, { disabledRules: ['sed-i'] })).rejects.toThrow(/unknown rule/)
  })

  it('fails loud on an invalid pattern', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(ShellEditGuard, { allowPatterns: ['('] })).rejects.toThrow(/not a valid regex/)
  })

  it('withdraws the guard when its fiber is disposed', async () => {
    const { ctx, ran, fiber } = await setup()
    await fiber.dispose()
    const result = await run(ctx, 'bash', { command: "sed -i 's/a/b/' src/file.ts" })
    expect(result.isError).toBe(false)
    expect(ran).toEqual(["sed -i 's/a/b/' src/file.ts"])
  })
})

describe('jev judge wiring', () => {
  const edit = "sed -i 's/a/b/' src/file.ts"

  it('lets a read-only verdict rescue a command the rules flagged', async () => {
    const asked: string[] = []
    const { ctx, ran } = await setup(undefined, true, judgeTool({ [edit]: 0.03 }, asked))
    const result = await run(ctx, 'bash', { command: edit })
    expect(result.isError).toBe(false)
    expect(ran).toEqual([edit])
    expect(asked).toEqual([edit])
  })

  it('refuses on an edit verdict and names the model and probability', async () => {
    const { ctx, ran } = await setup(undefined, true, judgeTool({ [edit]: 0.96 }))
    const result = await run(ctx, 'bash', { command: edit })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('jev-fixture p=0.96')
    expect(ran).toEqual([])
  })

  it('keeps the rule verdict when no judge tool is mounted', async () => {
    const { ctx, ran } = await setup()
    const result = await run(ctx, 'bash', { command: edit })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rule: sed-in-place')
    expect(ran).toEqual([])
  })

  it('keeps the rule verdict when the judge call fails', async () => {
    const { ctx } = await setup(undefined, true, judgeTool({}))
    const result = await run(ctx, 'bash', { command: edit })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rule: sed-in-place')
  })

  it('allows a failed judge call when onError says allow', async () => {
    const { ctx, ran } = await setup({ judge: { onError: 'allow' } }, true, judgeTool({}))
    expect((await run(ctx, 'bash', { command: edit })).isError).toBe(false)
    expect(ran).toEqual([edit])
  })

  it('keeps the rule verdict when the judge call never settles', async () => {
    const { ctx, ran } = await setup({ judge: { timeoutMs: 20 } }, true, hangingJudge())
    const result = await run(ctx, 'bash', { command: edit })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rule: sed-in-place')
    expect(ran).toEqual([])
  })

  it('sends an unsure verdict down the configured path', async () => {
    const band = judgeTool({ [edit]: 0.5 })
    const rulePath = await setup(undefined, true, band)
    expect((await run(rulePath.ctx, 'bash', { command: edit })).isError).toBe(true)

    const allowed = await setup({ judge: { onUnsure: 'allow' } }, true, judgeTool({ [edit]: 0.5 }))
    expect((await run(allowed.ctx, 'bash', { command: edit })).isError).toBe(false)

    const denied = await setup({ judge: { onUnsure: 'deny' } }, true, judgeTool({ [edit]: 0.5 }))
    const result = await run(denied.ctx, 'bash', { command: edit })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('p=0.50')
  })

  it('answers a repeated command from the cache', async () => {
    const asked: string[] = []
    const { ctx } = await setup(undefined, true, judgeTool({ [edit]: 0.96 }, asked))
    await run(ctx, 'bash', { command: edit })
    const again = await run(ctx, 'bash', { command: edit })
    expect(again.isError).toBe(true)
    expect(asked).toEqual([edit])
  })

  it('judges rules-clean commands in always mode', async () => {
    const command = 'my-editor --write src/file.ts'
    const { ctx } = await setup({ judge: { mode: 'always' } }, true, judgeTool({ [command]: 0.91 }))
    const result = await run(ctx, 'bash', { command })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('p=0.91')
  })

  it('never inspects the judge tool itself, even when the row lists it', async () => {
    const asked: string[] = []
    const { ctx, ran } = await setup(
      { tools: ['bash', 'jev_decide'] },
      true,
      judgeTool({ [edit]: 0.96 }, asked),
    )
    // This call carries a `command` argument, so a guard that inspected the
    // judge tool would refuse it and recurse into the judge.
    const result = await run(ctx, 'jev_decide', { state: edit, question: 'q', command: edit })
    expect(result.isError).toBe(false)
    expect(asked).toEqual([edit])
    expect(ran).toEqual([])
  })

  it('fails loud on thresholds, an empty question, and a bad timeout', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(ShellEditGuard, { judge: { allowAt: 0.9, denyAt: 0.2 } }))
      .rejects.toThrow(/allowAt < denyAt/)
    await expect(ctx.plugin(ShellEditGuard, { judge: { question: '  ' } }))
      .rejects.toThrow(/question must not be empty/)
    await expect(ctx.plugin(ShellEditGuard, { judge: { timeoutMs: 0 } }))
      .rejects.toThrow(/positive integer/)
  })

  it('never consults the judge when the row disables it', async () => {
    const asked: string[] = []
    const { ctx, ran } = await setup({ judge: { enabled: false } }, true, judgeTool({ [edit]: 0.03 }, asked))
    const result = await run(ctx, 'bash', { command: edit })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rule: sed-in-place')
    expect(asked).toEqual([])
    expect(ran).toEqual([])
  })

  it('passes a model through to the judge tool', async () => {
    const { ctx } = await setup({ judge: { model: 'jev-latest' } }, true, judgeTool({ [edit]: 0.96 }))
    expect((await run(ctx, 'bash', { command: edit })).isError).toBe(true)
  })

  it('falls back to the rules when the judge answers another question type', async () => {
    const choiceJudge = defineTool({
      name: 'jev_decide',
      description: 'fixture judge answering a choice',
      parameters: { state: { type: 'string', required: true }, question: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { model: { type: 'string', required: true }, type: { type: 'string', required: true }, answer: { required: true, oneOf: [{ type: 'number' }, { type: 'string' }] } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute() { return { model: 'jev-fixture', type: 'choice', answer: 'billing' } },
    })
    const { ctx } = await setup(undefined, true, choiceJudge as ReturnType<typeof judgeTool>)
    const result = await run(ctx, 'bash', { command: edit })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rule: sed-in-place')
  })

  it('caps the command it quotes in a judge refusal', async () => {
    const long = `1; ${'x'.repeat(400)}`
    const { ctx } = await setup({ judge: { mode: 'always' } }, true, judgeTool({ [long]: 0.93 }))
    const result = await run(ctx, 'bash', { command: long })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('…')
  })
})
