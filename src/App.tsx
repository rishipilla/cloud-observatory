import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Activity, AlertCircle, Check, CheckCircle2, CircleHelp, Cloud, ExternalLink,
  RefreshCw, Search, Server, Settings2, Signal, Timer, X,
} from "lucide-react";
import { api, type CheckResult, type CloudflareStatus, type MonitoredEndpoint, type MonitoringEvent, type Overview } from "./api";
import { Badge, Button, Card, EmptyState, LoadingState } from "./components/ui";
import { loadPreferences, savePreferences, type RefreshInterval, type ThemePreference } from "./preferences";

const ResponseTimeChart = lazy(() =>
  import("./components/ResponseTimeChart").then(({ ResponseTimeChart: Chart }) => ({ default: Chart })),
);

type ProviderState = "Operational" | "Degraded" | "Unavailable" | "Loading";
type ConnectionState = "Loading" | "Connected" | "Disconnected";
type Provider = { name: string; description: string; state: ProviderState; updated?: string; configured?: boolean };
type EndpointFilter = "all" | "up" | "down" | "unchecked";
type EndpointSort = "name" | "status" | "latency";

const navigationItems = [
  { label: "Overview", target: "overview", icon: Activity },
  { label: "Endpoints", target: "endpoints", icon: Server },
  { label: "Activity", target: "events", icon: Signal },
  { label: "Preferences", target: "preferences", icon: Settings2 },
];

function stateFromIndicator(indicator: string): ProviderState {
  if (indicator === "none") return "Operational";
  if (indicator === "minor" || indicator === "major" || indicator === "critical") return "Degraded";
  return "Unavailable";
}

function StatusPill({ state }: { state: ProviderState }) {
  return <Badge className={`status-pill ${state.toLowerCase()}`}><i />{state}</Badge>;
}

function formatTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function App() {
  const [preferences, setPreferences] = useState(() => loadPreferences());
  const { theme, refreshInterval } = preferences;
  const [providers, setProviders] = useState<Provider[]>([
    { name: "Cloudflare", description: "Global network · DNS · CDN", state: "Loading" },
    { name: "Google Cloud", description: "Integration not connected", state: "Unavailable" },
    { name: "AWS", description: "Integration not connected", state: "Unavailable" },
  ]);
  const [cloudflare, setCloudflare] = useState<CloudflareStatus | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [endpoints, setEndpoints] = useState<MonitoredEndpoint[]>([]);
  const [checkHistory, setCheckHistory] = useState<Record<number, CheckResult[]>>({});
  const [events, setEvents] = useState<MonitoringEvent[]>([]);
  const [apiState, setApiState] = useState<ConnectionState>("Loading");
  const [databaseState, setDatabaseState] = useState<ConnectionState>("Loading");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [lastAttempt, setLastAttempt] = useState<Date | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [activeNav, setActiveNav] = useState("Overview");
  const [showEvents, setShowEvents] = useState(true);
  const [eventSearch, setEventSearch] = useState("");
  const [endpointSearch, setEndpointSearch] = useState("");
  const [endpointFilter, setEndpointFilter] = useState<EndpointFilter>("all");
  const [endpointSort, setEndpointSort] = useState<EndpointSort>("name");
  const [notice, setNotice] = useState("");
  const [endpointName, setEndpointName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [savingEndpoint, setSavingEndpoint] = useState(false);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [history, setHistory] = useState<CheckResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [chartRange, setChartRange] = useState<1 | 6 | 24>(24);
  const refreshingRef = useRef(false);

  async function refreshData() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setLoading(true);
    setRefreshError("");
    try {
      await api.health();
      setApiState("Connected");
      let failed = false;
      try {
        await api.ready();
        setDatabaseState("Connected");
      } catch {
        setDatabaseState("Disconnected");
        failed = true;
      }
      const results = await Promise.allSettled([api.overview(), api.endpoints(), api.events(), api.cloudflare(), api.providerConfiguration()]);
      const [overviewResult, endpointsResult, eventsResult, cloudflareResult, configurationResult] = results;
      if (overviewResult.status === "fulfilled") setOverview(overviewResult.value);
      else failed = true;
      if (endpointsResult.status === "fulfilled") {
        setEndpoints(endpointsResult.value);
        const historyResults = await Promise.allSettled(endpointsResult.value.map((endpoint) => api.history(endpoint.id, 500)));
        const loadedHistory: Record<number, CheckResult[]> = {};
        historyResults.forEach((result, index) => {
          if (result.status === "fulfilled") loadedHistory[endpointsResult.value[index].id] = result.value;
          else failed = true;
        });
        setCheckHistory(loadedHistory);
      } else failed = true;
      if (eventsResult.status === "fulfilled") setEvents(eventsResult.value);
      else failed = true;
      if (cloudflareResult.status === "fulfilled") {
        const data = cloudflareResult.value;
        setCloudflare(data);
        setProviders((current) => current.map((provider) => provider.name === "Cloudflare"
          ? { ...provider, description: data.description, state: stateFromIndicator(data.indicator), updated: data.updated_at || undefined }
          : provider));
      } else {
        failed = true;
        setProviders((current) => current.map((provider) => provider.name === "Cloudflare"
          ? provider.state === "Loading"
            ? { ...provider, state: "Unavailable", description: "Public status API could not be reached" }
            : provider
          : provider));
      }
      if (configurationResult.status === "fulfilled") {
        const configuredProviders = new Map(configurationResult.value.providers.map((provider) => [provider.id, provider]));
        setProviders((current) => current.map((provider) => {
          const id = provider.name === "Google Cloud" ? "google_cloud" : provider.name.toLowerCase();
          const configuration = configuredProviders.get(id);
          if (!configuration || provider.name === "Cloudflare") return provider;
          return {
            ...provider,
            configured: configuration.configured,
            description: configuration.configured
              ? "Credentials present · monitoring adapter unavailable"
              : "Not configured · integration unavailable",
          };
        }));
      } else {
        failed = true;
      }
      setStale(failed);
      if (!failed) setLastUpdated(new Date());
      if (failed) setRefreshError("One or more data sources did not refresh. Previously loaded values are retained where available.");
    } catch (error) {
      setApiState("Disconnected");
      setDatabaseState("Disconnected");
      setStale(true);
      setRefreshError(error instanceof Error ? error.message : "Could not reach the monitoring API.");
    } finally {
      setLastAttempt(new Date());
      setLoading(false);
      refreshingRef.current = false;
    }
  }

  useEffect(() => {
    void refreshData();
    const timer = window.setInterval(() => void refreshData(), refreshInterval * 1000);
    return () => window.clearInterval(timer);
  }, [refreshInterval]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (!savePreferences(preferences)) {
      setNotice("Browser storage is unavailable; dashboard preferences could not be saved.");
    }
  }, [preferences, theme]);

  async function createEndpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = endpointName.trim();
    if (!name) {
      setNotice("Enter an endpoint name.");
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(endpointUrl.trim());
    } catch {
      setNotice("Enter a valid HTTP or HTTPS URL.");
      return;
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || (parsedUrl.port && !["80", "443"].includes(parsedUrl.port))) {
      setNotice("Use a public HTTP or HTTPS URL on a standard port without embedded credentials.");
      return;
    }
    setSavingEndpoint(true);
    try {
      if (editingId === null) {
        await api.createEndpoint({ name, url: parsedUrl.href });
        setNotice("Endpoint added. Run a check to record its first result.");
      } else {
        await api.updateEndpoint(editingId, { name, url: parsedUrl.href });
        setNotice("Endpoint updated.");
      }
      setEndpointName("");
      setEndpointUrl("");
      setEditingId(null);
      await refreshData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not add endpoint.");
    } finally {
      setSavingEndpoint(false);
    }
  }

  async function runCheck(id: number) {
    setCheckingId(id);
    try {
      await api.checkEndpoint(id);
      await refreshData();
      if (historyId === id) setHistory(await api.history(id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The endpoint check failed.");
    } finally {
      setCheckingId(null);
    }
  }

  async function removeEndpoint(id: number) {
    const endpoint = endpoints.find((item) => item.id === id);
    if (!window.confirm(`Remove ${endpoint?.name ?? "this endpoint"} and its check history?`)) return;
    try {
      await api.deleteEndpoint(id);
      if (historyId === id) {
        setHistoryId(null);
        setHistory([]);
      }
      if (editingId === id) {
        setEditingId(null);
        setEndpointName("");
        setEndpointUrl("");
      }
      await refreshData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete endpoint.");
    }
  }

  async function toggleHistory(id: number) {
    if (historyId === id) {
      setHistoryId(null);
      return;
    }
    setHistoryId(id);
    setHistoryLoading(true);
    try {
      setHistory(await api.history(id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load endpoint history.");
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  const filteredEvents = useMemo(
    () => events.filter((event) => `${event.type} ${event.message}`.toLowerCase().includes(eventSearch.toLowerCase())),
    [events, eventSearch],
  );
  const visibleEndpoints = useMemo(() => endpoints
    .filter((endpoint) => `${endpoint.name} ${endpoint.url}`.toLowerCase().includes(endpointSearch.toLowerCase()))
    .filter((endpoint) => {
      if (endpointFilter === "up") return endpoint.last_check?.success === true;
      if (endpointFilter === "down") return endpoint.last_check?.success === false;
      if (endpointFilter === "unchecked") return endpoint.last_check === null;
      return true;
    })
    .sort((a, b) => {
      if (endpointSort === "status") {
        const rank = (endpoint: MonitoredEndpoint) => endpoint.last_check === null ? 1 : endpoint.last_check.success ? 0 : 2;
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      }
      if (endpointSort === "latency") {
        return (a.last_check?.elapsed_ms ?? Number.POSITIVE_INFINITY) - (b.last_check?.elapsed_ms ?? Number.POSITIVE_INFINITY)
          || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    }), [endpoints, endpointSearch, endpointFilter, endpointSort]);
  const chartSeries = useMemo(() => {
    const earliest = Date.now() - chartRange * 60 * 60 * 1000;
    return endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      checks: (checkHistory[endpoint.id] ?? [])
        .flatMap((check) => {
          const timestamp = new Date(check.checked_at).getTime();
          if (timestamp < earliest || check.elapsed_ms === null) return [];
          return [{ timestamp, elapsed_ms: check.elapsed_ms }];
        }),
    })).filter((series) => series.checks.length > 0);
  }, [endpoints, checkHistory, chartRange]);
  const chartCheckCount = chartSeries.reduce((total, series) => total + series.checks.length, 0);
  const measuredResponses = endpoints.flatMap((endpoint) => {
    const elapsed = endpoint.last_check?.elapsed_ms;
    return elapsed === null || elapsed === undefined ? [] : [elapsed];
  });
  const averageResponseTime = measuredResponses.length
    ? measuredResponses.reduce((total, elapsed) => total + elapsed, 0) / measuredResponses.length
    : null;

  function scrollTo(target: Element | null) {
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    }
  }

  function editEndpoint(endpoint: MonitoredEndpoint) {
    setEditingId(endpoint.id);
    setEndpointName(endpoint.name);
    setEndpointUrl(endpoint.url);
    document.getElementById("endpoint-name")?.focus();
    scrollTo(document.querySelector(".endpoint-form"));
  }

  function cancelEndpointEdit() {
    setEditingId(null);
    setEndpointName("");
    setEndpointUrl("");
  }

  function navigateTo(label: string, targetId: string) {
    setActiveNav(label);
    setNotice("");
    if (targetId === "events") setShowEvents(true);
    scrollTo(document.getElementById(targetId));
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <aside className="sidebar" aria-label="Application sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><Cloud size={20} strokeWidth={1.8} /></div>
          <div><strong>Cloud <span>Observatory</span></strong><small>SERVICE MONITORING</small></div>
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <span className="nav-label">WORKSPACE</span>
          {navigationItems.map(({ label, target, icon: Icon }) => (
            <button
              type="button"
              key={label}
              className={`nav-item ${activeNav === label ? "active" : ""}`}
              aria-label={label}
              aria-current={activeNav === label ? "page" : undefined}
              onClick={() => navigateTo(label, target)}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
              {label === "Activity" && <span className="nav-count">{events.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-card">
            <span className={`connection-dot ${apiState.toLowerCase()}`} aria-hidden="true" />
            <div><strong>Monitoring API</strong><small>{apiState === "Connected" ? "Connected" : apiState === "Loading" ? "Checking connection" : "Disconnected"}</small></div>
          </div>
          <div className="database-status">
            <span className={`connection-dot ${databaseState.toLowerCase()}`} aria-hidden="true" />
            <span>Database {databaseState === "Connected" ? "ready" : databaseState === "Loading" ? "checking" : "unavailable"}</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>Cloud Observatory</span><span className="slash">/</span><strong>{activeNav}</strong></div>
          <div className="top-actions">
            <span className={`api-status ${apiState.toLowerCase()}`}><i aria-hidden="true" />{apiState === "Connected" ? "API connected" : apiState === "Loading" ? "Connecting" : "API disconnected"}</span>
            <Button className="icon-button" aria-label="Dashboard preferences" onClick={() => navigateTo("Preferences", "preferences")}><Settings2 size={17}/></Button>
            <Button className="button-primary" aria-label="Refresh data" onClick={() => void refreshData()} disabled={loading} aria-busy={loading}>
              <RefreshCw size={15} className={loading ? "spin" : ""} aria-hidden="true" />{loading ? "Refreshing" : "Refresh"}
            </Button>
          </div>
        </header>

        <section className="page-heading" id="overview">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" />MONITORING OVERVIEW</div>
            <h1>Service health</h1>
            <p>Monitor endpoint checks, provider status, and recent service events.</p>
          </div>
          <div className="heading-actions">
            <Button className="button-secondary" onClick={() => setShowEvents(!showEvents)} aria-expanded={showEvents} aria-controls="events">
              <Activity size={15} aria-hidden="true" />{showEvents ? "Hide activity" : "Show activity"}
            </Button>
          </div>
        </section>
        {notice && <div className="notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss"><X size={15}/></button></div>}

        <div className={`data-banner ${apiState === "Disconnected" ? "banner-error" : stale ? "banner-stale" : ""}`}>
          <span className="banner-icon"><Signal size={15} aria-hidden="true" /></span>
          <div><strong>{apiState === "Loading" ? "Connecting to monitoring API" : apiState === "Disconnected" ? "Monitoring API disconnected" : stale ? "Showing stale or partial data" : "Live monitoring data"}</strong>
            <span>{apiState === "Disconnected" ? "Start the FastAPI backend and verify VITE_API_BASE_URL. Previously loaded results are retained." : "Endpoint checks, events, and public provider status are loaded from the backend."}</span>
          </div>
          <span className="banner-tag">{lastUpdated ? `UPDATED ${lastUpdated.toLocaleTimeString([], { hour12: false })}` : apiState.toUpperCase()}</span>
        </div>
        {refreshError && <div className="refresh-error" role="status"><span>{refreshError}</span><span>{lastAttempt ? `Last attempt ${lastAttempt.toLocaleTimeString([], { hour12: false })}` : ""}</span></div>}

        <section className="metric-grid" aria-label="Endpoint summary">
          <Card className="metric-card">
            <div className="metric-top"><span>MONITORED ENDPOINTS</span><Server size={17} aria-hidden="true" /></div>
            <div className="metric-value">{overview?.endpoints_total ?? "—"}</div>
            <div className="metric-foot"><span>Configured endpoints</span></div>
          </Card>
          <Card className="metric-card">
            <div className="metric-top"><span>HEALTHY</span><CheckCircle2 size={17} aria-hidden="true" /></div>
            <div className="metric-value metric-positive">{overview?.endpoints_healthy ?? "—"}</div>
            <div className="metric-foot"><span>Passing latest check</span></div>
          </Card>
          <Card className="metric-card">
            <div className="metric-top"><span>FAILING</span><AlertCircle size={17} aria-hidden="true" /></div>
            <div className={`metric-value ${overview?.endpoints_failing ? "metric-negative" : ""}`}>{overview?.endpoints_failing ?? "—"}</div>
            <div className="metric-foot"><span>Failing latest check</span></div>
          </Card>
          <Card className="metric-card">
            <div className="metric-top"><span>AVG. RESPONSE TIME</span><Timer size={17} aria-hidden="true" /></div>
            <div className="metric-value">{averageResponseTime === null ? "—" : averageResponseTime.toFixed(0)}<span className="metric-unit">{averageResponseTime === null ? "" : " ms"}</span></div>
            <div className="metric-foot"><span>{measuredResponses.length ? `From ${measuredResponses.length} latest check${measuredResponses.length === 1 ? "" : "s"}` : "No check results yet"}</span></div>
          </Card>
        </section>

        <section className="endpoint-section panel" id="endpoints">
          <div className="panel-header"><div><div className="panel-kicker">HTTP MONITORING</div><h2>Monitored endpoints</h2></div><span className="event-count" aria-label={`${endpoints.length} endpoints`}>{endpoints.length}</span></div>
          {endpoints.length > 0 && <div className="endpoint-toolbar">
            <label className="endpoint-search"><Search size={14}/><input aria-label="Search monitored endpoints" placeholder="Search services or URLs" value={endpointSearch} onChange={(event) => setEndpointSearch(event.target.value)}/></label>
            <label className="endpoint-select-label">Status<select aria-label="Filter endpoints by status" className="endpoint-select" value={endpointFilter} onChange={(event) => setEndpointFilter(event.target.value as EndpointFilter)}>
              <option value="all">All statuses</option><option value="up">Healthy</option><option value="down">Failing</option><option value="unchecked">Not checked</option>
            </select></label>
            <label className="endpoint-select-label">Sort<select aria-label="Sort monitored endpoints" className="endpoint-select" value={endpointSort} onChange={(event) => setEndpointSort(event.target.value as EndpointSort)}>
              <option value="name">Name</option><option value="status">Status</option><option value="latency">Response time</option>
            </select></label>
          </div>}
          {apiState === "Disconnected" ? <EmptyState title="Monitoring API disconnected">Endpoint data cannot be loaded until the backend reconnects.</EmptyState> : endpoints.length === 0 ? loading ? <LoadingState label="Loading configured endpoints…" /> : <EmptyState title="No endpoints configured">Add a public HTTP or HTTPS URL to begin monitoring.</EmptyState> : visibleEndpoints.length === 0 ? <EmptyState title="No matching endpoints">Adjust the search or status filter to see monitored services.</EmptyState> : (
            <div className="endpoint-list" role="list">{visibleEndpoints.map((endpoint) => <article className="endpoint-item" key={endpoint.id} role="listitem">
              <div className="endpoint-details"><strong>{endpoint.name}</strong><a href={endpoint.url} target="_blank" rel="noreferrer">{endpoint.url}<ExternalLink size={11} aria-hidden="true" /></a></div>
              <div className="endpoint-result">{endpoint.last_check ? <><StatusPill state={endpoint.last_check.success ? "Operational" : "Degraded"}/><small>{endpoint.last_check.status_code ? `HTTP ${endpoint.last_check.status_code}` : endpoint.last_check.error} · {endpoint.last_check.elapsed_ms == null ? "—" : `${endpoint.last_check.elapsed_ms.toFixed(0)} ms`} · {formatTime(endpoint.last_check.checked_at)}</small></> : <small>No check has run</small>}</div>
              <div className="endpoint-actions"><Button className="text-button" disabled={checkingId === endpoint.id} aria-busy={checkingId === endpoint.id} onClick={() => void runCheck(endpoint.id)}>{checkingId === endpoint.id ? "Checking…" : "Check now"}</Button><Button className="text-button" aria-expanded={historyId === endpoint.id} onClick={() => void toggleHistory(endpoint.id)}>{historyId === endpoint.id ? "Hide history" : "History"}</Button><Button className="text-button" onClick={() => editEndpoint(endpoint)}>Edit</Button><Button className="text-button danger-button" onClick={() => void removeEndpoint(endpoint.id)}>Remove</Button></div>
              {historyId === endpoint.id && <div className="history-list" aria-label={`Check history for ${endpoint.name}`}>{historyLoading ? <LoadingState label="Loading history…" /> : history.length ? history.map((check) => <div key={check.id}><span>{check.success ? "UP" : "DOWN"}</span><span>{check.status_code || check.error}</span><span>{check.elapsed_ms == null ? "—" : `${check.elapsed_ms.toFixed(0)} ms`}</span><time>{formatTime(check.checked_at)}</time></div>) : <EmptyState title="No check history yet">Run a check to collect the first result.</EmptyState>}</div>}
            </article>)}</div>
          )}
          <form className="endpoint-form" onSubmit={(event) => void createEndpoint(event)}>
            <input id="endpoint-name" aria-label="Endpoint name" placeholder="Endpoint name" value={endpointName} onChange={(event) => setEndpointName(event.target.value)} required maxLength={120}/>
            <input aria-label="Public HTTP or HTTPS URL" placeholder="https://example.com/health" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} required/>
            <Button className="button-primary" type="submit" disabled={savingEndpoint || apiState !== "Connected"}>{savingEndpoint ? editingId === null ? "Adding…" : "Saving…" : editingId === null ? "Add endpoint" : "Save endpoint"}</Button>
            {editingId !== null && <Button className="button-secondary" type="button" onClick={cancelEndpointEdit}>Cancel edit</Button>}
          </form>
          <div className="endpoint-note">Only public destinations on standard HTTP/HTTPS ports are allowed. Local, private, link-local, and reserved addresses and redirects are blocked.</div>
        </section>

        <section className="content-grid">
          <article className="panel provider-panel">
            <div className="panel-header"><div><div className="panel-kicker">UPSTREAM STATUS</div><h2>Provider health</h2></div></div>
            <div className="provider-list">{providers.map((provider) => <div className="provider-row" key={provider.name}><div className={`provider-logo ${provider.name.toLowerCase().replace(" ", "-")}`} aria-hidden="true">{provider.name === "AWS" ? <span className="aws-mark">AWS</span> : provider.name === "Google Cloud" ? <span className="google-mark">G</span> : <Cloud size={17}/>}</div><div className="provider-info"><strong>{provider.name}</strong><small>{provider.description}</small></div><StatusPill state={provider.state}/></div>)}</div>
            {cloudflare?.incidents.length ? <div className="provider-extra">Active Cloudflare incidents: {cloudflare.incidents.map((incident) => incident.name).join(", ")}</div> : null}
            <div className="provider-footer"><span>{lastUpdated ? `Checked ${lastUpdated.toLocaleTimeString([], { hour12: false })}` : "Waiting for first check"}</span><a href="https://www.cloudflarestatus.com/" target="_blank" rel="noreferrer">Status source <ExternalLink size={12}/></a></div>
          </article>

          <article className="panel chart-panel" id="response-times">
            <div className="panel-header chart-header"><div><div className="panel-kicker">PERSISTED CHECKS</div><h2>Response time</h2></div><div className="chart-ranges" role="group" aria-label="Chart time range">{([1, 6, 24] as const).map((hours) => <Button key={hours} className={`chart-range ${chartRange === hours ? "selected" : ""}`} aria-pressed={chartRange === hours} onClick={() => setChartRange(hours)}>{hours}h</Button>)}</div></div>
            <div className="chart-summary"><strong>Measured HTTP check duration</strong><span>{chartCheckCount} persisted sample{chartCheckCount === 1 ? "" : "s"} · {chartSeries.length} endpoint{chartSeries.length === 1 ? "" : "s"}</span></div>
            {chartCheckCount === 0 ? <EmptyState title="No response-time data for this range">Run endpoint checks to chart measured response time.</EmptyState> : <div className="chart-wrap"><Suspense fallback={<LoadingState label="Loading response-time chart…" />}><ResponseTimeChart series={chartSeries} /></Suspense></div>}
            <div className="chart-footer"><span>Measured check duration</span><span>Milliseconds · backend results</span></div>
          </article>
        </section>

        <section className="panel events-panel" id="events" aria-labelledby="events-title">
          <div className="panel-header"><div><div className="panel-kicker">RECENT CHANGES</div><h2 id="events-title">Activity <span className="event-count">{events.length}</span></h2></div><Button className="icon-button" aria-label="Search events" onClick={() => { setShowEvents(true); window.setTimeout(() => document.getElementById("event-search")?.focus(), 0); }}><Search size={14}/></Button></div>
          {showEvents && <><label className="event-search"><Search size={14} aria-hidden="true" /><input id="event-search" aria-label="Filter activity" placeholder="Filter events..." value={eventSearch} onChange={(event) => setEventSearch(event.target.value)}/><Button className="clear-filter" onClick={() => setEventSearch("")}>Clear</Button></label><div className="event-list">{filteredEvents.length ? filteredEvents.map((event) => <div className="event-row" key={event.id}><div className={`event-indicator ${event.type === "recovery" ? "green" : "amber"}`} aria-hidden="true">{event.type === "recovery" ? <Check size={12}/> : <CircleHelp size={12}/>}</div><div className="event-copy"><strong>{event.message}</strong><small>{event.type.replace(/_/g, " ")}</small></div><time>{new Date(event.created_at).toLocaleTimeString([], { hour12: false })}</time></div>) : <div className="empty-state">{apiState === "Disconnected" ? "Events unavailable while the API is disconnected." : events.length === 0 ? "No monitoring events yet. Events appear when checks fail or recover." : "No events match this filter."}</div>}</div></>}
        </section>

        <section className="panel preferences-panel" id="preferences">
          <div className="panel-header"><div><div className="panel-kicker">DASHBOARD</div><h2>Preferences</h2></div></div>
          <div className="preferences-controls">
            <label>Appearance<select aria-label="Theme" className="endpoint-select" value={theme} onChange={(event) => setPreferences((current) => ({ ...current, theme: event.target.value as ThemePreference }))}>
              <option value="obsidian">Obsidian</option><option value="forest">Forest</option>
            </select></label>
            <label>Automatic refresh<select aria-label="Refresh interval" className="endpoint-select" value={refreshInterval} onChange={(event) => setPreferences((current) => ({ ...current, refreshInterval: Number(event.target.value) as RefreshInterval }))}>
              <option value={30}>Every 30 seconds</option><option value={60}>Every minute</option><option value={300}>Every 5 minutes</option>
            </select></label>
            <span>Saved in this browser only. Manual refresh remains available at any time.</span>
          </div>
        </section>
        <footer className="footer"><span>Cloud Observatory <span className="footer-version">v0.1.0</span></span><span>API {apiState.toLowerCase()} · database {databaseState.toLowerCase()}</span></footer>
      </main>
    </div>
  );
}

export default App;
