// Optional diagnostics only. No clock, environment, network or storage access.
export interface DebugEvent { component: string; event: string; details: unknown }
export type DebugSink = (event: DebugEvent) => void;
let sink: DebugSink | undefined;
export function setDebugSink(value?: DebugSink): void { sink = value; }
export function debugEnabled(): boolean { return sink !== undefined; }
function utf8Length(text: string): number {
  let size = 0;
  for (const character of text) { const code = character.codePointAt(0)!; size += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
  return size;
}
function summary(value: unknown, key = "", depth = 0): unknown {
  if (/password|passwd|private.?key|secret|mnemonic|token|credential|wif/i.test(key)) return "[redacted]";
  if (depth > 20) return "[depth]";
  if (value instanceof Uint8Array) return { byteLength: value.byteLength };
  if (value instanceof ArrayBuffer) return { byteLength: value.byteLength };
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (/signature|script|preimage|raw|signedTx|unsignedTx|draft|body|payloadBytes/i.test(key)
      || value.length > 128 || /^[0-9a-f]{66,}$/i.test(value)) return { byteLength: /^[0-9a-f]*$/i.test(value) && value.length % 2 === 0 ? value.length / 2 : utf8Length(value) };
    return value.replace(/((?:password|secret|token|private.?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.map(item => summary(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, summary(item, name, depth + 1)]));
  return value;
}
export function debugLog(event: string, details: () => unknown): void {
  if (!sink) return;
  try { sink({ component: "trade-scheduler", event, details: summary(details()) }); } catch { /* diagnostics cannot change money decisions */ }
}

