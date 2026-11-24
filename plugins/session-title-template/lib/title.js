/**
 * Title formatting, parsing and prompting.
 *
 * The implementation moved to three focused modules — `title/text.js` for string
 * work, `title/format.js` for the template, and `title/prompt.js` for the model
 * instructions — because the original file mixed all three and every prompt
 * change required reading all of it. This module stays as the stable entry point
 * so existing imports and tests keep working; it will be removed in 0.2.1.
 *
 * @module session-title-template/title
 */

export {
  cleanTitleText,
  formatCjkSpacing,
  measureTopicWidth,
  normalizeTopic,
  truncateTopic,
} from './title/text.js';

export {
  buildFallbackTitle,
  compileTitlePattern,
  formatDate,
  isFormattedTitle,
  isSettledTitle,
  parseModelTitle,
  renderTitle,
} from './title/format.js';

export {
  buildSystemPrompt,
  frameMessages,
  selectContextMessages,
} from './title/prompt.js';
