import { describe, expect, it } from "vitest";

import {
  ACPX_PROVENANCE_ASSISTANT,
  ACPX_PROVENANCE_ERROR,
  ACPX_PROVENANCE_TRANSPORT,
  isAcpxProvenance,
  isAssistantAuthoredAcpxRecord,
  textDeltaProvenance,
} from "./provenance.js";

describe("textDeltaProvenance", () => {
  it("classifies assistant-authored session update tags as assistant", () => {
    expect(textDeltaProvenance("agent_message_chunk")).toBe(ACPX_PROVENANCE_ASSISTANT);
    expect(textDeltaProvenance("agent_thought_chunk")).toBe(ACPX_PROVENANCE_ASSISTANT);
  });

  it("fails closed to transport for missing, empty, or unknown tags", () => {
    // A transport/adapter diagnostic that the runtime could not attribute to an
    // assistant session update must never be assistant-authored.
    expect(textDeltaProvenance(undefined)).toBe(ACPX_PROVENANCE_TRANSPORT);
    expect(textDeltaProvenance(null)).toBe(ACPX_PROVENANCE_TRANSPORT);
    expect(textDeltaProvenance("")).toBe(ACPX_PROVENANCE_TRANSPORT);
    expect(textDeltaProvenance("usage_update")).toBe(ACPX_PROVENANCE_TRANSPORT);
    expect(textDeltaProvenance("session_info_update")).toBe(ACPX_PROVENANCE_TRANSPORT);
    expect(textDeltaProvenance(42)).toBe(ACPX_PROVENANCE_TRANSPORT);
  });
});

describe("isAcpxProvenance", () => {
  it("accepts only the documented values", () => {
    expect(isAcpxProvenance("assistant")).toBe(true);
    expect(isAcpxProvenance("tool")).toBe(true);
    expect(isAcpxProvenance("transport")).toBe(true);
    expect(isAcpxProvenance("error")).toBe(true);
    expect(isAcpxProvenance("agent")).toBe(false);
    expect(isAcpxProvenance(undefined)).toBe(false);
  });
});

describe("isAssistantAuthoredAcpxRecord", () => {
  it("accepts an assistant-authored output delta", () => {
    expect(
      isAssistantAuthoredAcpxRecord({
        type: "acpx.text_delta",
        text: "Hello",
        channel: "output",
        tag: "agent_message_chunk",
        provenance: ACPX_PROVENANCE_ASSISTANT,
      }),
    ).toBe(true);
  });

  it("rejects pre-contract records that carry no provenance at all", () => {
    // Old ambiguous shape: structurally identical for prose and diagnostics.
    expect(
      isAssistantAuthoredAcpxRecord({
        type: "acpx.text_delta",
        text: "Model metadata not found, defaulting to fallback metadata",
        channel: "output",
        tag: "agent_message_chunk",
      }),
    ).toBe(false);
  });

  it("rejects transport and error provenance, and non-output channels", () => {
    expect(
      isAssistantAuthoredAcpxRecord({
        type: "acpx.text_delta",
        text: "warming up",
        channel: "output",
        provenance: ACPX_PROVENANCE_TRANSPORT,
      }),
    ).toBe(false);
    expect(
      isAssistantAuthoredAcpxRecord({
        type: "acpx.error",
        message: "boom",
        provenance: ACPX_PROVENANCE_ERROR,
      }),
    ).toBe(false);
    expect(
      isAssistantAuthoredAcpxRecord({
        type: "acpx.text_delta",
        text: "internal reasoning",
        channel: "thought",
        tag: "agent_thought_chunk",
        provenance: ACPX_PROVENANCE_ASSISTANT,
      }),
    ).toBe(false);
    expect(isAssistantAuthoredAcpxRecord(null)).toBe(false);
    expect(isAssistantAuthoredAcpxRecord("assistant")).toBe(false);
  });

  it("never classifies a transport warning that precedes the first assistant delta as agent message content", () => {
    // DRO-1183 acceptance case: a transport warning arriving before any genuine
    // assistant delta must not be selected as user-facing agent content, while
    // the assistant deltas that follow it must be.
    const stream = [
      {
        type: "acpx.text_delta",
        text: "Model metadata not found, defaulting to fallback metadata",
        channel: "output",
        provenance: textDeltaProvenance(undefined),
      },
      {
        type: "acpx.status",
        text: "usage update",
        tag: "usage_update",
        provenance: ACPX_PROVENANCE_TRANSPORT,
      },
      {
        type: "acpx.text_delta",
        text: "Hey",
        channel: "output",
        tag: "agent_message_chunk",
        provenance: textDeltaProvenance("agent_message_chunk"),
      },
      {
        type: "acpx.text_delta",
        text: " there",
        channel: "output",
        tag: "agent_message_chunk",
        provenance: textDeltaProvenance("agent_message_chunk"),
      },
    ];

    const assistantText = stream
      .filter((record) => isAssistantAuthoredAcpxRecord(record))
      .map((record) => record.text)
      .join("");

    expect(assistantText).toBe("Hey there");
    expect(assistantText).not.toContain("Model metadata not found");
  });
});
