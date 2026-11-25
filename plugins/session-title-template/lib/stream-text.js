/**
 * Collect text-only model output from one streamed call.
 *
 * Both the title request and the role probe need the same strict reading: text
 * blocks only, no tool calls, and a normal termination. Keeping the rule in one
 * place means a provider quirk discovered in one path also protects the other.
 *
 * @module session-title-template/stream-text
 */

/**
 * Read a streamed response and return its text.
 *
 * Text may arrive as deltas or as one completed block; a completed block wins so a
 * provider that repeats its final text is not double-counted. Tool-call output is
 * rejected outright: nothing in this plugin should ever act on a tool call.
 *
 * @param stream - Async iterable of provider chunks.
 * @param signal - Cancellation signal checked between chunks.
 * @param options - Failure labelling.
 * @param options.prefix - Message prefix identifying the calling path.
 * @returns Joined text of every text block.
 * @throws when the stream carries a tool call or ends unsuccessfully.
 */
export async function collectStreamText(stream, signal, { prefix = 'session-title-template' } = {}) {
  const blocks = new Map();
  let finish;
  for await (const chunk of stream) {
    signal.throwIfAborted();
    const index = chunk.index ?? 0;
    if (chunk.type === 'finish') { finish = chunk.reason; continue; }
    if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
      const error = new Error(`${prefix}: response must not contain tool calls`);
      error.code = 'TITLE_TOOL_OUTPUT';
      throw error;
    }
    if (chunk.type === 'block-end') {
      if (chunk.block.type === 'tool-call') {
        const error = new Error(`${prefix}: response contains a tool call`);
        error.code = 'TITLE_TOOL_OUTPUT';
        throw error;
      }
      if (!blocks.get(index)?.closed) {
        blocks.set(index, { text: chunk.block.type === 'text' ? chunk.block.text : '', closed: true });
      }
    } else if (chunk.type === 'text-delta' && !blocks.get(index)?.closed) {
      blocks.set(index, { text: (blocks.get(index)?.text ?? '') + chunk.text, closed: false });
    }
  }
  signal.throwIfAborted();
  if (finish?.kind !== 'stop') {
    // Keep the Harness failure code (for example SESSION_TITLE_TIMEOUT) so the
    // status view can classify the incident without parsing provider text.
    const error = new Error(`${prefix}: unsuccessful terminal finish (${finish?.kind ?? 'missing'})`);
    error.code = finish?.failure?.code ?? 'TITLE_STREAM_FAILED';
    throw error;
  }
  return [...blocks.values()].map(block => block.text).join(' ');
}
