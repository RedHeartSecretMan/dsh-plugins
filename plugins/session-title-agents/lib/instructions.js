import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const START_END_MARKER = /<!--[ \t]*session-title-agents:(start|end)[ \t]*-->/gu;

function isNamingHeading(heading) {
  return /会话|对话/u.test(heading) && /命名|标题/u.test(heading)
    || /\b(?:sessions?|conversations?)\b/iu.test(heading) && /\b(?:naming|titles?)\b/iu.test(heading);
}

/** Extract only naming sections and balanced, explicit naming blocks. */
export function extractNamingSections(text) {
  if (typeof text !== "string" || !text) return [];
  text = text.replace(/\r\n?/gu, "\n");
  const ranges = [];
  const markers = [];
  const starts = [];
  let section;
  let fence;
  let offset = 0;

  for (const line of text.split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.character
        && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      offset += line.length + 1;
      continue;
    }
    if (delimiter && (delimiter[1][0] !== "`" || !delimiter[2].includes("`"))) {
      fence = { character: delimiter[1][0], length: delimiter[1].length };
      offset += line.length + 1;
      continue;
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/u.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (section && level <= section.level) {
        ranges.push({ start: section.start, end: offset });
        section = undefined;
      }
      if (!section && isNamingHeading(heading[2] ?? "")) section = { start: offset, level };
    }

    START_END_MARKER.lastIndex = 0;
    for (const match of line.matchAll(START_END_MARKER)) {
      const marker = { start: offset + match.index, end: offset + match.index + match[0].length };
      markers.push(marker);
      if (match[1] === "start") starts.push(marker.end);
      else if (starts.length) {
        const start = starts.pop();
        if (!starts.length) ranges.push({ start, end: marker.start });
      }
    }
    offset += line.length + 1;
  }
  if (section) ranges.push({ start: section.start, end: text.length });

  // A heading and an explicit block can select the same bytes. Render that union once.
  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let markerIndex = 0;
  return merged.map(({ start, end }) => {
    const parts = [];
    let position = start;
    while (markerIndex < markers.length && markers[markerIndex].end <= start) markerIndex++;
    while (markerIndex < markers.length && markers[markerIndex].start < end) {
      const marker = markers[markerIndex++];
      if (marker.start < start || marker.end > end) continue;
      parts.push(text.slice(position, marker.start));
      position = marker.end;
    }
    parts.push(text.slice(position, end));
    return parts.join("").trim();
  }).filter(Boolean);
}

async function defaultDiscover(options) {
  let discoverBaselineInstructionFiles;
  try { ({ discoverBaselineInstructionFiles } = await import('@deepseek-ai/dsh-agent-instructions')); }
  catch (cause) {
    throw Object.assign(new Error('Harness instruction SDK could not be imported', { cause }), { code: 'SDK_IMPORT_FAILED' });
  }
  options.signal.throwIfAborted();
  return discoverBaselineInstructionFiles(options);
}

function limit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

async function readSource(path, maxSourceBytes, signal) {
  const chunks = [];
  let bytes = 0;
  // Read at most one extra byte to detect an oversized source without loading its remainder.
  const stream = createReadStream(path, {
    signal,
    end: maxSourceBytes,
    highWaterMark: Math.min(64 * 1024, maxSourceBytes + 1),
  });
  for await (const chunk of stream) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > maxSourceBytes) return undefined;
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function utf8Prefix(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function render(entries, maxBytes) {
  const format = ({ source, excerpts }) => `Instructions from: ${source}\n\n${excerpts.join("\n\n")}`;
  let text = entries.map(format).join("\n\n");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, sources: entries.map(entry => entry.source) };
  }
  // Drop broader sources before truncating the most specific remaining source.
  while (entries.length > 1) {
    entries.shift();
    text = entries.map(format).join("\n\n");
    if (Buffer.byteLength(text, "utf8") <= maxBytes) {
      return { text, sources: entries.map(entry => entry.source), truncated: true };
    }
  }
  const entry = entries[0];
  if (!entry) return { text: "", sources: [], truncated: true };
  const label = `Instructions from: ${entry.source}\n\n`;
  const remaining = maxBytes - Buffer.byteLength(label, "utf8");
  const excerpt = remaining > 0 ? utf8Prefix(entry.excerpts.join("\n\n"), remaining).trimEnd() : "";
  return excerpt
    ? { text: label + excerpt, sources: [entry.source], truncated: true }
    : { text: "", sources: [], truncated: true };
}

/** Create a fresh, bounded reader; only the SDK owns instruction-file discovery. */
export function createInstructionReader({ discover = defaultDiscover, timeoutMs = 2000, maxSourceBytes = 1048576, onDiagnostic = () => {} } = {}) {
  const note = reason => { try { onDiagnostic(reason); } catch { /* Diagnostics cannot break naming. */ } };
  timeoutMs = limit(timeoutMs, 2000);
  maxSourceBytes = limit(maxSourceBytes, 1048576);

  return async function read({ cwd, signal, maxBytes = 4096 } = {}) {
    signal?.throwIfAborted();
    const empty = () => ({ text: "", sources: [] });
    if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return empty();
    maxBytes = limit(maxBytes, 4096);
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    const timer = setTimeout(() => controller.abort(new DOMException("Instruction reading timed out", "TimeoutError")), timeoutMs);
    let onAbort;
    const cancellation = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });

    const load = async () => {
      try {
        if (!(await stat(cwd)).isDirectory()) return empty();
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return empty();
        throw error;
      }
      controller.signal.throwIfAborted();
      const files = await discover({
        cwd,
        signal: controller.signal,
        instructionFileCandidates: ["AGENTS.md"],
        localInstructionFileCandidates: ["AGENTS.local.md"],
      });
      controller.signal.throwIfAborted();
      const entries = [];
      const paths = new Set();
      let unavailable = false;
      let truncated = false;
      for (const file of files) {
        controller.signal.throwIfAborted();
        if (typeof file?.absolutePath !== "string" || !isAbsolute(file.absolutePath)
          || typeof file.displayPath !== "string" || !file.displayPath.trim()) {
          unavailable = true;
          note('invalid-discovery-record');
          continue;
        }
        const path = resolve(file.absolutePath);
        const key = process.platform === "win32" ? path.toLowerCase() : path;
        if (paths.has(key)) continue;
        paths.add(key);
        try {
          const content = await readSource(path, maxSourceBytes, controller.signal);
          if (content === undefined) { truncated = true; continue; }
          const excerpts = extractNamingSections(content);
          if (excerpts.length) entries.push({ source: file.displayPath, excerpts });
        } catch {
          controller.signal.throwIfAborted();
          note('read-failed');
          unavailable = true;
        }
      }
      controller.signal.throwIfAborted();
      // Keep duplicate excerpts at their most specific source so a small budget preserves them.
      const seen = new Set();
      for (let index = entries.length - 1; index >= 0; index--) {
        entries[index].excerpts = entries[index].excerpts.filter(excerpt => {
          if (seen.has(excerpt)) return false;
          seen.add(excerpt);
          return true;
        });
      }
      const result = render(entries.filter(entry => entry.excerpts.length), maxBytes);
      if (unavailable) result.unavailable = true;
      if (truncated) result.truncated = true;
      return result;
    };

    try {
      return await Promise.race([load(), cancellation]);
    } catch (error) {
      signal?.throwIfAborted();
      note(controller.signal.aborted ? 'timeout' : error?.code === 'SDK_IMPORT_FAILED' ? 'sdk-import-failed' : 'discovery-failed');
      return { ...empty(), unavailable: true };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
}
