import { describe, expect, it } from "vitest";
import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";

describe("bridge sandbox helpers", () => {
  it("builds reusable lease IDs from acquisition IDs for host-managed reuse", () => {
    expect(buildLeaseSandboxId({
      acquisitionId: "Acquisition_123",
      environmentId: "Env_123",
      runId: "run-ignored",
      reuseLease: true,
      normalizeId: true,
    })).toBe("pc-acq-acquisition-123");
  });

  it("builds ephemeral lease IDs from acquisition IDs", () => {
    expect(buildLeaseSandboxId({
      acquisitionId: "Acquisition_123",
      environmentId: "env-1",
      runId: "Run_123",
      reuseLease: false,
      normalizeId: true,
    })).toBe("pc-acq-acquisition-123");
  });

  it("builds the workspace sentinel path", () => {
    expect(buildSentinelPath("/workspace/paperclip/")).toBe("/workspace/paperclip/.paperclip-lease.json");
  });

  it("detects timeout-shaped errors", () => {
    expect(isTimeoutError(new Error("command timed out after 10s"))).toBe(true);
    expect(isTimeoutError(new Error("some other error"))).toBe(false);
  });
});
