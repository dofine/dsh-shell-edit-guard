/**
 * Real-composition coverage: boot a test-only `cordis.yml` through the shipped
 * Loader and drive one refusal through the loaded tool registry, so the plugin
 * proves it activates from configuration rather than from a hand-built context.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as ShellEditGuard from 'dsh-shell-edit-guard'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A command tool that records the commands the loaded composition allowed. */
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

/** A mutator stand-in: the guard only refuses once an editor tool is reachable. */
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

describe('loader composition', () => {
  it('loads the guard from cordis.yml with its row configuration', async () => {
    root = await mkdtemp(join(tmpdir(), 'shell-edit-guard-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: 'dsh-shell-edit-guard'",
      '  config:',
      '    extraPatterns: ["rm -rf /"]',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['dsh-shell-edit-guard', ShellEditGuard],
    ])
    context.loader.internal = {
      version: 'v2',
      import(specifier: string) {
        const found = modules.get(specifier)
        if (found === undefined) return Promise.reject(new Error(`unexpected Loader import: ${specifier}`))
        return Promise.resolve(found)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const ran: string[] = []
    context.tools.register(commandTool('bash', ran))
    context.tools.register(mutator('edit'))
    context.tools.register(mutator('write'))
    const signal = new AbortController().signal
    const execute = (id: string, command: string) => context!.tools.execute({
      signal,
      callId: ToolCallId(id),
      name: 'bash',
      arguments: { command },
    })

    // The row's own extraPatterns reached the mounted plugin.
    const configured = await execute('configured', 'rm -rf /')
    expect(configured.isError).toBe(true)
    // The built-in rules are live in the same composition.
    const refused = await execute('refused', "sed -i 's/a/b/' src/file.ts")
    expect(refused.isError).toBe(true)
    expect(ran).toEqual([])
    // requireEditorTool defaults to true, so nothing was refused above it here.
    const allowed = await execute('allowed', 'pnpm run build')
    expect(allowed.isError).toBe(false)
    expect(ran).toEqual(['pnpm run build'])
  })
})
