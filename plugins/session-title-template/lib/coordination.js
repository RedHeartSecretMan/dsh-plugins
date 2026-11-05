/** Register the current-session tools and the main-agent naming coordination. */
import { registerRenameTool } from './rename.js';

export async function registerCoordination(ctx, { config, state, forcedRefreshes, lifetime, providerId }) {
  const fibers = [];
  fibers.push(ctx.inject?.(['tools'], async (toolCtx) => {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');
    if (lifetime.signal.aborted) return;
    registerRenameTool(toolCtx, defineTool, async (session, signal) => {
      const id = String(session.id);
      forcedRefreshes.add(id);
      try { return await ctx.sessionTitle.refresh(session, signal); }
      finally { forcedRefreshes.delete(id); }
    });
  }));
  if (config.agentsInstructions.enabled) {
    fibers.push(ctx.inject?.(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: `${providerId}:coordination`,
        order: promptCtx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 1,
        interpolate: false,
        text: 'Automatic session naming is managed by session-title-template. Do not call a session rename tool merely to satisfy standing session-naming rules in AGENTS.md; the title provider reads applicable naming excerpts itself. When the user explicitly asks to rename the session, call rename_current_session with the complete title and report the accepted result; do not ask the user to edit the GUI when this tool is available. Continue to follow all other applicable workspace instructions.',
      });
    }));
  }
  await Promise.all(fibers.filter(Boolean));
}
