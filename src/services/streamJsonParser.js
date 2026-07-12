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
