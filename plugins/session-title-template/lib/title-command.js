/**
 * `/title` command grammar and its human-readable status text.
 *
 * Pure functions only: parsing a command line and rendering a snapshot are
 * decisions a caller can test without a session, a route or a browser. The
 * registration half that touches Cordis lives in `lib/commands.js`.
 *
 * @module session-title-template/title-command
 */

/** Verbs the command accepts, in the order the help line lists them. */
const VERBS = ['status', 'refresh', 'pin', 'auto'];

/** Verb that needs no further input, used when the line carries nothing. */
const DEFAULT_VERB = 'status';

/**
 * Split a `/title` argument line into a verb and its input.
 *
 * The bare command is a status request: a person who types `/title` is asking
 * about the title, not invoking nothing.
 *
 * @param rawInput - Text after the command name.
 * @returns `{ verb }`, `{ verb, title }`, or `{ error, message }`.
 */
export function parseTitleCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (text === '') return { verb: DEFAULT_VERB };
  const space = text.search(/\s/u);
  const verb = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? '' : text.slice(space + 1).trim();
  if (!VERBS.includes(verb)) {
    return {
      error: 'unknown-verb',
      message: `未知的 /title 子命令：${verb}。可用：${VERBS.join('、')}`,
    };
  }
  if (verb !== 'pin') return { verb };
  if (rest === '') {
    return { error: 'pin-needs-title', message: '用法：/title pin <完整标题>' };
  }
  return { verb, title: rest };
}

/**
 * One actionable sentence per failure category.
 *
 * The keys are exactly the categories `describeTitleFailure` produces, so a real
 * failure always gets advice instead of the generic fallback.
 */
const FAILURE_ADVICE = {
  'invalid-title-format': '模型返回的内容不符合标题格式，可重试一次。',
  'input-budget': '输入超出 maxInputBytes 预算，可调大该值或缩短会话首条消息。',
  'stream-failure': '流式响应中断，检查端点连通性与稳定性。',
  'tool-output': '模型返回了工具调用而非标题文本，检查该端点是否被错误地当作标题模型。',
  'provider-failure': '端点返回错误，检查 provider/model 配置、凭据与网络。',
};

/**
 * Turn a failure category into advice a person can act on.
 *
 * @param failure - Snapshot failure description, or null.
 * @returns The advice sentence, or undefined when there is nothing to advise.
 */
export function formatTitleFailure(failure) {
  if (failure === null || failure === undefined) return undefined;
  const category = failure.category;
  if (typeof category !== 'string') return '上一次生成失败，类别未知。';
  return FAILURE_ADVICE[category] ?? `上一次生成失败（类别：${category}）。`;
}

/**
 * Render the status snapshot as compact plain text.
 *
 * Built-in rules and supplements are printed as separate blocks so a
 * `AGENTS.md` excerpt can never be mistaken for the whole rule set. The
 * function never receives provider text, so nothing here can leak a prompt or a
 * response.
 *
 * @param snapshot - Snapshot from `describeTitleState`.
 * @returns Multi-line status text.
 */
export function renderTitleStatus(snapshot) {
  const { summary, builtin = {}, supplemental = {}, title = {}, lastFailure, probe } = snapshot ?? {};
  const lines = [];
  lines.push(`命名规则：${summary ?? '内置规则'}`);

  const rules = [];
  if (builtin.template !== undefined) rules.push(`  标题格式    ${builtin.template}`);
  if (builtin.dateFormat !== undefined || builtin.timezone !== undefined) {
    rules.push(`  日期来源    会话创建时间 · ${builtin.dateFormat ?? ''}${builtin.dateFormat !== undefined && builtin.timezone !== undefined ? ' · ' : ''}${builtin.timezone ?? ''}`);
  }
  if (Array.isArray(builtin.types) && builtin.types.length > 0) rules.push(`  类型词表    ${builtin.types.join('、')}`);
  if (builtin.topicMaxChars !== undefined) rules.push(`  主题长度    ${builtin.topicMinChars ?? 0}—${builtin.topicMaxChars} 字宽`);
  if (rules.length > 0) lines.push('内置规则', ...rules);

  const count = supplemental.count ?? 0;
  if (count > 0) {
    lines.push(`补充规则（${count}）`);
    for (const source of supplemental.sources ?? []) lines.push(`  ${source}`);
  }

  lines.push('当前标题');
  const value = title.value;
  lines.push(typeof value === 'string' && value.trim() !== '' ? `  ${value}` : '  尚无标题');
  if (title.source !== undefined) lines.push(`  来源：${describeSource(title.source)}`);
  lines.push(`  状态：${title.pinned === true ? '已固定（自动命名不再覆盖）' : '未固定'}`);

  if (lastFailure !== null && lastFailure !== undefined) {
    const where = typeof lastFailure.route === 'string' ? `，路由 ${lastFailure.route}` : '';
    const attempt = Number.isSafeInteger(lastFailure.attempt) ? `，第 ${lastFailure.attempt} 次尝试` : '';
    lines.push(`最近失败：${lastFailure.category ?? '未知'}${where}${attempt}`);
    const advice = formatTitleFailure(lastFailure);
    if (advice !== undefined) lines.push(`  建议：${advice}`);
  }

  if (probe !== null && probe !== undefined) {
    lines.push(`探针结论：${probe.verdict === 'supported'
      ? '该端点能读到指令块，角色正常'
      : '该端点丢弃了指令块，标题指令可能未送达'}`);
  }

  return lines.join('\n');
}

/**
 * Name a title source in user terms.
 *
 * @param source - Source kind from the title snapshot.
 * @returns Human description.
 */
function describeSource(source) {
  if (source === 'user') return '手动固定';
  if (source === 'provider') return '自动生成';
  if (source === 'fallback') return '临时回退（尚未生成正式标题）';
  return String(source);
}
