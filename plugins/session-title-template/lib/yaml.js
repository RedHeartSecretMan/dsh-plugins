/**
 * Minimal, zero-dependency YAML 1.2 subset parser and canonical serializer for
 * plugin configuration documents.
 *
 * Covers the complete configuration grammar a developer uses in `cordis.patch.yml`
 * (`config` mappings, nested objects, block and flow sequences/mappings, single-
 * and double-quoted strings, block scalars `|`/`>`, booleans, numbers, null,
 * comments) while rejecting unsupported exotic YAML features (anchors, aliases,
 * tags, multi-document streams, tab indentation) with line-numbered errors.
 *
 * @module session-title-template/yaml
 */

/** Plain scalar patterns that YAML 1.2 (and 1.1 tools) treat as non-string values. */
const RESERVED_WORD_RE = /^(?:null|~|true|false|yes|no|on|off|\.inf|[+-]\.inf|\.nan)$/iu;
const NUMBER_RE = /^[+-]?(?:0x[0-9a-f]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/u;
const SAFE_PLAIN_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const SPECIAL_START_RE = /^[-?:,[\]{}#&*!|>'"%@`]/u;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function yamlError(line, message) {
  const error = new Error(line > 0 ? `YAML syntax error on line ${line}: ${message}` : `YAML syntax error: ${message}`);
  error.code = 'invalid-yaml';
  if (line > 0) error.line = line;
  return error;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decide whether a string can be emitted unquoted without ambiguity. */
function isSafePlainString(value) {
  if (value.length === 0) return false;
  if (/^\s|\s$/u.test(value)) return false;
  if (CONTROL_CHAR_RE.test(value)) return false;
  if (SPECIAL_START_RE.test(value)) return false;
  if (RESERVED_WORD_RE.test(value) || NUMBER_RE.test(value)) return false;
  if (value.includes(': ') || value.endsWith(':') || value.includes(' #')) return false;
  if (/[[\]{},]/u.test(value)) return false;
  return true;
}

/** Format one YAML scalar string, preferring readable plain or single-quoted form. */
function formatString(value) {
  if (isSafePlainString(value)) return value;
  if (!CONTROL_CHAR_RE.test(value) && !value.includes("'")) {
    return `'${value}'`;
  }
  return JSON.stringify(value);
}

function formatKey(key) {
  if (SAFE_PLAIN_KEY_RE.test(key) && !RESERVED_WORD_RE.test(key)) return key;
  return formatString(key);
}

function formatScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('session-title-template: YAML cannot represent non-finite numbers');
    return String(value);
  }
  if (typeof value === 'string') return formatString(value);
  throw new Error(`session-title-template: unsupported YAML value type ${typeof value}`);
}

function definedEntries(obj) {
  return Object.entries(obj).filter(([, value]) => value !== undefined);
}

function isInlineValue(value) {
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.length === 0;
  return definedEntries(value).length === 0;
}

function formatInline(value) {
  if (Array.isArray(value)) return '[]';
  if (isPlainObject(value)) return '{}';
  return formatScalar(value);
}

function formatBlock(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    const lines = [];
    for (const item of value) {
      if (isInlineValue(item)) {
        lines.push(`${pad}- ${formatInline(item)}`);
      } else if (isPlainObject(item)) {
        const entries = definedEntries(item);
        const [firstKey, firstVal] = entries[0];
        if (isInlineValue(firstVal)) {
          lines.push(`${pad}- ${formatKey(firstKey)}: ${formatInline(firstVal)}`);
        } else {
          lines.push(`${pad}- ${formatKey(firstKey)}:`);
          lines.push(formatBlock(firstVal, indent + 4));
        }
        for (let i = 1; i < entries.length; i += 1) {
          const [key, entryVal] = entries[i];
          if (isInlineValue(entryVal)) {
            lines.push(`${pad}  ${formatKey(key)}: ${formatInline(entryVal)}`);
          } else {
            lines.push(`${pad}  ${formatKey(key)}:`);
            lines.push(formatBlock(entryVal, indent + 4));
          }
        }
      } else {
        // Nested non-empty array.
        lines.push(`${pad}-`);
        lines.push(formatBlock(item, indent + 2));
      }
    }
    return lines.join('\n');
  }
  if (isPlainObject(value)) {
    const entries = definedEntries(value);
    if (entries.length === 0) return `${pad}{}`;
    const lines = [];
    for (const [key, entryVal] of entries) {
      if (isInlineValue(entryVal)) {
        lines.push(`${pad}${formatKey(key)}: ${formatInline(entryVal)}`);
      } else {
        lines.push(`${pad}${formatKey(key)}:`);
        lines.push(formatBlock(entryVal, indent + 2));
      }
    }
    return lines.join('\n');
  }
  return `${pad}${formatScalar(value)}`;
}

