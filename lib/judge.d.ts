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
    readonly tool: string;
    /** The yes/no question asked about each flagged command. */
    readonly question: string;
    /** Model id passed through to the judge tool; undefined uses the tool's default. */
    readonly model: string | undefined;
    /** Probability at or above which the command counts as an edit. */
    readonly denyAt: number;
    /** Probability at or below which the command counts as read-only. */
    readonly allowAt: number;
    /** Bound on one judge call, in milliseconds. */
    readonly timeoutMs: number;
    /** Distinct commands whose verdict stays cached. */
    readonly cacheSize: number;
}
/** What the judge made of one command. */
export type JudgeVerdict = 'edit' | 'read-only' | 'unsure';
/** One judge answer, with the probability that produced it. */
export interface JudgeOutcome {
    /** Thresholded verdict. */
    readonly verdict: JudgeVerdict;
    /** Probability that the command edits files by hand, from 0 to 1. */
    readonly probability: number;
    /** Model that answered, as reported by the judge tool. */
    readonly model: string;
}
/** Arguments for one judge call, in the `jev_decide` tool's own vocabulary. */
export declare function judgeArguments(command: string, options: JudgeOptions): Record<string, unknown>;
/**
 * The probability inside a `jev_decide` result value: a Noul answer carries the
 * yes-probability as `answer`, and any other type is not this plugin's question.
 *
 * @param value - the judge tool's canonical result value.
 * @returns the clamped probability, or undefined when the value is not a Noul answer.
 */
export declare function probabilityFrom(value: unknown): number | undefined;
/** The model named by the judge tool's value, falling back to what the row asked for. */
export declare function modelFrom(value: unknown, fallback: string): string;
/** Threshold one probability into the verdict the plugin acts on. */
export declare function verdictFor(probability: number, options: JudgeOptions): JudgeVerdict;
/** Per-command verdict cache with a fixed capacity, oldest entry evicted first. */
export declare class VerdictCache {
    private readonly capacity;
    private readonly entries;
    /**
     * @param capacity - how many distinct commands stay cached; at least one.
     */
    constructor(capacity: number);
    /**
     * @param command - the command text the verdict was asked about.
     * @returns the cached outcome, or undefined when it was never judged.
     */
    get(command: string): JudgeOutcome | undefined;
    /**
     * @param command - the command text the verdict was asked about.
     * @param outcome - the verdict to remember.
     */
    set(command: string, outcome: JudgeOutcome): void;
}
