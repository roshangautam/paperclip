import { describe, expect, it } from "vitest";

import { parseAcpxStdoutLine } from "./ui.js";

const TS = "2026-07-29T00:00:00.000Z";

function parse(record: Record<string, unknown>) {
  return parseAcpxStdoutLine(JSON.stringify(record), TS);
}

describe("parseAcpxStdoutLine text_delta provenance (DRO-1183)", () => {
  it("renders assistant-provenance output deltas as assistant prose", () => {
    expect(
      parse({
        type: "acpx.text_delta",
        text: "Hey there",
        channel: "output",
        tag: "agent_message_chunk",
        provenance: "assistant",
      }),
    ).toEqual([{ kind: "assistant", ts: TS, text: "Hey there", delta: true }]);
  });

  it("renders assistant-provenance thought deltas as thinking", () => {
    expect(
      parse({
        type: "acpx.text_delta",
        text: "hmm",
        channel: "thought",
        tag: "agent_thought_chunk",
        provenance: "assistant",
      }),
    ).toEqual([{ kind: "thinking", ts: TS, text: "hmm", delta: true }]);
  });

  it("never renders a transport-provenance delta as assistant content", () => {
    expect(
      parse({
        type: "acpx.text_delta",
        text: "Model metadata not found, defaulting to fallback metadata",
        channel: "output",
        provenance: "transport",
      }),
    ).toEqual([
      {
        kind: "system",
        ts: TS,
        text: "Model metadata not found, defaulting to fallback metadata",
      },
    ]);
  });

  it("keeps legacy channel-based rendering for pre-contract records", () => {
    // Bounded transition window: records emitted before the provenance contract
    // carry no `provenance` field and must still render in old transcripts.
    expect(
      parse({
        type: "acpx.text_delta",
        text: "legacy prose",
        channel: "output",
        tag: "agent_message_chunk",
      }),
    ).toEqual([{ kind: "assistant", ts: TS, text: "legacy prose", delta: true }]);
  });
});
