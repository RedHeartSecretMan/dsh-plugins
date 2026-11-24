/**
 * The historical-maintenance tool: preview first, write only on confirmation.
 *
 * Retitling an old session is not reversible in the conversation (the previous
 * title stays in the log, but the person loses the chance to choose), so the
 * tool refuses to write without an explicit list of ids that came from a
 * preview. That is why `dryRun: false` alone is not enough.
 *
 * @module session-title-template/backfill-tool
 */

/** Tool name, matching the plugin's other `*_session_title*` vocabulary. */
const BACKFILL_TOOL_NAME = 'backfill_session_titles';

/** Describe one candidate line for the agent to show the user. */
function candidateLine(candidate) {
  const current = typeof candidate.currentTitle === 'string' && candidate.currentTitle !== ''
    ? `（当前：${candidate.currentTitle}）`
    : '';
  return `- ${candidate.id} ${candidate.reason}${current}`;
}

/**
 * Register the tool.
 *
 * @param ctx - Plugin context exposing `tools`.
 * @param deps - `plan` and `apply` callbacks over the backfill phases.
 */
export function registerBackfillTool(ctx, { plan, apply }) {
  ctx.tools.register({
    name: BACKFILL_TOOL_NAME,
    description: 'Preview and repair historical session titles. Always call with dryRun true first, show the candidates to the user, and only then call with dryRun false and the exact ids they approved. Root sessions whose title is missing or non-canonical are offered, plus the configured backfill.retitle targets; pinned titles, subagents and running sessions are never touched.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: 'true (or omitted) previews without writing; false applies to the named ids.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Exactly the session ids the user approved from a preview. Required when dryRun is false.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          dryRun: { type: 'boolean' },
          candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          updated: { type: 'array', items: { type: 'string' } },
          failed: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
        },
        required: ['dryRun', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const dryRun = args?.dryRun !== false;
      const ids = Array.isArray(args?.ids) ? args.ids.filter(id => typeof id === 'string' && id !== '') : [];
      if (dryRun) {
        const { candidates } = await plan();
        return {
          dryRun: true,
          candidates,
          text: candidates.length === 0
            ? '没有需要整理的会话标题：所有符合条件的会话都已使用规范标题。'
            : `可以整理 ${candidates.length} 个会话的标题。这些是候选，尚未修改：\n${candidates.map(candidateLine).join('\n')}\n\n确认后再以 dryRun false 和这些 id 调用本工具。`,
        };
      }
      if (ids.length === 0) {
        return {
          dryRun: false,
          candidates: [],
          updated: [],
          failed: [],
          text: '拒绝执行：未提供 ids。请先用 dryRun true 预览，再把用户确认的会话 id 传进来。',
        };
      }
      const result = await apply(ids);
      const failedText = result.failed.length === 0
        ? ''
        : `\n跳过 ${result.failed.length} 个：${result.failed.map(entry => `${entry.id}(${entry.reason})`).join('、')}`;
      return {
        dryRun: false,
        candidates: [],
        updated: result.updated,
        failed: result.failed,
        text: `已更新 ${result.updated.length} 个会话的标题${failedText}`,
      };
    },
  });
}
