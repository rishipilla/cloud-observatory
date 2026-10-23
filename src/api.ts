const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

export interface CheckResult {
  id: number;
  endpoint_id: number;
  status_code: number | null;
  elapsed_ms: number | null;
  success: boolean;
  error: string | null;
  checked_at: string;
}

export interface MonitoredEndpoint {
  id: number;
  name: string;
  url: string;
  interval_seconds: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_check: CheckResult | null;
}

export interface Overview {
  endpoints_total: number;
  endpoints_healthy: number;
  endpoints_failing: number;
  active_incidents: number;
  last_checked_at: string | null;
}

export interface MonitoringEvent {
  id: number;
  endpoint_id: number | null;
  type: string;
  message: string;
  created_at: string;
}

export interface CloudflareStatus {
  provider: string;
  indicator: string;
  description: string;
  updated_at: string | null;
  components: { name: string; status: string }[];
  incidents: { name: string; status: string }[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError("Could not connect to the monitoring API.");
  }
  if (!response.ok) {
    let message = `API request failed (${response.status})`;
    try {
      const body = await response.json();
      message = body?.error?.message || message;
    } catch {
      // Keep the HTTP status message when the server response is not JSON.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string }>("/api/health"),
  ready: () => request<{ status: string }>("/api/ready"),
  overview: () => request<Overview>("/api/overview"),
  endpoints: () => request<MonitoredEndpoint[]>("/api/endpoints"),
  createEndpoint: (input: { name: string; url: string }) =>
    request<MonitoredEndpoint>("/api/endpoints", { method: "POST", body: JSON.stringify(input) }),
  deleteEndpoint: (id: number) => request<void>(`/api/endpoints/${id}`, { method: "DELETE" }),
  checkEndpoint: (id: number) => request<CheckResult>(`/api/endpoints/${id}/check`, { method: "POST" }),
  history: (id: number) => request<CheckResult[]>(`/api/endpoints/${id}/history?limit=20`),
  cloudflare: () => request<CloudflareStatus>("/api/providers/cloudflare"),
  events: () => request<MonitoringEvent[]>("/api/events?limit=50"),
};
