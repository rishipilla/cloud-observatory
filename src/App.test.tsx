import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { api, type CloudflareStatus } from "./api";
import { createMemoryStorage } from "./testStorage";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      ready: vi.fn(),
      overview: vi.fn(),
      endpoints: vi.fn(),
      events: vi.fn(),
      cloudflare: vi.fn(),
      providerConfiguration: vi.fn(),
      history: vi.fn(),
      createEndpoint: vi.fn(),
      deleteEndpoint: vi.fn(),
      checkEndpoint: vi.fn(),
    },
  };
});

vi.mock("recharts", () => ({
  CartesianGrid: () => null,
  ResponsiveContainer: () => <div />,
  Scatter: () => null,
  ScatterChart: () => <div />,
  Legend: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const operationalStatus: CloudflareStatus = {
  provider: "Cloudflare",
  indicator: "none",
  description: "All systems operational",
  updated_at: "2026-10-23T19:00:00Z",
  components: [],
  incidents: [],
};

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
  vi.mocked(api.health).mockResolvedValue({ status: "ok" });
  vi.mocked(api.ready).mockResolvedValue({ status: "ready" });
  vi.mocked(api.overview).mockResolvedValue({
    endpoints_total: 0,
    endpoints_healthy: 0,
    endpoints_failing: 0,
    active_incidents: 0,
    last_checked_at: null,
  });
  vi.mocked(api.endpoints).mockResolvedValue([]);
  vi.mocked(api.history).mockResolvedValue([]);
  vi.mocked(api.events).mockResolvedValue([]);
  vi.mocked(api.cloudflare).mockResolvedValue(operationalStatus);
  vi.mocked(api.providerConfiguration).mockResolvedValue({ providers: [] });
});

describe("dashboard interactions", () => {
  it("loads provider status from the API and supports manual refresh", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("Live monitoring data")).toBeInTheDocument();
    expect(await screen.findByText("All systems operational")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh data" }));

    await waitFor(() => expect(api.cloudflare).toHaveBeenCalledTimes(2));
    expect(screen.getByText("No endpoints configured")).toBeInTheDocument();
  });

  it("shows disconnected state when the API is unavailable", async () => {
    vi.mocked(api.health).mockRejectedValueOnce(new Error("offline"));
    render(<App />);

    expect(await screen.findAllByText("Monitoring API disconnected")).toHaveLength(2);
    expect(screen.getByText("Endpoint data cannot be loaded until the backend reconnects.")).toBeInTheDocument();
  });

  it("filters endpoints by text and health status", async () => {
    const user = userEvent.setup();
    vi.mocked(api.endpoints).mockResolvedValue([
      { id: 1, name: "Alpha API", url: "https://alpha.example", interval_seconds: 60, enabled: true, created_at: "2026-10-23T19:00:00Z", updated_at: "2026-10-23T19:00:00Z", last_check: { id: 1, endpoint_id: 1, status_code: 200, elapsed_ms: 10, success: true, error: null, checked_at: "2026-10-23T19:00:00Z" } },
      { id: 2, name: "Beta API", url: "https://beta.example", interval_seconds: 60, enabled: true, created_at: "2026-10-23T19:00:00Z", updated_at: "2026-10-23T19:00:00Z", last_check: { id: 2, endpoint_id: 2, status_code: 503, elapsed_ms: 20, success: false, error: "HTTP 503", checked_at: "2026-10-23T19:00:00Z" } },
      { id: 3, name: "Gamma API", url: "https://gamma.example", interval_seconds: 60, enabled: true, created_at: "2026-10-23T19:00:00Z", updated_at: "2026-10-23T19:00:00Z", last_check: null },
    ]);
    render(<App />);

    expect(await screen.findByText("Alpha API")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter endpoints by status"), "down");
    expect(screen.getByText("Beta API")).toBeInTheDocument();
    expect(screen.queryByText("Alpha API")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter endpoints by status"), "all");
    await user.type(screen.getByLabelText("Search monitored endpoints"), "gamma");
    expect(screen.getByText("Gamma API")).toBeInTheDocument();
    expect(screen.queryByText("Alpha API")).not.toBeInTheDocument();
  });

  it("shows only recorded response-time samples and changes the time range", async () => {
    const user = userEvent.setup();
    vi.mocked(api.endpoints).mockResolvedValue([
      { id: 11, name: "Measured API", url: "https://measured.example", interval_seconds: 60, enabled: true, created_at: "2026-10-23T19:00:00Z", updated_at: "2026-10-23T19:00:00Z", last_check: null },
    ]);
    vi.mocked(api.history).mockResolvedValue([
      { id: 1, endpoint_id: 11, status_code: 200, elapsed_ms: 34.5, success: true, error: null, checked_at: new Date().toISOString() },
    ]);
    render(<App />);

    expect(await screen.findByText("1 persisted sample · 1 endpoint")).toBeInTheDocument();
    expect(screen.queryByText("DEMO DATA")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "1h" }));
    expect(screen.getByRole("button", { name: "1h" })).toHaveAttribute("aria-pressed", "true");
  });

  it("persists theme and refresh interval preferences", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(await screen.findByLabelText("Theme"), "forest");
    await user.selectOptions(screen.getByLabelText("Refresh interval"), "300");

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem("cloud-observatory.preferences.v1") ?? "{}")).toEqual({
      theme: "forest",
      refreshInterval: 300,
    }));
    expect(document.documentElement).toHaveAttribute("data-theme", "forest");
  });

  it("rejects unsupported endpoint URLs and submits valid endpoint details", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("No endpoints configured");
    await user.type(screen.getByLabelText("Endpoint name"), "Sample service");
    await user.type(screen.getByLabelText("Public HTTP or HTTPS URL"), "https://service.example:8443/health");
    await user.click(screen.getByRole("button", { name: "Add endpoint" }));

    expect(await screen.findByText("Use a public HTTP or HTTPS URL on a standard port without embedded credentials.")).toBeInTheDocument();
    expect(api.createEndpoint).not.toHaveBeenCalled();
  });
});
