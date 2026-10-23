import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { api, type CloudflareStatus } from "./api";

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
      createEndpoint: vi.fn(),
      deleteEndpoint: vi.fn(),
      checkEndpoint: vi.fn(),
      history: vi.fn(),
    },
  };
});

vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: () => <div />,
  CartesianGrid: () => null,
  ResponsiveContainer: () => <div />,
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
  vi.mocked(api.events).mockResolvedValue([]);
  vi.mocked(api.cloudflare).mockResolvedValue(operationalStatus);
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
});
