/**
 * ACPX event provenance contract (DRO-1183).
 *
 * Historically `acpx.text_delta` records carried no discriminator that told a
 * downstream consumer whether the text was authored by the assistant model or
 * produced by the adapter/transport layer. Both shapes were structurally
 * identical (`type: "acpx.text_delta"`, `channel: "output"`,
 * `tag: "agent_message_chunk"`), which forced consumers such as the Slack
 * provider into unsafe text-pattern filtering, or into failing closed and
 * dropping genuine assistant prose (see DRO-1162).
 *
 * Every ACPX record emitted by the engine now carries a stable `provenance`
 * field. Consumers that need user-facing model output MUST select on
 * `provenance === "assistant"` rather than on `type`/`channel`/`tag`.
 */

/**
 * Text authored by the assistant model itself. This is the ONLY value that a
 * downstream consumer may treat as user-facing agent message content.
 *
 * Only `text_delta` events that arrive on the ACP session-update stream with an
 * assistant message/thought tag qualify.
 */
export const ACPX_PROVENANCE_ASSISTANT = "assistant";

/**
 * Structured tool-call activity relayed from the agent session. Not prose.
 */
export const ACPX_PROVENANCE_TOOL = "tool";

/**
 * Non-fatal transport/adapter/session lifecycle information: session
 * announcements, usage updates, mode/plan/config updates, and any untagged or
 * free-form line the runtime could not classify as an assistant message.
 */
export const ACPX_PROVENANCE_TRANSPORT = "transport";

/**
 * Adapter, transport, or agent-process failures.
 */
export const ACPX_PROVENANCE_ERROR = "error";

export const ACPX_PROVENANCE_VALUES = [
  ACPX_PROVENANCE_ASSISTANT,
  ACPX_PROVENANCE_TOOL,
  ACPX_PROVENANCE_TRANSPORT,
  ACPX_PROVENANCE_ERROR,
] as const;

export type AcpxProvenance = (typeof ACPX_PROVENANCE_VALUES)[number];

/**
 * ACP session-update tags that represent text the assistant model itself
 * authored. Anything outside this set is transport/adapter provenance even when
 * the runtime routes it through a `text_delta` event.
 */
const ASSISTANT_AUTHORED_TAGS = new Set<string>([
  "agent_message_chunk",
  "agent_thought_chunk",
]);

export function isAcpxProvenance(value: unknown): value is AcpxProvenance {
  return typeof value === "string" && (ACPX_PROVENANCE_VALUES as readonly string[]).includes(value);
}

/**
 * Classify an ACPX `text_delta` runtime event.
 *
 * Fails closed: a delta with a missing, empty, or unrecognized tag is
 * `transport`, never `assistant`. This is what guarantees that a transport
 * warning emitted before the first genuine assistant delta can never be
 * classified as agent message content.
 */
export function textDeltaProvenance(tag: unknown): AcpxProvenance {
  if (typeof tag !== "string") return ACPX_PROVENANCE_TRANSPORT;
  return ASSISTANT_AUTHORED_TAGS.has(tag)
    ? ACPX_PROVENANCE_ASSISTANT
    : ACPX_PROVENANCE_TRANSPORT;
}

/**
 * True when a parsed ACPX stdout record is explicitly assistant-authored
 * user-facing prose. Consumers should use this instead of matching on
 * `type`/`channel`/`tag`.
 *
 * Records without a `provenance` field are pre-DRO-1183 (ambiguous) and return
 * `false` here; consumers may keep a bounded-transition fallback of their own,
 * but this helper never guesses.
 */
export function isAssistantAuthoredAcpxRecord(record: unknown): boolean {
  if (typeof record !== "object" || record === null) return false;
  const value = record as Record<string, unknown>;
  if (value.provenance !== ACPX_PROVENANCE_ASSISTANT) return false;
  return value.type === "acpx.text_delta" && value.channel === "output";
}
