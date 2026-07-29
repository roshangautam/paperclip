---
title: ACPX Event Provenance Contract
summary: How to tell genuine assistant prose apart from adapter and transport diagnostics in the ACPX stdout stream
---

The ACPX engine streams every event it observes as a single-line JSON record on
stdout. Downstream consumers — the Paperclip UI transcript, the CLI renderer,
the agent-session event stream, and plugins such as the Slack provider — parse
those records to decide what is user-facing agent output.

Every ACPX record now carries a **`provenance`** field. It is the only supported
way to decide whether text was authored by the assistant model.

## Why the field exists

Before this contract, `acpx.text_delta` records looked like this for *both*
genuine assistant prose and adapter/transport diagnostics:

```json
{"type":"acpx.text_delta","text":"Hey there","channel":"output","tag":"agent_message_chunk"}
{"type":"acpx.text_delta","text":"Model metadata not found, defaulting to fallback metadata","channel":"output","tag":"agent_message_chunk"}
```

The two records are structurally identical. A consumer had no safe way to keep
the first and drop the second short of matching on the text itself, which breaks
the moment the assistant legitimately quotes or explains a diagnostic. The Slack
provider had to fail closed and drop the whole ambiguous shape, which also
dropped real replies (DRO-1162).

## The `provenance` field

| Value | Meaning | Safe to show as agent output? |
| --- | --- | --- |
| `assistant` | Text the assistant model itself authored, arriving on the ACP session-update stream with an assistant message or thought tag. | **Yes** |
| `tool` | Structured tool-call activity relayed from the agent session. | No |
| `transport` | Session lifecycle, usage/mode/plan/config updates, and any untagged or unclassifiable runtime line — i.e. adapter and transport diagnostics. | No |
| `error` | Adapter, transport, or agent-process failures. | No |

`provenance` is present on `acpx.text_delta`, `acpx.tool_call`, `acpx.status`,
`acpx.session`, `acpx.result`, and `acpx.error`.

### Classification rule for `acpx.text_delta`

A delta is `assistant` **only** when its `tag` is `agent_message_chunk` or
`agent_thought_chunk`. Classification **fails closed**: a missing, empty, or
unrecognized tag yields `transport`, never `assistant`. This is what guarantees
that a transport warning arriving before the first genuine assistant delta can
never be classified as agent message content.

## Old and new shapes

Old (ambiguous — no discriminator):

```json
{"type":"acpx.text_delta","text":"Hey there","channel":"output","tag":"agent_message_chunk"}
```

New (assistant prose):

```json
{"type":"acpx.text_delta","text":"Hey there","channel":"output","tag":"agent_message_chunk","provenance":"assistant"}
```

New (transport diagnostic that previously masqueraded as prose):

```json
{"type":"acpx.text_delta","text":"Model metadata not found, defaulting to fallback metadata","channel":"output","provenance":"transport"}
```

The change is **purely additive**. No existing field was renamed, removed, or
given a new meaning, so a consumer that ignores `provenance` behaves exactly as
it did before.

## Consuming the contract

Select on `provenance`, not on `type`/`channel`/`tag`:

```ts
import { isAssistantAuthoredAcpxRecord } from "@paperclipai/adapter-utils/acpx-engine";

// true only for provenance === "assistant" on an output-channel text delta
if (isAssistantAuthoredAcpxRecord(record)) {
  appendToReply(record.text);
}
```

`isAssistantAuthoredAcpxRecord` never guesses: a record with no `provenance`
field returns `false`.

## Transition window

Run logs are persisted, so both shapes coexist for as long as historical runs
are readable.

- **Live streams** carry `provenance` on every record as of this release.
- **Replayed and archived run logs** written before this release have no
  `provenance` field.

Consumers should therefore treat an **absent** `provenance` as *unknown*, not as
*assistant*, and apply whatever fallback is correct for their surface:

- The UI transcript parser and CLI renderer keep the historical channel-based
  rendering when `provenance` is absent, so old transcripts still read
  correctly, and honour `provenance` whenever it is present.
- Consumers that must not surface diagnostics as agent replies — the Slack
  provider is the motivating case — should accept **only** explicitly
  `assistant` records and keep dropping the ambiguous old shape.

The bounded transition ends when no live surface reads pre-contract run logs.
At that point the absent-`provenance` fallbacks above can be removed and a
missing `provenance` can be treated as a hard rejection everywhere.
