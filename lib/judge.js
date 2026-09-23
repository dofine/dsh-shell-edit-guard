/**
 * The judge policy behind `dsh-shell-edit-guard`: one Noul question per flagged
 * command, asked through the mounted `jev_decide` tool (`dsh-jev-decide`), which
 * owns the TypeSafe endpoint, credentials, and error mapping. This module owns
 * only what belongs to the guard: the question it asks, how the tool's answer
 * turns into a verdict, and the per-command cache.
 *
 * @module @deepseek-ai/dsh-shell-edit-guard/judge
 */
/** Arguments for one judge call, in the `jev_decide` tool's own vocabulary. */
export function judgeArguments(command, options) {
    const args = { state: command, question: options.question, type: 'noul' };
    if (options.model !== undefined && options.model !== '')
        args.model = options.model;
    return args;
}
/**
 * The probability inside a `jev_decide` result value: a Noul answer carries the
 * yes-probability as `answer`, and any other type is not this plugin's question.
 *
 * @param value - the judge tool's canonical result value.
 * @returns the clamped probability, or undefined when the value is not a Noul answer.
 */
export function probabilityFrom(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    if (record.type !== 'noul')
        return undefined;
    if (typeof record.answer !== 'number' || Number.isNaN(record.answer))
        return undefined;
    return Math.min(1, Math.max(0, record.answer));
}
/** The model named by the judge tool's value, falling back to what the row asked for. */
export function modelFrom(value, fallback) {
    if (typeof value !== 'object' || value === null)
        return fallback;
    const model = value.model;
    return typeof model === 'string' && model !== '' ? model : fallback;
}
/** Threshold one probability into the verdict the plugin acts on. */
export function verdictFor(probability, options) {
    if (probability >= options.denyAt)
        return 'edit';
    if (probability <= options.allowAt)
        return 'read-only';
    return 'unsure';
}
/** Per-command verdict cache with a fixed capacity, oldest entry evicted first. */
export class VerdictCache {
    capacity;
    entries = new Map();
    /**
     * @param capacity - how many distinct commands stay cached; at least one.
     */
    constructor(capacity) {
        this.capacity = capacity;
    }
    /**
     * @param command - the command text the verdict was asked about.
     * @returns the cached outcome, or undefined when it was never judged.
     */
    get(command) {
        return this.entries.get(command);
    }
    /**
     * @param command - the command text the verdict was asked about.
     * @param outcome - the verdict to remember.
     */
    set(command, outcome) {
        const cap = Math.max(1, this.capacity);
        while (this.entries.size >= cap) {
            // The loop condition guarantees a non-empty map, so the first key exists.
            const oldest = this.entries.keys().next().value;
            this.entries.delete(oldest);
        }
        this.entries.set(command, outcome);
    }
}
//# sourceMappingURL=judge.js.map