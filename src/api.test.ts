import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, api, parseCloudflareStatus } from "./api";

const cloudflarePayload = {
  status: { indicator: "minor", description: "Minor service disruption" },
  page: { updated_at: "2026-10-23T19:00:00Z" },
  components: [{ name: "DNS", status: "operational" }],
  incidents: [{ name: "Resolver issue", status: "investigating" }],
};

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare status parsing", () => {
  it("normalizes the provider status payload", () => {
    expect(parseCloudflareStatus(cloudflarePayload)).toEqual({
      provider: "Cloudflare",
      indicator: "minor",
      description: "Minor service disruption",
      updated_at: "2026-10-23T19:00:00Z",
      components: [{ name: "DNS", status: "operational" }],
      incidents: [{ name: "Resolver issue", status: "investigating" }],
    });
  });

  it("rejects malformed status and component data", () => {
    expect(() => parseCloudflareStatus({})).toThrow(ApiError);
    expect(() => parseCloudflareStatus({
      ...cloudflarePayload,
      components: [{ name: "DNS" }],
    })).toThrow(/invalid components entry/);
  });
});

describe("API errors and timeouts", () => {
  it("surfaces structured backend errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "provider_unavailable", message: "Status provider is offline" } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    )));

    await expect(api.health()).rejects.toMatchObject({
      message: "Status provider is offline",
      status: 502,
      code: "provider_unavailable",
    });
  });

  it("reports network timeouts with a typed error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError")));

    await expect(api.health()).rejects.toMatchObject({
      message: "The monitoring API request timed out.",
      code: "timeout",
    });
  });

  it("rejects invalid successful JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    await expect(api.health()).rejects.toMatchObject({ code: "invalid_response" });
  });
});
