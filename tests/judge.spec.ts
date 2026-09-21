/**
 * Judge policy coverage: the arguments this plugin hands the judge tool, how a
 * Noul answer becomes a verdict, and the per-command cache. The tool call itself
 * is covered by `plugin.spec.ts`, which registers a judge fixture against the
 * real registry.
 */

import { describe, expect, it } from 'vitest'
import { VerdictCache, judgeArguments, modelFrom, probabilityFrom, verdictFor } from '../src/judge.ts'
import type { JudgeOptions } from '../src/judge.ts'

function options(overrides: Partial<JudgeOptions> = {}): JudgeOptions {
  return {
    tool: 'jev_decide',
    question: 'Does this edit files?',
    model: undefined,
    denyAt: 0.8,
    allowAt: 0.2,
    timeoutMs: 2000,
    cacheSize: 2,
    ...overrides,
  }
}

describe('judge arguments', () => {
  it('asks one noul question about the command', () => {
    expect(judgeArguments('sed -i x y.ts', options())).toEqual({
      state: 'sed -i x y.ts',
      question: 'Does this edit files?',
      type: 'noul',
    })
  })

  it('passes a model through only when the row names one', () => {
    expect(judgeArguments('x', options({ model: 'jev-latest' }))).toMatchObject({ model: 'jev-latest' })
    expect(judgeArguments('x', options({ model: '' }))).not.toHaveProperty('model')
  })
})

describe('reading a judge answer', () => {
  it('takes the probability from a noul answer and clamps it', () => {
    expect(probabilityFrom({ type: 'noul', answer: 0.7 })).toBe(0.7)
    expect(probabilityFrom({ type: 'noul', answer: 1.4 })).toBe(1)
    expect(probabilityFrom({ type: 'noul', answer: -0.3 })).toBe(0)
  })

  it('rejects anything that is not a noul probability', () => {
    expect(probabilityFrom(undefined)).toBeUndefined()
    expect(probabilityFrom(null)).toBeUndefined()
    expect(probabilityFrom('noul')).toBeUndefined()
    expect(probabilityFrom({ type: 'choice', answer: 'billing' })).toBeUndefined()
    expect(probabilityFrom({ type: 'noul', answer: 'yes' })).toBeUndefined()
    expect(probabilityFrom({ type: 'noul', answer: Number.NaN })).toBeUndefined()
  })

  it('names the answering model, falling back to the requested one', () => {
    expect(modelFrom({ model: 'jev-1.13.0' }, 'fallback')).toBe('jev-1.13.0')
    expect(modelFrom({ model: '' }, 'fallback')).toBe('fallback')
    expect(modelFrom({ model: 7 }, 'fallback')).toBe('fallback')
    expect(modelFrom(undefined, 'fallback')).toBe('fallback')
  })
})

describe('thresholds', () => {
  it('splits an edit, an unsure band, and a read-only verdict', () => {
    const judge = options()
    expect(verdictFor(0.95, judge)).toBe('edit')
    expect(verdictFor(0.8, judge)).toBe('edit')
    expect(verdictFor(0.5, judge)).toBe('unsure')
    expect(verdictFor(0.2, judge)).toBe('read-only')
    expect(verdictFor(0.01, judge)).toBe('read-only')
  })
})

describe('verdict cache', () => {
  it('answers a repeated command from the cache', () => {
    const cache = new VerdictCache(2)
    expect(cache.get('a')).toBeUndefined()
    cache.set('a', { verdict: 'edit', probability: 0.9, model: 'm' })
    expect(cache.get('a')).toEqual({ verdict: 'edit', probability: 0.9, model: 'm' })
  })

  it('evicts the oldest command past its capacity', () => {
    const cache = new VerdictCache(2)
    cache.set('a', { verdict: 'edit', probability: 0.9, model: 'm' })
    cache.set('b', { verdict: 'read-only', probability: 0.1, model: 'm' })
    cache.set('c', { verdict: 'unsure', probability: 0.5, model: 'm' })
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('keeps at least one entry when the row asks for none', () => {
    const cache = new VerdictCache(0)
    cache.set('a', { verdict: 'edit', probability: 0.9, model: 'm' })
    expect(cache.get('a')).toBeDefined()
  })
})
