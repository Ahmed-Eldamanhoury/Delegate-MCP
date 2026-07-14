/**
 * Incremental newline-delimited JSON parser for `claude --output-format stream-json`.
 * Pure/stateless per call — the caller holds `remainder` across chunks. A chunk boundary can
 * split a JSON line mid-object, so this only ever emits *complete* lines; the trailing
 * incomplete fragment is returned as the new remainder for the next call.
 *
 * Built and unit-tested (see tests/streamJsonParser.test.js) per ADR-0002 Phase 3, but not
 * wired into the live `--output-format` argument this wave — see the ADR's Risk assessment
 * for why (can't verify the exact live format against a real logged-in CLI in this
 * environment; an unverified guess is not an acceptable risk to the frozen `delegate_task`
 * response shape, which still relies on `--output-format json`).
 *
 * @param {string} remainder leftover partial line from the previous call ("" to start)
 * @param {string} chunk newly arrived text
 * @returns {{objects: object[], malformedLines: string[], remainder: string}}
 */
export function parseStreamJsonChunk(remainder, chunk) {
  const combined = remainder + chunk;
  const lines = combined.split("\n");
  const newRemainder = lines.pop(); // last element: either "" (chunk ended on \n) or a partial line

  const objects = [];
  const malformedLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch {
      malformedLines.push(trimmed);
    }
  }

  return { objects, malformedLines, remainder: newRemainder };
}

/**
 * The pure "which stream-json event types matter for progress, and what to say about them"
 * decision. Lives here (rather than in claudeCliService.js, where it's used by
 * `createStreamJsonTracker`) so debug mode's file-tail consumer (`src/services/debugInvoke.js`
 * tails `stream.jsonl`, written by `src/debug/debugRunner.js`) can reuse the exact same
 * classification without a circular import between claudeCliService.js and debugInvoke.js.
 * Same categories, same omissions as `createStreamJsonTracker`'s own doc comment describes —
 * this is a shared building block, not a second decision.
 * @param {object} obj one already-parsed stream-json line
 * @returns {{phase: string, progressMessage: string}|null} null if this object isn't progress-worthy
 */
export function classifyStreamJsonEvent(obj) {
  if (obj.type === "system" && obj.subtype === "thinking_tokens") {
    return { phase: "thinking", progressMessage: `Thinking… (~${obj.estimated_tokens} tokens)` };
  }
  if (obj.type === "assistant") {
    const textBlock = obj.message?.content?.find((block) => block.type === "text");
    if (textBlock?.text) {
      return { phase: "responding", progressMessage: textBlock.text.slice(0, 200) };
    }
  }
  return null;
}
