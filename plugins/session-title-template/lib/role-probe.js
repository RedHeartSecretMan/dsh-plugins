/**
 * Instruction-role probe: verify that a title instruction actually reaches the model.
 *
 * The Harness decides whether an instruction block travels as `system` or
 * `developer`, and some OpenAI-compatible endpoints silently drop the latter.
 * That failure is invisible at the HTTP layer: the request succeeds and the reply
 * is simply unrelated. This probe sends a tiny instruction that demands one exact
 * token, so a missing instruction is unambiguous.
 *
 * Observation only: the verdict is cached and logged. It never rewrites the
 * user's profile and never changes a request route.
 *
 * @module session-title-template/role-probe
 */

import { randomUUID } from 'node:crypto';
import { collectStreamText } from './stream-text.js';

/** Exact token the model must echo when it can read the instruction. */
export const PROBE_TOKEN = 'PROBE_7F3A';

/** Give up after this many inconclusive attempts so a flaky link cannot keep costing calls. */
const MAX_UNKNOWN_ATTEMPTS = 3;

/** Cap the probe deadline even when the configured title timeout is generous. */
const PROBE_TIMEOUT_CEILING_MS = 15_000;

/** Asterisk emphasis wrapping a whole line, such as `**PROBE_7F3A**`. */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u;

/**
 * Cache key for one route. Provider and model both matter: the same model id can
 * be served by endpoints with different role support.
 *
 * @param route - Resolved provider/model pair.
 * @returns Stable string key, or undefined when the route is incomplete.
 */
export function probeKey(route) {
  if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') return undefined;
  return `${route.provider}\u0000${route.model}`;
}

/**
 * Report whether a probe reply is exactly the demanded token.
 *
 * A model that can read the instruction echoes it on the first line; a model that
 * cannot answers something unrelated. Bounded tolerance keeps the check stable
 * against formatting noise without accepting an unrelated reply:
 *
 * - leading whitespace and Markdown emphasis wrapping the token are ignored;
 * - only the first non-empty line is judged, so commentary after a correct answer
 *   does not turn a readable instruction into a failure;
 * - a reply that prefixes or surrounds the token with words fails, because that
 *   means the instruction was a suggestion rather than a command.
 *
 * @param text - Collected reply text.
 * @returns `true` when the first non-empty line is the probe token.
 */
export function isProbeMatch(text) {
  const line = String(text ?? '').split(/\r?\n/u).map(item => item.trim()).find(item => item.length > 0) ?? '';
  if (line === '') return false;
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups;
  const marker = groups?.marker;
  const inner = groups?.inner;
  const candidate = marker === undefined || inner === undefined || inner.includes(marker) ? line : inner;
  return candidate.trim() === PROBE_TOKEN;
}


/**
 * Create the probe used by one plugin activation.
 *
 * At most one probe per route runs at a time, a final verdict is reused for the
 * rest of the activation, and repeated inconclusive runs stop after
 * {@link MAX_UNKNOWN_ATTEMPTS} so a broken link stays cheap.
 *
 * @param options - Injection points and policy.
 * @param options.ctx - Plugin context exposing the `llm` service.
 * @param options.config - Resolved plugin config.
 * @param options.note - Diagnostic sink; receives one line per settled verdict.
 * @param options.signal - Plugin lifetime signal.
 * @returns Probe API with `ensure`, `verdictOf` and `drained`.
 */
export function createRoleProbe({ ctx, config, note, onVerdict, signal }) {
  const verdicts = new Map();
  const checkedAt = new Map();
  const inflight = new Map();
  const inconclusive = new Map();

  const run = async (route, request) => {
    const timeout = new AbortController();
    const deadline = Math.min(config.timeoutMs, PROBE_TIMEOUT_CEILING_MS);
    const timer = setTimeout(() => timeout.abort(new Error('session-title-template: role probe timed out')), deadline);
    timer.unref?.();
    const combined = AbortSignal.any([signal, timeout.signal, ...(request?.signal ? [request.signal] : [])]);
    try {
      combined.throwIfAborted();
      const call = await ctx.llm.prepareCall({ ...route, maxTokens: 32 }, combined, (controls, model) => {
        const effort = model.reasoning?.efforts?.[0]?.id;
        return { ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
      });
      const messages = [{
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 'Follow the instruction above.' }],
        source: { kind: 'dsh-session-title-llm' },
      }];
      const options = {
        ...call.config,
        messages,
        system: `Reply with exactly ${PROBE_TOKEN} and nothing else. Do not explain, translate or add punctuation.`,
        sessionId: request?.session?.id,
        purpose: 'session-title-role-probe',
        signal: combined,
      };
      const reply = await collectStreamText(call.stream(options), combined, { prefix: 'session-title-template: probe' });
      return isProbeMatch(reply) ? 'supported' : 'unsupported';
    } catch (error) {
      signal.throwIfAborted();
      // Transport trouble says nothing about role support: keep the route undecided.
      if (error?.name === 'AbortError' || timeout.signal.aborted || request?.signal?.aborted) return 'unknown';
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    /**
     * Start a probe for one route unless a verdict or a run already exists.
     *
     * Callers start observation and read the answer separately: this returns the
     * outcome as a convenience for tests and the status path, but a title call
     * that only wants the side effect detaches it.
     *
     * @param route - Resolved provider/model pair.
     * @param request - Optional title request supplying a session and cancellation.
     * @returns `supported`, `unsupported`, `unknown`, or undefined when disabled.
     */
    async ensure(route, request) {
      if (!config.roleProbe.enabled) return undefined;
      const key = probeKey(route);
      if (key === undefined) return undefined;
      const known = verdicts.get(key);
      if (known !== undefined) return known;
      const running = inflight.get(key);
      if (running !== undefined) return running;
      const attempts = inconclusive.get(key) ?? 0;
      if (attempts >= MAX_UNKNOWN_ATTEMPTS) return 'unknown';
      const work = (async () => {
        const result = await run(route, request);
        if (result === 'unknown') {
          const next = (inconclusive.get(key) ?? 0) + 1;
          inconclusive.set(key, next);
          note(`role-probe route=${route.provider}/${route.model} result=unknown attempt=${next}`);
          return 'unknown';
        }
        verdicts.set(key, result);
        checkedAt.set(key, Date.now());
        note(`role-probe route=${route.provider}/${route.model} result=${result}`);
        // Carry the session so the diagnostic record can be attributed: a
        // verdict reached while naming one session must not explain another's
        // status view.
        const sessionId = request?.session?.id;
        try {
          onVerdict?.({
            provider: route.provider,
            model: route.model,
            verdict: result,
            ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }),
          });
        } catch { /* diagnostics never fail naming */ }
        return result;
      })().finally(() => { inflight.delete(key); });
      inflight.set(key, work);
      return work;
    },

    /**
     * Read the settled verdict together with when it was established.
     *
     * @param route - Resolved provider/model pair.
     * @returns Verdict and timestamp, or undefined when not settled.
     */
    verdictOf(route) {
      const key = probeKey(route);
      const verdict = key === undefined ? undefined : verdicts.get(key);
      return verdict === undefined ? undefined : { verdict, checkedAt: checkedAt.get(key) };
    },

    /**
     * Wait for every in-flight probe.
     *
     * The owner must call this before aborting the plugin lifetime: aborting
     * first cancels the probes, so a settled verdict is never logged.
     */
    async drained() {
      for (;;) {
        const pending = [...inflight.values()];
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
  };
}
