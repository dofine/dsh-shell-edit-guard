/**
 * The judge policy behind `dsh-shell-edit-guard`: one Noul question per flagged
 * command, asked through the mounted `jev_decide` tool (`dsh-jev-decide`), which
 * owns the TypeSafe endpoint, credentials, and error mapping. This module owns
 * only what belongs to the guard: the question it asks, how the tool's answer
 * turns into a verdict, and the per-command cache.
 *
 * @module @deepseek-ai/dsh-shell-edit-guard/judge
 */

/** Resolved judge configuration. */
export interface JudgeOptions {
  /** Tool that answers with a calibrated probability (default `jev_decide`). */
  readonly tool: string
  /** The yes/no question asked about each flagged command. */
  readonly question: string
  /** Model id passed through to the judge tool; undefined uses the tool's default. */
  readonly model: string | undefined
  /** Probability at or above which the command counts as an edit. */
  readonly denyAt: number
  /** Probability at or below which the command counts as read-only. */
  readonly allowAt: number
  /** Bound on one judge call, in milliseconds. */
  readonly timeoutMs: number
  /** Distinct commands whose verdict stays cached. */
  readonly cacheSize: number
}

/** What the judge made of one command. */
export type JudgeVerdict = 'edit' | 'read-only' | 'unsure'

/** One judge answer, with the probability that produced it. */
export interface JudgeOutcome {
  /** Thresholded verdict. */
  readonly verdict: JudgeVerdict
  /** Probability that the command edits files by hand, from 0 to 1. */
  readonly probability: number
  /** Model that answered, as reported by the judge tool. */
  readonly model: string
}

/** Arguments for one judge call, in the `jev_decide` tool's own vocabulary. */
export function judgeArguments(command: string, options: JudgeOptions): Record<string, unknown> {
  const args: Record<string, unknown> = { state: command, question: options.question, type: 'noul' }
  if (options.model !== undefined && options.model !== '') args.model = options.model
  return args
}

/**
 * The probability inside a `jev_decide` result value: a Noul answer carries the
 * yes-probability as `answer`, and any other type is not this plugin's question.
 *
 * @param value - the judge tool's canonical result value.
 * @returns the clamped probability, or undefined when the value is not a Noul answer.
 */
export function probabilityFrom(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { type?: unknown; answer?: unknown }
  if (record.type !== 'noul') return undefined
  if (typeof record.answer !== 'number' || Number.isNaN(record.answer)) return undefined
  return Math.min(1, Math.max(0, record.answer))
}

/** The model named by the judge tool's value, falling back to what the row asked for. */
export function modelFrom(value: unknown, fallback: string): string {
  if (typeof value !== 'object' || value === null) return fallback
  const model = (value as { model?: unknown }).model
  return typeof model === 'string' && model !== '' ? model : fallback
}

/** Threshold one probability into the verdict the plugin acts on. */
export function verdictFor(probability: number, options: JudgeOptions): JudgeVerdict {
  if (probability >= options.denyAt) return 'edit'
  if (probability <= options.allowAt) return 'read-only'
  return 'unsure'
}

/** Per-command verdict cache with a fixed capacity, oldest entry evicted first. */
export class VerdictCache {
  private readonly entries = new Map<string, JudgeOutcome>()

  /**
   * @param capacity - how many distinct commands stay cached; at least one.
   */
  constructor(private readonly capacity: number) {}

  /**
   * @param command - the command text the verdict was asked about.
   * @returns the cached outcome, or undefined when it was never judged.
   */
  get(command: string): JudgeOutcome | undefined {
    return this.entries.get(command)
  }

  /**
   * @param command - the command text the verdict was asked about.
   * @param outcome - the verdict to remember.
   */
  set(command: string, outcome: JudgeOutcome): void {
    const cap = Math.max(1, this.capacity)
    while (this.entries.size >= cap) {
      // The loop condition guarantees a non-empty map, so the first key exists.
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
    this.entries.set(command, outcome)
  }
}