/**
 * Serialize a plain configuration value into clean, 2-space indented YAML.
 *
 * @param value - Plain object, array, or scalar (keys with `undefined` values are omitted).
 * @returns Canonical YAML string ending with a trailing newline.
 */
export function formatConfigYaml(value) {
  if (value === undefined) return '{}\n';
  return `${formatBlock(value, 0)}\n`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Strip an inline `#` comment that appears outside quotes. */
function stripInlineComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") { i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

/** Parse a single-quoted YAML string starting at `pos` inside `text`. */
function readSingleQuoted(text, pos, line) {
  let out = '';
  let i = pos + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    out += ch;
    i += 1;
  }
  throw yamlError(line, 'unterminated single-quoted string');
}

/** Parse a double-quoted YAML string starting at `pos` inside `text`. */
function readDoubleQuoted(text, pos, line) {
  let out = '';
  let i = pos + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === '\\') {
      i += 1;
      if (i >= text.length) throw yamlError(line, 'unterminated escape sequence in double-quoted string');
      const esc = text[i];
      switch (esc) {
        case '"': out += '"'; i += 1; break;
        case '\\': out += '\\'; i += 1; break;
        case '/': out += '/'; i += 1; break;
        case '0': out += '\0'; i += 1; break;
        case 'b': out += '\b'; i += 1; break;
        case 'f': out += '\f'; i += 1; break;
        case 'n': out += '\n'; i += 1; break;
        case 'r': out += '\r'; i += 1; break;
        case 't': out += '\t'; i += 1; break;
        case ' ': out += ' '; i += 1; break;
        case 'x': {
          const hex = text.slice(i + 1, i + 3);
          if (!/^[0-9a-fA-F]{2}$/u.test(hex)) throw yamlError(line, `invalid \\x escape "\\x${hex}"`);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 3;
          break;
        }
        case 'u': {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw yamlError(line, `invalid \\u escape "\\u${hex}"`);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          break;
        }
        case 'U': {
          const hex = text.slice(i + 1, i + 9);
          if (!/^[0-9a-fA-F]{8}$/u.test(hex)) throw yamlError(line, `invalid \\U escape "\\U${hex}"`);
          const codePoint = parseInt(hex, 16);
          if (codePoint > 0x10ffff) throw yamlError(line, `code point out of range "\\U${hex}"`);
          out += String.fromCodePoint(codePoint);
          i += 9;
          break;
        }
        default:
          throw yamlError(line, `unsupported escape sequence "\\${esc}"`);
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  throw yamlError(line, 'unterminated double-quoted string');
}

/** Reject YAML anchors, aliases, and custom tags explicitly instead of misparsing them. */
function rejectUnsupportedPrefix(trimmed, line) {
  if (trimmed.startsWith('&') || trimmed.startsWith('*') || trimmed.startsWith('!')) {
    throw yamlError(line, 'YAML anchors, aliases, and tags are not supported');
  }
}

/** Parse a plain (unquoted) YAML 1.2 scalar. */
function parsePlainScalar(raw, line) {
  const value = raw.trim();
  if (value === '' || value === 'null' || value === 'Null' || value === 'NULL' || value === '~') return null;
  if (value === 'true' || value === 'True' || value === 'TRUE') return true;
  if (value === 'false' || value === 'False' || value === 'FALSE') return false;
  rejectUnsupportedPrefix(value, line);
  if (/^[+-]?\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (/^0x[0-9a-fA-F]+$/u.test(value)) {
    const parsed = parseInt(value.slice(2), 16);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (/^0o[0-7]+$/u.test(value)) {
    const parsed = parseInt(value.slice(2), 8);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (/^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value) || /^[+-]?\d+[eE][+-]?\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

/** Parse a single-line flow expression (`[...]`, `{...}`, quoted, or plain scalar). */
function parseFlowCollection(source, startLine) {
  let index = 0;
  let line = startLine;

  const skipSpaceAndComments = () => {
    while (index < source.length) {
      const ch = source[index];
      if (ch === ' ' || ch === '\t' || ch === '\r') { index += 1; continue; }
      if (ch === '\n') { index += 1; line += 1; continue; }
      if (ch === '#') {
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      break;
    }
  };

  const parseValue = () => {
    skipSpaceAndComments();
    if (index >= source.length) throw yamlError(line, 'unexpected end of flow collection');
    const ch = source[index];
    if (ch === '[') return parseArray();
    if (ch === '{') return parseObject();
    if (ch === "'") {
      const result = readSingleQuoted(source, index, line);
      for (let i = index; i < result.end; i += 1) if (source[i] === '\n') line += 1;
      index = result.end;
      return result.value;
    }
    if (ch === '"') {
      const result = readDoubleQuoted(source, index, line);
      for (let i = index; i < result.end; i += 1) if (source[i] === '\n') line += 1;
      index = result.end;
      return result.value;
    }
    const tokenLine = line;
    const start = index;
    while (index < source.length) {
      const cur = source[index];
      if (cur === ',' || cur === ']' || cur === '}' || cur === '\n') break;
      if (cur === ':' && (index + 1 >= source.length || /[\s,\]{}]/u.test(source[index + 1]))) break;
      if (cur === '#' && index > start && (source[index - 1] === ' ' || source[index - 1] === '\t')) break;
      index += 1;
    }
    const raw = source.slice(start, index).trim();
    if (raw.length === 0) throw yamlError(tokenLine, 'expected a value');
    return parsePlainScalar(raw, tokenLine);
  };

  const parseArray = () => {
    const openLine = line;
    index += 1; // consume '['
    const items = [];
    skipSpaceAndComments();
    if (index < source.length && source[index] === ']') {
      index += 1;
      return items;
    }
    while (index < source.length) {
      items.push(parseValue());
      skipSpaceAndComments();
      if (index < source.length && source[index] === ',') {
        index += 1;
        skipSpaceAndComments();
        if (index < source.length && source[index] === ']') {
          index += 1;
          return items;
        }
        continue;
      }
      if (index < source.length && source[index] === ']') {
        index += 1;
        return items;
      }
      throw yamlError(line, 'expected "," or "]" in flow sequence');
    }
    throw yamlError(openLine, 'unterminated flow sequence "["');
  };

  const parseObject = () => {
    const openLine = line;
    index += 1; // consume '{'
    const map = {};
    skipSpaceAndComments();
    if (index < source.length && source[index] === '}') {
      index += 1;
      return map;
    }
    while (index < source.length) {
      skipSpaceAndComments();
      const keyLine = line;
      let key;
      if (source[index] === "'") {
        const res = readSingleQuoted(source, index, line);
        key = res.value;
        index = res.end;
      } else if (source[index] === '"') {
        const res = readDoubleQuoted(source, index, line);
        key = res.value;
        index = res.end;
      } else {
        const start = index;
        while (index < source.length && source[index] !== ':' && source[index] !== '}' && source[index] !== ',' && source[index] !== '\n') {
          index += 1;
        }
        key = source.slice(start, index).trim();
        if (key.length === 0) throw yamlError(keyLine, 'expected mapping key in flow object');
        rejectUnsupportedPrefix(key, keyLine);
      }
      if (key === '<<') throw yamlError(keyLine, 'YAML merge key "<<" is not supported');
      if (Object.hasOwn(map, key)) throw yamlError(keyLine, `duplicate key "${key}"`);
      skipSpaceAndComments();
      if (source[index] !== ':') throw yamlError(keyLine, `expected ":" after key "${key}"`);
      index += 1; // consume ':'
      skipSpaceAndComments();
      if (source[index] === ',' || source[index] === '}') {
        map[key] = null;
      } else {
        map[key] = parseValue();
      }
      skipSpaceAndComments();
      if (index < source.length && source[index] === ',') {
        index += 1;
        skipSpaceAndComments();
        if (index < source.length && source[index] === '}') {
          index += 1;
          return map;
        }
        continue;
      }
      if (index < source.length && source[index] === '}') {
        index += 1;
        return map;
      }
      throw yamlError(line, 'expected "," or "}" in flow mapping');
    }
    throw yamlError(openLine, 'unterminated flow mapping "{"');
  };

  const value = parseValue();
  skipSpaceAndComments();
  if (index < source.length) {
    throw yamlError(line, `unexpected trailing content "${source.slice(index).trim()}"`);
  }
  return value;
}

/**
 * Find the mapping `:` separator on a line when the line represents `key: value`.
 * Returns `{ key, rest }` or `null` if the line is not a key-value entry.
 */
function splitMappingLine(content, line) {
  if (content.length === 0) return null;
  if (content[0] === "'" || content[0] === '"') {
    const res = content[0] === "'"
      ? readSingleQuoted(content, 0, line)
      : readDoubleQuoted(content, 0, line);
    let i = res.end;
    while (i < content.length && content[i] === ' ') i += 1;
    if (content[i] !== ':') return null;
    if (i + 1 < content.length && content[i + 1] !== ' ' && content[i + 1] !== '\t') return null;
    return { key: res.value, rest: content.slice(i + 1).trimStart() };
  }
  if (content[0] === '[' || content[0] === '{') return null;
  // Scan for unquoted `:` followed by whitespace or end-of-line.
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '#' && (i === 0 || content[i - 1] === ' ' || content[i - 1] === '\t')) return null;
    if (ch === ':' && (i + 1 === content.length || content[i + 1] === ' ' || content[i + 1] === '\t')) {
      const key = content.slice(0, i).trim();
      if (key.length === 0) throw yamlError(line, 'mapping key cannot be empty');
      rejectUnsupportedPrefix(key, line);
      return { key, rest: content.slice(i + 1).trimStart() };
    }
  }
  return null;
}

/** Count unclosed flow brackets `[` / `{` on a line segment outside quotes and comments. */
function flowBracketDelta(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") { if (text[i + 1] === "'") { i += 1; continue; } quote = null; }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) break;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
  }
  return depth;
}

/** Check whether a trimmed value starts a block scalar (`|`, `>`, `|-`, `>+`, `|2`, etc.). */
function parseBlockScalarHeader(text, line) {
  const match = /^([|>])([+-]?)([1-9]?)([+-]?)$/u.exec(text);
  if (!match) return null;
  const style = match[1];
  const chomp = match[2] || match[4] || '';
  if (match[2] && match[4]) throw yamlError(line, `invalid block scalar header "${text}"`);
  const explicitIndent = match[3] ? Number(match[3]) : undefined;
  return { style, chomp, explicitIndent };
}

/**
 * Parse a YAML configuration string into plain JavaScript data.
 *
 * Empty or comment-only input returns `{}`.
 *
 * @param text - UTF-8 YAML document text.
 * @returns Parsed value (typically a plain object for configuration files).
 * @throws An Error with `code = 'invalid-yaml'` when the syntax is invalid or uses unsupported features.
 */
export function parseConfigYaml(text) {
  if (typeof text !== 'string') throw yamlError(0, 'input must be a string');
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const rawLines = normalized.split('\n');

  const lines = rawLines.map((raw, idx) => {
    const lineNo = idx + 1;
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent += 1;
    if (raw[indent] === '\t') {
      const rest = raw.slice(indent).trim();
      if (rest.length > 0 && !rest.startsWith('#')) {
        throw yamlError(lineNo, 'tabs are not allowed for indentation');
      }
    }
    const body = raw.slice(indent);
    const trimmed = body.trim();
    const blank = trimmed.length === 0 || trimmed.startsWith('#');
    return { raw, lineNo, indent, body, blank };
  });

  let pos = 0;
  let seenDocStart = false;
  let startedDoc = false;

  const skipIgnorable = () => {
    while (pos < lines.length) {
      const cur = lines[pos];
      if (cur.blank) { pos += 1; continue; }
      if (cur.indent === 0 && (cur.body === '---' || /^---\s*(?:#.*)?$/u.test(cur.body))) {
        if (seenDocStart || startedDoc) throw yamlError(cur.lineNo, 'multiple YAML documents are not supported');
        seenDocStart = true;
        pos += 1;
        continue;
      }
      if (cur.indent === 0 && (cur.body === '...' || /^\.\.\.\s*(?:#.*)?$/u.test(cur.body))) {
        pos += 1;
        while (pos < lines.length) {
          if (!lines[pos].blank) throw yamlError(lines[pos].lineNo, 'unexpected content after document end marker "..."');
          pos += 1;
        }
        return;
      }
      break;
    }
  };

  /** Collect a multiline flow collection starting with `firstChunk` on `startLine`. */
  const collectFlow = (firstChunk, startLine) => {
    let buffer = firstChunk;
    let depth = flowBracketDelta(firstChunk);
    while (depth > 0) {
      if (pos >= lines.length) throw yamlError(startLine, 'unterminated flow collection');
      const next = lines[pos];
      pos += 1;
      buffer += `\n${next.raw}`;
      depth += flowBracketDelta(next.raw);
    }
    return parseFlowCollection(buffer, startLine);
  };

  /** Collect a literal (`|`) or folded (`>`) block scalar whose parent starts at `parentIndent`. */
  const collectBlockScalar = (header, parentIndent, headerLine) => {
    const collected = [];
    let contentIndent = header.explicitIndent !== undefined ? parentIndent + header.explicitIndent : undefined;

    while (pos < lines.length) {
      const cur = lines[pos];
      const allSpaces = cur.raw.trim().length === 0;
      if (allSpaces) {
        collected.push({ blank: true, raw: cur.raw });
        pos += 1;
        continue;
      }
      if (contentIndent === undefined) {
        if (cur.indent <= parentIndent) break;
        contentIndent = cur.indent;
      } else if (cur.indent < contentIndent) {
        break;
      }
      collected.push({ blank: false, text: cur.raw.slice(contentIndent) });
      pos += 1;
    }

    // Separate trailing blank lines for chomping.
    let end = collected.length;
    while (end > 0 && collected[end - 1].blank) end -= 1;
    const bodyLines = collected.slice(0, end);
    const trailingBlanks = collected.length - end;

    if (bodyLines.length === 0) {
      if (header.chomp === '+') return '\n'.repeat(trailingBlanks);
      return '';
    }

    let result;
    if (header.style === '|') {
      result = bodyLines.map(entry => (entry.blank ? '' : entry.text)).join('\n');
    } else {
      // Folded scalar (`>`): fold single line breaks between normal lines into spaces.
      const parts = [];
      for (let i = 0; i < bodyLines.length; i += 1) {
        const cur = bodyLines[i];
        if (cur.blank) {
          parts.push('\n');
          continue;
        }
        if (i === 0) {
          parts.push(cur.text);
          continue;
        }
        const prev = bodyLines[i - 1];
        const prevMoreIndented = !prev.blank && /^\s/u.test(prev.text);
        const curMoreIndented = /^\s/u.test(cur.text);
        if (prev.blank || prevMoreIndented || curMoreIndented) {
          parts.push(prev.blank ? cur.text : `\n${cur.text}`);
        } else {
          parts.push(` ${cur.text}`);
        }
      }
      result = parts.join('');
    }

    if (header.chomp === '-') return result;
    if (header.chomp === '+') return `${result}\n${'\n'.repeat(trailingBlanks)}`;
    return `${result}\n`;
  };

  /** Parse an inline value expression on a single line (or multiline flow / block scalar). */
  const parseInlineExpression = (rest, parentIndent, lineNo) => {
    const clean = stripInlineComment(rest).trim();
    if (clean.length === 0) return { empty: true };
    const blockHeader = parseBlockScalarHeader(clean, lineNo);
    if (blockHeader !== null) {
      return { empty: false, value: collectBlockScalar(blockHeader, parentIndent, lineNo) };
    }
    if (clean[0] === '[' || clean[0] === '{') {
      return { empty: false, value: collectFlow(clean, lineNo) };
    }
    if (clean[0] === "'" || clean[0] === '"') {
      const res = clean[0] === "'"
        ? readSingleQuoted(clean, 0, lineNo)
        : readDoubleQuoted(clean, 0, lineNo);
      const trailing = clean.slice(res.end).trim();
      if (trailing.length > 0) throw yamlError(lineNo, `unexpected trailing content "${trailing}"`);
      return { empty: false, value: res.value };
    }
    return { empty: false, value: parsePlainScalar(clean, lineNo) };
  };

  /** Check if the next non-blank line starts a block sequence entry (`-` followed by space/EOL). */
  const isSequenceLine = (body) => body === '-' || body.startsWith('- ');

  const parseNode = (minIndent, allowSameIndentSeq = false) => {
    skipIgnorable();
    if (pos >= lines.length) return null;
    const cur = lines[pos];
    if (cur.indent < minIndent) return null;
    if (isSequenceLine(cur.body)) {
      if (cur.indent === minIndent || allowSameIndentSeq || cur.indent > minIndent) {
        return parseSequence(cur.indent);
      }
    }
    if (splitMappingLine(cur.body, cur.lineNo) !== null) {
      return parseMapping(cur.indent);
    }
    // Single standalone scalar or flow value.
    pos += 1;
    const expr = parseInlineExpression(cur.body, cur.indent, cur.lineNo);
    return expr.empty ? null : expr.value;
  };

  const parseMapping = (baseIndent, initialEntry = null) => {
    const map = {};
    const addEntry = (key, rest, lineNo) => {
      if (key === '<<') throw yamlError(lineNo, 'YAML merge key "<<" is not supported');
      if (Object.hasOwn(map, key)) throw yamlError(lineNo, `duplicate key "${key}"`);
      const expr = parseInlineExpression(rest, baseIndent, lineNo);
      if (!expr.empty) {
        map[key] = expr.value;
        return;
      }
      // Value lives on following lines (or is null when none are nested).
      skipIgnorable();
      if (pos >= lines.length) {
        map[key] = null;
        return;
      }
      const next = lines[pos];
      if (next.indent > baseIndent) {
        map[key] = parseNode(next.indent);
      } else if (next.indent === baseIndent && isSequenceLine(next.body)) {
        // YAML allows block sequence items at the same indent as their parent mapping key.
        map[key] = parseSequence(next.indent);
      } else {
        map[key] = null;
      }
    };

    if (initialEntry !== null) {
      addEntry(initialEntry.key, initialEntry.rest, initialEntry.lineNo);
    }

    while (pos < lines.length) {
      skipIgnorable();
      if (pos >= lines.length) break;
      const cur = lines[pos];
      if (cur.indent < baseIndent) break;
      if (cur.indent > baseIndent) {
        throw yamlError(cur.lineNo, `unexpected indentation (expected ${baseIndent} spaces, got ${cur.indent})`);
      }
      if (isSequenceLine(cur.body)) break;
      const entry = splitMappingLine(cur.body, cur.lineNo);
      if (entry === null) {
        throw yamlError(cur.lineNo, `expected "key: value" mapping entry, got "${cur.body.trim()}"`);
      }
      pos += 1;
      addEntry(entry.key, entry.rest, cur.lineNo);
    }
    return map;
  };

  const parseSequence = (baseIndent) => {
    const items = [];
    while (pos < lines.length) {
      skipIgnorable();
      if (pos >= lines.length) break;
      const cur = lines[pos];
      if (cur.indent < baseIndent) break;
      if (cur.indent > baseIndent) {
        throw yamlError(cur.lineNo, `unexpected indentation in sequence (expected ${baseIndent} spaces, got ${cur.indent})`);
      }
      if (!isSequenceLine(cur.body)) break;

      pos += 1;
      const afterDashRaw = cur.body.slice(1);
      let leadSpaces = 0;
      while (leadSpaces < afterDashRaw.length && afterDashRaw[leadSpaces] === ' ') leadSpaces += 1;
      const itemContent = afterDashRaw.slice(leadSpaces);
      const itemIndent = baseIndent + 1 + leadSpaces;
      const stripped = stripInlineComment(itemContent).trim();

      if (stripped.length === 0) {
        skipIgnorable();
        if (pos < lines.length && lines[pos].indent > baseIndent) {
          items.push(parseNode(lines[pos].indent));
        } else {
          items.push(null);
        }
        continue;
      }

      if (isSequenceLine(itemContent)) {
        // Inline nested sequence `- - x` is uncommon; handle via synthetic line or reject clearly.
        throw yamlError(cur.lineNo, 'inline nested sequences ("- - ...") are not supported; place the nested list on the next line');
      }

      const inlineEntry = splitMappingLine(itemContent, cur.lineNo);
      if (inlineEntry !== null) {
        items.push(parseMapping(itemIndent, { ...inlineEntry, lineNo: cur.lineNo }));
        continue;
      }

      const expr = parseInlineExpression(itemContent, baseIndent, cur.lineNo);
      items.push(expr.empty ? null : expr.value);
    }
    return items;
  };

  skipIgnorable();
  if (pos >= lines.length) return {};

  startedDoc = true;
  const root = parseNode(lines[pos].indent);
  skipIgnorable();
  if (pos < lines.length) {
    throw yamlError(lines[pos].lineNo, `unexpected trailing content "${lines[pos].body.trim()}"`);
  }
  return root === null ? {} : root;
}
