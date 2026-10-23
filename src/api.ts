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

export interface ProviderConfiguration {
  id: string;
  name: string;
  configured: boolean;
  required_settings: string[];
  note: string;
}

export interface ProviderConfigurationResponse {
  providers: ProviderConfiguration[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStatusItems(value: unknown, section: "components" | "incidents") {
  if (!Array.isArray(value)) throw new ApiError(`Cloudflare response has invalid ${section}.`);
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.status !== "string") {
      throw new ApiError(`Cloudflare response has an invalid ${section} entry at index ${index}.`);
    }
    return { name: item.name, status: item.status };
  });
}

export function parseCloudflareStatus(value: unknown): CloudflareStatus {
  if (!isRecord(value) || !isRecord(value.status) || !isRecord(value.page)) {
    throw new ApiError("Cloudflare response is missing its status summary.");
  }
  if (typeof value.status.indicator !== "string" || typeof value.status.description !== "string") {
    throw new ApiError("Cloudflare response has an invalid status summary.");
  }
  const updatedAt = value.page.updated_at;
  if (updatedAt !== undefined && updatedAt !== null && typeof updatedAt !== "string") {
    throw new ApiError("Cloudflare response has an invalid update timestamp.");
  }
  return {
    provider: "Cloudflare",
    indicator: value.status.indicator,
    description: value.status.description,
    updated_at: updatedAt ?? null,
    components: readStatusItems(value.components, "components"),
    incidents: readStatusItems(value.incidents, "incidents"),
  };
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: new Headers({
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...Object.fromEntries(new Headers(init?.headers).entries()),
      }),
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ApiError("The monitoring API request timed out.", undefined, "timeout");
    }
    throw new ApiError("Could not connect to the monitoring API.", undefined, "disconnected");
  }
  if (!response.ok) {
    let message = `API request failed (${response.status})`;
    let code = "http_error";
    try {
      const body = await response.json();
      message = body?.error?.message || message;
      code = body?.error?.code || code;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError("The monitoring API returned an invalid response.", response.status, "invalid_response");
  }
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
  cloudflare: async () => parseCloudflareStatus(await request<unknown>("/api/providers/cloudflare", undefined, 12_000)),
  providerConfiguration: () => request<ProviderConfigurationResponse>("/api/providers/config"),
  events: () => request<MonitoringEvent[]>("/api/events?limit=50"),
};
