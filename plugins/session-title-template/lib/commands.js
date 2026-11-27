/**
 * The `/title` command: the in-session entry point for title operations.
 *
 * Commands are the Harness's own mechanism for running a user action against an
 * agent without sending a model message, and their executor is already exposed
 * to the Client (`ctx.remote.commands.execute`). Registering here is therefore
 * all this plugin needs to give the browser a way to reach the Host — no Remote
 * method of its own, and no dependency on a package a profile-installed plugin
 * cannot resolve.
 *
 * One caveat drives the UI design: the executor resolves its `agent` argument
 * through a lookup that only finds *live* agents, so a command can never act on
 * a session nobody has opened. See `docs/DESIGN-0.2.0.md`.
 *
 * @module session-title-template/commands
 */

import { parseTitleCommand, renderTitleStatus } from './title-command.js';

/** Command name without its leading slash. */
export const TITLE_COMMAND_NAME = 'title';

/**
 * Register the `/title` command.
 *
 * @param ctx - Plugin context exposing `commands`, `sessions` and `sessionTitle`.
 * @param options - Snapshot builder plus the refresh entry point.
 */
export function registerTitleCommands(ctx, { state, describe, refresh }) {
  /** Pin through the official service so the title is normalized and durable. */
  const pin = (session, title) => ctx.sessionTitle.rename(session, title);
  ctx.commands.register({
    name: TITLE_COMMAND_NAME,
    description: '查看或修改当前会话的标题：查看命名规则与来源、重新生成、固定、恢复自动命名。',
    input: { hint: 'status · refresh · auto · pin <完整标题>' },
    async handler(invocation) {
      const session = invocation.agent?.session;
      if (!session) return { kind: 'error', text: '/title 只能在会话内使用。' };
      // Commands are addressed by Session id through a lookup that only finds
      // live agents; acting on any other session would be a routing surprise.
      if (ctx.sessions.get?.(session.id) !== session) {
        return { kind: 'error', text: '/title 只能作用于当前活跃会话。' };
      }
      const parsed = parseTitleCommand(invocation.rawInput);
      if (parsed.error !== undefined) return { kind: 'error', text: parsed.message };
      try {
        return await run(parsed, session, invocation.signal, {
          describe, refresh, pin, state, sessionTitle: ctx.sessionTitle,
        });
      } catch (error) {
        // A command's failure renders in the conversation, so it must be a
        // result rather than a thrown error the executor would settle for us.
        // The executor writes this text into the durable `command/done` event,
        // so it carries a stable explanation rather than the raw error message:
        // provider messages can contain prompt fragments or credentials, and the
        // rest of this plugin keeps those out of the log. The category goes to
        // the diagnostic sink, where it is a field instead of prose.
        const category = error?.code ?? error?.name ?? 'Error';
        const safe = typeof category === 'string' && /^[A-Za-z0-9_.-]+$/u.test(category)
          ? category
          : 'Error';
        state.record({ kind: 'title-command-failed', verb: parsed.verb, category: safe });
        return { kind: 'error', text: `/title ${parsed.verb} 失败（类别：${safe}）。详情见诊断日志。` };
      }
    },
  });
}

/**
 * Carry out one parsed verb.
 *
 * @param parsed - Result of `parseTitleCommand`.
 * @param session - The invoking agent's live session.
 * @param signal - Caller cancellation.
 * @param deps - Injected collaborators.
 * @returns A command result.
 */
async function run(parsed, session, signal, deps) {
  const { describe, refresh, pin } = deps;
  if (parsed.verb === 'status') {
    const snapshot = await describe(session);
    return { kind: 'success', text: renderTitleStatus(snapshot) };
  }
  if (parsed.verb === 'pin') {
    const accepted = pin(session, parsed.title);
    // Read the live title back: a write that was accepted into memory but not
    // reflected in the service is not a success worth claiming.
    const actual = deps.sessionTitle.get(session);
    if (actual === undefined || actual.title !== accepted.title || actual.source?.kind !== 'user') {
      return { kind: 'error', text: '标题未按预期固定，请检查当前标题后重试。' };
    }
    return {
      kind: 'success',
      text: `会话标题已固定：${actual.title}\n自动命名不再覆盖。用 /title auto 恢复自动命名。`,
    };
  }
  // refresh and auto both regenerate; auto exists so the intent is explicit.
  const title = await refresh(session, signal);
  if (title === undefined) {
    return { kind: 'error', text: '会话还没有可用于生成标题的用户消息。' };
  }
  if (parsed.verb === 'auto') {
    return { kind: 'success', text: `已恢复自动命名，新标题：${title.title}` };
  }
  return { kind: 'success', text: `会话标题已重新生成：${title.title}` };
}
