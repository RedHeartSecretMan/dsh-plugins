/** Confirm persistence without presenting an ambiguous partial write as success. */
async function flushTitle(ctx, session) {
  try {
    if (await ctx.sessions.flush(session) === false) throw new Error('No durability listener');
  } catch (cause) {
    throw new Error('Title may have changed in memory, but persistence was not confirmed; inspect the current title before retrying', { cause });
  }
}

/** Register only metadata operations owned by the calling agent's live session. */
export function registerRenameTool(ctx, refresh) {
  ctx.tools.register({
    name: 'rename_current_session',
    description: 'Rename and pin the current session title only when the user explicitly asks. Follow applicable naming rules and the session creation date. The target comes from the calling agent; other sessions cannot be addressed. Use the accepted title returned by this tool when reporting success.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { title: { type: 'string', description: 'The complete requested title, including any required date/type prefix.' } },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { title: { type: 'string' }, persisted: { type: 'boolean' } },
        required: ['title', 'persisted'],
      },
      render: (_args, value) => [{ type: 'text', text: `Session title saved: ${value.title}` }],
    },
    async execute(args, exec) {
      if (!args || typeof args.title !== 'string' || !args.title.trim()
          || Object.keys(args).some(key => key !== 'title')) {
        throw new Error('rename_current_session requires only a non-empty title');
      }
      const session = exec.agent?.session;
      if (!session || ctx.sessions.get(session.id) !== session) {
        throw new Error('rename_current_session requires the calling agent’s live session');
      }
      exec.signal?.throwIfAborted();
      const previous = ctx.sessionTitle.get(session);
      const accepted = previous?.source.kind === 'user' && previous.title === args.title
        ? previous : ctx.sessionTitle.rename(session, args.title);
      // rename supersedes in-flight title generation and pins the title via the
      // official service; persistence and read-back complete the operation.
      await flushTitle(ctx, session);
      const actual = ctx.sessionTitle.get(session);
      if (actual?.title !== accepted.title || actual.source.kind !== 'user') {
        throw new Error('Title changed while saving; inspect the current title before retrying');
      }
      return { title: actual.title, persisted: true };
    },
  });
  if (refresh) ctx.tools.register({
    name: 'refresh_current_session_title',
    description: 'Regenerate the current session title only when the user explicitly asks for a new automatic title. Bypasses automatic title stability and deliberately unpins a manually set title. The target comes from the calling agent; no other session can be addressed.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, persisted: { type: 'boolean' } }, required: ['title', 'persisted'] },
      render: (_args, value) => [{ type: 'text', text: `Session title regenerated and saved: ${value.title}` }],
    },
    async execute(args, exec) {
      if (!args || Object.keys(args).length) throw new Error('refresh_current_session_title accepts no parameters');
      const session = exec.agent?.session;
      if (!session || ctx.sessions.get(session.id) !== session) throw new Error('refresh_current_session_title requires the calling agent’s live session');
      exec.signal?.throwIfAborted();
      const accepted = await refresh(session, exec.signal);
      if (!accepted) throw new Error('No eligible user message exists for title generation');
      await flushTitle(ctx, session);
      const actual = ctx.sessionTitle.get(session);
      if (actual?.eventSeq !== accepted.eventSeq || actual?.title !== accepted.title) throw new Error('Title changed while saving; inspect the current title before retrying');
      return { title: actual.title, persisted: true };
    },
  });
}

/**
 * Register a read-only tool describing why the current title looks the way it does.
 *
 * The status view is for humans and for an agent explaining a title: it reports the
 * built-in rules, how many `AGENTS.md` supplements contributed, where the current
 * title came from, and the newest failure category. It never mutates anything.
 *
 * @param ctx - Plugin context exposing `tools`, `sessions` and `sessionTitle`.
 * @param describe - Callback returning the snapshot for the calling session.
 */
export function registerDescribeTool(ctx, describe) {
  ctx.tools.register({
    name: 'describe_current_session_title',
    description: 'Describe the current session title: the built-in naming rules, how many AGENTS.md supplements contributed, where the title came from, whether it is pinned, the newest failure category, and the role-probe verdict. Read-only; never changes the title.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          summary: { type: 'string' },
          title: { type: 'object', additionalProperties: true },
          supplemental: { type: 'object', additionalProperties: true },
        },
        required: ['summary', 'title', 'supplemental'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      if (args !== undefined && args !== null && Object.keys(args).length > 0) {
        throw new Error('describe_current_session_title takes no arguments');
      }
      const session = exec.agent?.session;
      if (!session || ctx.sessions.get(session.id) !== session) {
        throw new Error('describe_current_session_title requires the calling agent’s live session');
      }
      exec.signal?.throwIfAborted();
      return describe(session);
    },
  });
}
