import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
let plugin: typeof import("./plugin.js").default;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestInitAt(index = 0): RequestInit {
  return fetchMock.mock.calls[index]?.[1] as RequestInit;
}

function requestHeadersAt(index = 0): Headers {
  return requestInitAt(index).headers as Headers;
}

function requestBodyAt(index = 0): Record<string, unknown> {
  return JSON.parse(String(requestInitAt(index).body ?? "{}")) as Record<string, unknown>;
}

function reusableSandboxLease(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    companyId: "company-1",
    environmentId: "env-1",
    executionWorkspaceId: "workspace-1",
    agentId: "agent-1",
    adapterType: null,
    provider: "cloudflare",
    runtimeFingerprint: "runtime-fingerprint-1",
    ...overrides,
  };
}

describe("Cloudflare sandbox provider plugin", () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    plugin = (await import("./plugin.js")).default;
  });

  it("declares the Cloudflare environment lifecycle handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: "Cloudflare sandbox provider plugin healthy",
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
  });

  it("normalizes and validates Cloudflare config", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "cloudflare",
      config: {
        bridgeBaseUrl: " https://bridge.example.workers.dev/ ",
        bridgeAuthToken: " secret-ref://bridge-token ",
        reuseLease: true,
        keepAlive: true,
        normalizeId: false,
        requestedCwd: " /workspace/custom ",
        sessionStrategy: "default",
        timeoutMs: "450000.9",
        bridgeRequestTimeoutMs: "40000.1",
      },
    });

    expect(result).toEqual({
      ok: true,
      normalizedConfig: {
        bridgeBaseUrl: "https://bridge.example.workers.dev/",
        bridgeAuthToken: "secret-ref://bridge-token",
        reuseLease: true,
        keepAlive: true,
        sleepAfter: "1h",
        normalizeId: false,
        requestedCwd: "/workspace/custom",
        sessionStrategy: "default",
        sessionId: "paperclip",
        timeoutMs: 450000,
        bridgeRequestTimeoutMs: 40000,
        previewHostname: null,
      },
    });
  });

  it("rejects insecure or contradictory config", async () => {
    await expect(plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "cloudflare",
      config: {
        bridgeBaseUrl: "http://bridge.example.workers.dev",
        bridgeAuthToken: "secret-ref://bridge-token",
        reuseLease: true,
        keepAlive: false,
        requestedCwd: "workspace/not-absolute",
      },
    })).resolves.toEqual({
      ok: false,
      errors: [
        "bridgeBaseUrl must use HTTPS unless it points at localhost.",
        "reuseLease requires keepAlive for Cloudflare sandboxes.",
        "requestedCwd must be an absolute POSIX path.",
      ],
    });
  });

  it("maps acquire lease responses from the bridge", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        provider: "cloudflare",
        bridgeVersion: "0.1.0",
        capabilities: { acquisitionReplay: true, reuseLease: true, namedSessions: true, previewUrls: false },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: {
          provider: "cloudflare",
          remoteCwd: "/workspace/paperclip",
          resumedLease: false,
        },
      }),
    );

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      acquisitionId: "acquisition-1",
      issueId: "issue-1",
      runId: "run-1",
      requestedCwd: "/workspace/paperclip",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(lease).toEqual({
      providerLeaseId: "pc-run-1-abcd1234",
      metadata: {
        provider: "cloudflare",
        remoteCwd: "/workspace/paperclip",
        resumedLease: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example.workers.dev/api/paperclip-sandbox/v2/leases/acquire",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    expect(requestHeadersAt(1).get("X-Paperclip-Run-Id")).toBe("run-1");
    expect(requestHeadersAt(1).get("X-Paperclip-Environment-Id")).toBe("env-1");
    expect(requestHeadersAt(1).get("X-Paperclip-Issue-Id")).toBe("issue-1");
    expect(requestHeadersAt(1).get("X-Paperclip-Acquisition-Id")).toBe("acquisition-1");
    expect(requestBodyAt(1)).toMatchObject({
      acquisitionId: "acquisition-1",
      environmentId: "env-1",
      runId: "run-1",
      issueId: "issue-1",
      requestedCwd: "/workspace/paperclip",
    });
    expect(requestBodyAt(1)).not.toHaveProperty("reuseScopeId");
  });

  it("scopes reusable sandboxes to the execution workspace and agent", async () => {
    const health = {
      ok: true,
      provider: "cloudflare",
      bridgeVersion: "0.1.0",
      capabilities: {
        acquisitionReplay: true,
        scopedReuse: true,
        reuseLease: true,
        namedSessions: true,
        previewUrls: false,
      },
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(health))
      .mockResolvedValueOnce(jsonResponse({ providerLeaseId: "pc-scope-one", metadata: {} }))
      .mockResolvedValueOnce(jsonResponse(health))
      .mockResolvedValueOnce(jsonResponse({ providerLeaseId: "pc-scope-two", metadata: {} }));

    const acquire = (agentId: string, acquisitionId: string) => plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      acquisitionId,
      runId: `run-${agentId}`,
      agentId,
      executionWorkspaceId: "workspace-1",
      workspaceMode: "isolated",
      adapterType: "codex_local",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
        reuseLease: true,
        keepAlive: true,
      },
    });

    await acquire("agent-1", "acquisition-1");
    await acquire("agent-2", "acquisition-2");

    const firstScope = requestBodyAt(1).reuseScopeId;
    const secondScope = requestBodyAt(3).reuseScopeId;
    expect(firstScope).toMatch(/^[a-f0-9]{32}$/);
    expect(secondScope).toMatch(/^[a-f0-9]{32}$/);
    expect(firstScope).not.toBe(secondScope);
  });

  it("rejects an old bridge before requesting a reusable lease", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        provider: "cloudflare",
        bridgeVersion: "0.1.0",
        capabilities: { acquisitionReplay: true, reuseLease: true, namedSessions: true, previewUrls: false },
      }),
    );

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      acquisitionId: "acquisition-1",
      runId: "run-1",
      agentId: "agent-1",
      executionWorkspaceId: "workspace-1",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
        reuseLease: true,
        keepAlive: true,
      },
    })).rejects.toThrow("does not support workspace-scoped reusable leases");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults the sleepAfter passed to the bridge to 1h so long runs don't idle out", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        provider: "cloudflare",
        bridgeVersion: "0.1.0",
        capabilities: { acquisitionReplay: true, reuseLease: true, namedSessions: true, previewUrls: false },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: { provider: "cloudflare", remoteCwd: "/workspace/paperclip", resumedLease: false },
      }),
    );

    await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      acquisitionId: "acquisition-1",
      runId: "run-1",
      requestedCwd: "/workspace/paperclip",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(requestBodyAt(1)).toMatchObject({ sleepAfter: "1h" });
  });

  it("rejects bridges that cannot replay an acquisition safely", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        provider: "cloudflare",
        bridgeVersion: "0.1.0",
        capabilities: { reuseLease: true, namedSessions: true, previewUrls: false },
      }),
    );

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      acquisitionId: "acquisition-1",
      runId: "run-1",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    })).rejects.toThrow("does not support replay-safe lease acquisition");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays ambiguous and in-progress acquisitions through the setup deadline", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            provider: "cloudflare",
            bridgeVersion: "0.1.0",
            capabilities: { acquisitionReplay: true, reuseLease: true, namedSessions: true, previewUrls: false },
          }),
        )
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          throw new TypeError("connection closed before the response arrived");
        })
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: "acquisition_in_progress",
              message: "Cloudflare sandbox setup is still in progress.",
              details: { providerLeaseId: "pc-acq-acquisition-1" },
            },
            503,
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: "acquisition_in_progress",
              message: "Cloudflare sandbox setup is still in progress.",
              details: { providerLeaseId: "pc-acq-acquisition-1" },
            },
            503,
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            providerLeaseId: "pc-acq-acquisition-1",
            metadata: { acquisitionId: "acquisition-1", provider: "cloudflare" },
          }),
        );

      const acquisition = plugin.definition.onEnvironmentAcquireLease?.({
        driverKey: "cloudflare",
        companyId: "company-1",
        environmentId: "env-1",
        acquisitionId: "acquisition-1",
        runId: "run-1",
        config: {
          bridgeBaseUrl: "https://bridge.example.workers.dev",
          bridgeAuthToken: "resolved-token",
          timeoutMs: 4_000,
          bridgeRequestTimeoutMs: 4_000,
        },
      });

      await vi.advanceTimersByTimeAsync(3_250);
      await expect(acquisition).resolves.toMatchObject({
        providerLeaseId: "pc-acq-acquisition-1",
      });
      expect(fetchMock).toHaveBeenCalledTimes(5);
      for (const requestIndex of [1, 2, 3, 4]) {
        expect(requestBodyAt(requestIndex)).toMatchObject({
          acquisitionId: "acquisition-1",
          environmentId: "env-1",
          runId: "run-1",
        });
        expect(requestHeadersAt(requestIndex).get("X-Paperclip-Acquisition-Id")).toBe("acquisition-1");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one timeout budget across health and provider acquisition", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return jsonResponse({
            ok: true,
            provider: "cloudflare",
            bridgeVersion: "0.1.0",
            capabilities: { acquisitionReplay: true, reuseLease: true, namedSessions: true, previewUrls: false },
          });
        })
        .mockImplementationOnce(async (_url: string, init: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }));

      const acquisition = plugin.definition.onEnvironmentAcquireLease?.({
        driverKey: "cloudflare",
        companyId: "company-1",
        environmentId: "env-1",
        acquisitionId: "acquisition-1",
        runId: "run-1",
        config: {
          bridgeBaseUrl: "https://bridge.example.workers.dev",
          bridgeAuthToken: "resolved-token",
          timeoutMs: 2_000,
          bridgeRequestTimeoutMs: 2_000,
        },
      });

      const rejected = expect(acquisition).rejects.toThrow(
        "Cloudflare sandbox bridge request timed out after 500ms.",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestBodyAt(1)).toMatchObject({ timeoutMs: 500 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves structured cleanup data when an acquisition remains in progress", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          provider: "cloudflare",
          bridgeVersion: "0.1.0",
          capabilities: { acquisitionReplay: true, reuseLease: true, namedSessions: true, previewUrls: false },
        }),
      );
      fetchMock.mockImplementation(async () =>
        jsonResponse(
          {
            error: "acquisition_in_progress",
            message: "Cloudflare sandbox setup is still in progress.",
            details: { providerLeaseId: "pc-acq-acquisition-1" },
          },
          503,
        ),
      );

      const acquisition = plugin.definition.onEnvironmentAcquireLease?.({
        driverKey: "cloudflare",
        companyId: "company-1",
        environmentId: "env-1",
        acquisitionId: "acquisition-1",
        runId: "run-1",
        config: {
          bridgeBaseUrl: "https://bridge.example.workers.dev",
          bridgeAuthToken: "resolved-token",
          timeoutMs: 1_000,
          bridgeRequestTimeoutMs: 1_000,
        },
      });

      const rejected = expect(acquisition).rejects.toMatchObject({
        name: "JsonRpcCallError",
        code: -32002,
        data: { providerLeaseId: "pc-acq-acquisition-1" },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a surviving sandbox ID through a structured acquisition error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        provider: "cloudflare",
        bridgeVersion: "0.1.0",
        capabilities: { acquisitionReplay: true, reuseLease: true, namedSessions: true, previewUrls: false },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "acquisition_failed",
          message: "ensure workspace failed",
          details: { providerLeaseId: "pc-acq-acquisition-1" },
        },
        500,
      ),
    );

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      acquisitionId: "acquisition-1",
      runId: "run-1",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    })).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: -32002,
      data: { providerLeaseId: "pc-acq-acquisition-1" },
    });
  });

  it("returns expired lease semantics when resume reports lost state", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "sandbox_state_lost",
          message: "Cloudflare sandbox state is no longer available.",
        },
        409,
      ),
    );

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-env-env-1",
      leaseMetadata: {
        acquisitionId: "acquisition-1",
        remoteCwd: "/workspace/paperclip",
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(lease).toEqual({
      providerLeaseId: null,
      metadata: {
        provider: "cloudflare",
        expired: true,
      },
    });
    expect(requestBodyAt()).toMatchObject({ acquisitionId: "acquisition-1" });
  });

  it("rejects resume responses from bridges that omit ownership metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        providerLeaseId: "pc-env-env-1",
        metadata: {
          provider: "cloudflare",
          remoteCwd: "/workspace/paperclip",
          resumedLease: true,
        },
      }),
    );

    await expect(plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-env-env-1",
      leaseMetadata: {
        acquisitionId: "acquisition-1",
        remoteCwd: "/workspace/paperclip",
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    })).rejects.toThrow(
      "Cloudflare sandbox bridge resume response is missing lease ownership metadata; deploy the current bridge before resuming leases.",
    );
    expect(requestBodyAt()).toMatchObject({ acquisitionId: "acquisition-1" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://bridge.example.workers.dev/api/paperclip-sandbox/v2/leases/resume",
    );
  });

  it.each([
    {
      mismatch: "provider lease",
      response: {
        providerLeaseId: "pc-env-another-env",
        metadata: { provider: "cloudflare", acquisitionId: "acquisition-1" },
      },
      expectedError: "Cloudflare sandbox bridge resumed a different provider lease.",
    },
    {
      mismatch: "lease acquisition",
      response: {
        providerLeaseId: "pc-env-env-1",
        metadata: { provider: "cloudflare", acquisitionId: "acquisition-2" },
      },
      expectedError: "Cloudflare sandbox bridge resumed a different lease acquisition.",
    },
  ])("rejects resume responses for a different $mismatch", async ({ response, expectedError }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-env-env-1",
      leaseMetadata: { acquisitionId: "acquisition-1" },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    })).rejects.toThrow(expectedError);
  });

  it("fails closed before an old bridge can resume a lease", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404));

    await expect(plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-env-env-1",
      leaseMetadata: { sandboxAcquisitionId: "acquisition-1" },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    })).rejects.toThrow("does not support ownership API v2");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://bridge.example.workers.dev/api/paperclip-sandbox/v2/leases/resume",
    );
  });

  it("preserves a reusable lease and its ownership metadata on release", async () => {
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-scope-one",
      leaseMetadata: {
        acquisitionId: "acquisition-1",
        remoteCwd: "/workspace/custom",
        reuseLease: true,
        reusableSandboxLease: reusableSandboxLease(),
        sessionId: "session-1",
        sessionStrategy: "named",
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
        reuseLease: false,
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a host-marked reusable lease without requiring acquisition metadata on release", async () => {
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-scope-one",
      leaseMetadata: { reuseLease: true, reusableSandboxLease: reusableSandboxLease() },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { version: 1 },
    reusableSandboxLease({ companyId: "company-other" }),
    reusableSandboxLease({ environmentId: "env-other" }),
    reusableSandboxLease({ provider: "other" }),
    reusableSandboxLease({ executionWorkspaceId: "" }),
    reusableSandboxLease({ agentId: "" }),
    reusableSandboxLease({ adapterType: {} }),
    reusableSandboxLease({ runtimeFingerprint: "" }),
  ])("releases a lease whose reusable scope is not host-valid", async (scope) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-scope-one",
      leaseMetadata: {
        acquisitionId: "acquisition-1",
        reusableSandboxLease: scope,
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(requestBodyAt()).toMatchObject({
      providerLeaseId: "pc-scope-one",
      acquisitionId: "acquisition-1",
      reuseLease: false,
    });
  });

  it("destroys an ad-hoc lease even when its environment enables reuse", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-ad-hoc",
      leaseMetadata: {
        acquisitionId: "acquisition-1",
        remoteCwd: "/workspace/custom",
        reuseLease: true,
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
        reuseLease: true,
        keepAlive: true,
      },
    });

    expect(requestBodyAt()).toMatchObject({
      providerLeaseId: "pc-ad-hoc",
      acquisitionId: "acquisition-1",
      reuseLease: false,
    });
  });

  it("passes acquisition ownership when destroying a lease", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await plugin.definition.onEnvironmentDestroyLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-scope-one",
      leaseMetadata: {
        acquisitionId: "acquisition-1",
        remoteCwd: "/workspace/custom",
        sessionId: "session-1",
        sessionStrategy: "named",
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(requestBodyAt()).toMatchObject({
      providerLeaseId: "pc-scope-one",
      acquisitionId: "acquisition-1",
      requestedCwd: "/workspace/custom",
      sessionId: "session-1",
    });
    expect(requestHeadersAt().get("X-Paperclip-Acquisition-Id")).toBe("acquisition-1");
  });

  it("uses the host acquisition identity when cleaning up a partial reusable acquisition", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await plugin.definition.onEnvironmentDestroyLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-scope-one",
      leaseMetadata: {
        acquisitionId: "stale-bridge-acquisition",
        sandboxAcquisitionId: "host-acquisition",
        remoteCwd: "/workspace/custom",
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(requestBodyAt()).toMatchObject({
      providerLeaseId: "pc-scope-one",
      acquisitionId: "host-acquisition",
      requestedCwd: "/workspace/custom",
    });
    expect(requestHeadersAt().get("X-Paperclip-Acquisition-Id")).toBe("host-acquisition");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://bridge.example.workers.dev/api/paperclip-sandbox/v2/leases/pc-scope-one",
    );
  });

  it("passes bridge execute results through unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "/workspace/paperclip\n",
        stderr: "",
      }),
    );

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: {
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: { sandboxAcquisitionId: "acquisition-1" },
      },
      command: "pwd",
      args: [],
      cwd: "/workspace/paperclip",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "/workspace/paperclip\n",
      stderr: "",
    });
    expect(requestBodyAt()).toMatchObject({ acquisitionId: "acquisition-1" });
    expect(requestHeadersAt().get("X-Paperclip-Acquisition-Id")).toBe("acquisition-1");
  });

  it("does not issue an unscoped execute request when lease ownership metadata is missing", async () => {
    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: { providerLeaseId: "pc-run-1-abcd1234", metadata: {} },
      command: "pwd",
      args: [],
      cwd: "/workspace/paperclip",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Cloudflare sandbox lease ownership metadata is missing.\n",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes bridge-channel execute calls through a dedicated session", async () => {
    // pluginLogger must be set for the streaming branch to be reachable, so
    // we can assert that bridge-channel calls take the non-streaming path
    // even when adapter sessions would otherwise stream.
    await plugin.definition.setup?.({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    } as never);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
      }),
    );

    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: {
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: { acquisitionId: "acquisition-1" },
      },
      command: "sh",
      args: ["-lc", "ls"],
      cwd: "/workspace/paperclip",
      env: {
        PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
        KEEP_ME: "visible",
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
        sessionStrategy: "default",
        sessionId: "paperclip",
      },
    });

    expect(requestBodyAt()).toMatchObject({
      sessionStrategy: "named",
      sessionId: "paperclip-bridge",
      env: {
        KEEP_ME: "visible",
      },
    });
    expect(requestBodyAt().env).not.toHaveProperty("PAPERCLIP_SANDBOX_EXEC_CHANNEL");
    // Bridge-channel commands must use the non-streaming exec path. The
    // @cloudflare/sandbox SDK's streaming mode can drop the final stdout
    // chunk when a short shell exits the same tick it writes — bridge ops
    // carry machine-consumed stdout (readiness JSON, base64 file payloads,
    // queue response bodies) where that data loss surfaces as opaque
    // "invalid readiness JSON" / "Invalid bridge request payload" errors.
    expect(requestBodyAt().streamOutput).toBe(false);
  });

  it("uses streaming exec for non-bridge adapter commands so live logs flow", async () => {
    // Streaming is gated on `pluginLogger` being set, which normally happens
    // in `setup()`. Wire a minimal logger so the streaming branch is reachable.
    await plugin.definition.setup?.({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    } as never);
    fetchMock.mockResolvedValueOnce(
      new Response(
        "event: stdout\ndata: {\"data\":\"hello\\n\"}\n\nevent: complete\ndata: {\"exitCode\":0,\"signal\":null,\"timedOut\":false,\"stdout\":\"hello\\n\",\"stderr\":\"\"}\n\n",
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: {
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: { acquisitionId: "acquisition-1" },
      },
      command: "echo",
      args: ["hello"],
      cwd: "/workspace/paperclip",
      env: { KEEP_ME: "visible" },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
        sessionStrategy: "named",
        sessionId: "paperclip",
      },
    });

    expect(requestBodyAt().streamOutput).toBe(true);
  });

  it("maps lost-lease execute errors into a deterministic command failure", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "sandbox_state_lost",
          message: "Cloudflare sandbox state is no longer available.",
        },
        409,
      ),
    );

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: {
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: { acquisitionId: "acquisition-1" },
      },
      command: "pwd",
      args: [],
      cwd: "/workspace/paperclip",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Cloudflare sandbox state is no longer available.\n",
    });
  });

  it("wraps realizeWorkspace bridge failures and forwards the issue header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "command_failed",
          message: "mkdir: permission denied",
        },
        500,
      ),
    );

    await expect(plugin.definition.onEnvironmentRealizeWorkspace?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      issueId: "issue-1",
      lease: {
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: {
          acquisitionId: "acquisition-1",
          remoteCwd: "/workspace/paperclip",
        },
      },
      workspace: {
        localPath: "/tmp/project",
        metadata: {
          workspaceRealizationRequest: {
            issueId: "issue-1",
          },
        },
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    })).rejects.toThrow("Failed to prepare Cloudflare sandbox workspace at /workspace/paperclip: mkdir: permission denied");

    expect(requestHeadersAt().get("X-Paperclip-Issue-Id")).toBe("issue-1");
    expect(requestHeadersAt().get("X-Paperclip-Acquisition-Id")).toBe("acquisition-1");
    expect(requestBodyAt()).toMatchObject({ acquisitionId: "acquisition-1" });
  });

  it("does not issue an unscoped realizeWorkspace request when lease ownership metadata is missing", async () => {
    await expect(plugin.definition.onEnvironmentRealizeWorkspace?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: {
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: { remoteCwd: "/workspace/paperclip" },
      },
      workspace: { localPath: "/tmp/project" },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    })).rejects.toThrow(
      "Failed to prepare Cloudflare sandbox workspace at /workspace/paperclip: Cloudflare sandbox lease ownership metadata is missing.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
