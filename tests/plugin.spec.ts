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
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
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

/** Mount the tool registry, the fixtures, and the guard under test. */
async function setup(options?: ShellEditGuard.Config, editors = true) {
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
