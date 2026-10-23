import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Activity, Bell, Check, ChevronDown, CircleHelp, Cloud, Cpu, ExternalLink,
  Globe2, Layers3, Network, RefreshCw, Search, Server, Settings2, ShieldCheck, Signal,
  Terminal, Wifi, X
} from "lucide-react";
import {
  CartesianGrid, Legend, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis
} from "recharts";
import { api, type CheckResult, type CloudflareStatus, type MonitoredEndpoint, type MonitoringEvent, type Overview } from "./api";
import { Badge, Button, Card, EmptyState, LoadingState } from "./components/ui";
import { loadPreferences, savePreferences, type RefreshInterval, type ThemePreference } from "./preferences";

type ProviderState = "Operational" | "Degraded" | "Unavailable" | "Loading";
type ConnectionState = "Loading" | "Connected" | "Disconnected";
type Provider = { name: string; description: string; state: ProviderState; updated?: string; configured?: boolean };
type EndpointFilter = "all" | "up" | "down" | "unchecked";
type EndpointSort = "name" | "status" | "latency";

function stateFromIndicator(indicator: string): ProviderState {
  if (indicator === "none") return "Operational";
  if (indicator === "minor" || indicator === "major" || indicator === "critical") return "Degraded";
  return "Unavailable";
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span>{now.toLocaleTimeString([], { hour12: false })}</span>;
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
      await api.createEndpoint({ name, url: parsedUrl.href });
      setEndpointName("");
      setEndpointUrl("");
      setNotice("Endpoint added. Run a check to record its first result.");
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
      endpoint,
      checks: (checkHistory[endpoint.id] ?? [])
        .flatMap((check) => {
          const timestamp = new Date(check.checked_at).getTime();
          if (timestamp < earliest || check.elapsed_ms === null) return [];
          return [{ timestamp, elapsed_ms: check.elapsed_ms }];
        }),
    })).filter((series) => series.checks.length > 0);
  }, [endpoints, checkHistory, chartRange]);
  const chartCheckCount = chartSeries.reduce((total, series) => total + series.checks.length, 0);
  const operationalProviders = providers.filter((provider) => provider.state === "Operational").length;

  function navigateTo(label: string, targetId: string) {
    setActiveNav(label);
    setNotice("");
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Cloud size={21} strokeWidth={1.8} /></div>
          <div><strong>cloud<span>observatory</span></strong><small>INFRASTRUCTURE INTELLIGENCE</small></div>
        </div>
        <div className="workspace"><span className="workspace-icon"><Layers3 size={15}/></span><div><small>WORKSPACE</small><strong>Personal Cloud</strong></div><ChevronDown size={14}/></div>
        <div className="nav-label">MONITORING</div>
        <nav>
          {[
            { label: "Overview", icon: Activity },
            { label: "Global topology", icon: Globe2 },
            { label: "Service health", icon: ShieldCheck },
            { label: "Network", icon: Network },
            { label: "Infrastructure", icon: Server },
            { label: "Event stream", icon: Terminal },
          ].map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${activeNav === label ? "active" : ""}`} onClick={() => navigateTo(label, ({
              Overview: "overview",
              "Global topology": "topology",
              "Service health": "endpoints",
              Network: "topology",
              Infrastructure: "telemetry",
              "Event stream": "events",
            } as Record<string, string>)[label])}>
              <Icon size={17}/><span>{label}</span>{label === "Event stream" && <span className="nav-count">{events.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-card"><span className={`connection-dot ${databaseState.toLowerCase()}`}/><div><strong>Database status</strong><small>{databaseState === "Connected" ? "Ready · persistent storage" : databaseState === "Loading" ? "Checking readiness" : "Disconnected"}</small></div></div>
          <button className="nav-item" onClick={() => navigateTo("Help & settings", "preferences")}><CircleHelp size={17}/><span>Help & settings</span></button>
          <div className="profile"><div className="avatar">CO</div><div><strong>Cloud Operator</strong><small>Local environment</small></div><ChevronDown size={14}/></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>Observability</span><span className="slash">/</span><strong>{activeNav}</strong></div>
          <div className="top-actions">
            <div className="live-clock"><span className="pulse-dot"/><Clock/><span className="timezone">LOCAL</span></div>
            <button className="icon-button" aria-label="Notifications" onClick={() => { if (overview?.active_incidents) { setEventSearch("failure"); navigateTo("Event stream", "events"); } else { setNotice("No active endpoint incidents."); } }}><Bell size={17}/>{Boolean(overview?.active_incidents) && <i/>}</button>
            <button className="icon-button" aria-label="Dashboard preferences" onClick={() => navigateTo("Help & settings", "preferences")}><Settings2 size={17}/></button>
            <div className="top-avatar">R</div>
          </div>
        </header>

        <section className="page-heading" id="overview">
          <div><div className="eyebrow"><span className="eyebrow-line"/> CLOUD CONTROL PLANE <span className="eyebrow-tag">PREVIEW 0.1</span></div>
            <h1>System <span>overview.</span></h1>
            <p>One view into your cloud. Track service health, observe changes, and investigate anomalies.</p>
          </div>
          <div className="heading-actions">
            <Button className="button-secondary" onClick={() => setShowEvents(!showEvents)}><Activity size={15}/>{showEvents ? "Hide activity" : "Show activity"}</Button>
            <Button className="button-primary" onClick={() => void refreshData()} disabled={loading} aria-busy={loading}><RefreshCw size={15} className={loading ? "spin" : ""}/>{loading ? "Refreshing" : "Refresh data"}</Button>
          </div>
        </section>
        {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss"><X size={15}/></button></div>}

        <div className={`data-banner ${apiState === "Disconnected" ? "banner-error" : stale ? "banner-stale" : ""}`}>
          <span className="banner-icon"><Signal size={15}/></span>
          <div><strong>{apiState === "Loading" ? "Connecting to monitoring API" : apiState === "Disconnected" ? "Monitoring API disconnected" : stale ? "Showing stale or partial data" : "Live monitoring data"}</strong>
            <span>{apiState === "Disconnected" ? "Start the FastAPI backend and verify VITE_API_BASE_URL. Previously loaded results are retained." : "Endpoint checks, events, and Cloudflare public status are loaded from the backend. CPU, memory, and throughput have no connected source."}</span>
          </div>
          <span className="banner-tag">{lastUpdated ? `LAST SUCCESS ${lastUpdated.toLocaleTimeString([], { hour12: false })}` : apiState.toUpperCase()}</span>
        </div>
        {refreshError && <div className="refresh-error" role="status"><span>{refreshError}</span><span>{lastAttempt ? `Last attempt ${lastAttempt.toLocaleTimeString([], { hour12: false })}` : ""}</span></div>}

        <section className="metric-grid">
          <Card className="metric-card"><div className="metric-top"><span>MONITORED ENDPOINTS UP</span><ShieldCheck size={17}/></div><div className="metric-value">{overview ? overview.endpoints_healthy : "—"}<span className="metric-total"> / {overview?.endpoints_total ?? "—"}</span></div><div className="metric-foot"><span className="foot-neutral"><Activity size={13}/>Persisted health checks</span><span className="metric-side">LIVE</span></div><div className="metric-bar"><i style={{ width: `${overview?.endpoints_total ? overview.endpoints_healthy / overview.endpoints_total * 100 : 0}%` }}/></div></Card>
          <Card className="metric-card"><div className="metric-top"><span>HOST CPU UTILIZATION</span><Cpu size={17}/></div><div className="metric-value muted-value">—<span className="metric-unit"> %</span></div><div className="metric-foot"><span className="foot-amber">Agent not connected</span><span className="metric-side">NO DATA</span></div><div className="mini-empty"><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/></div></Card>
          <Card className="metric-card"><div className="metric-top"><span>NETWORK THROUGHPUT</span><Wifi size={17}/></div><div className="metric-value muted-value">—<span className="metric-unit"> Mbps</span></div><div className="metric-foot"><span className="foot-amber">Exporter required</span><span className="metric-side">NO DATA</span></div><div className="mini-empty"><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/></div></Card>
          <Card className="metric-card"><div className="metric-top"><span>FAILING ENDPOINTS</span><Bell size={17}/></div><div className="metric-value">{overview ? overview.active_incidents : "—"}</div><div className="metric-foot"><span className="foot-neutral">From latest persisted checks</span><span className="metric-side">LIVE</span></div><div className="incident-track"><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/></div></Card>
        </section>

        <section className="endpoint-section panel" id="endpoints">
          <div className="panel-header"><div><div className="panel-kicker">REAL HTTP MONITORING</div><h2>Monitored endpoints</h2></div><span className="event-count">{endpoints.length}</span></div>
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
            <div className="endpoint-list">{visibleEndpoints.map((endpoint) => <div className="endpoint-item" key={endpoint.id}>
              <div className="endpoint-details"><strong>{endpoint.name}</strong><a href={endpoint.url} target="_blank" rel="noreferrer">{endpoint.url}<ExternalLink size={11}/></a></div>
              <div className="endpoint-result">{endpoint.last_check ? <><StatusPill state={endpoint.last_check.success ? "Operational" : "Degraded"}/><small>{endpoint.last_check.status_code ? `HTTP ${endpoint.last_check.status_code}` : endpoint.last_check.error} · {endpoint.last_check.elapsed_ms == null ? "—" : `${endpoint.last_check.elapsed_ms.toFixed(0)} ms`} · {formatTime(endpoint.last_check.checked_at)}</small></> : <small>No check has run</small>}</div>
              <div className="endpoint-actions"><Button className="text-button" disabled={checkingId === endpoint.id} onClick={() => void runCheck(endpoint.id)}>{checkingId === endpoint.id ? "Checking…" : "Check now"}</Button><Button className="text-button" onClick={() => void toggleHistory(endpoint.id)}>{historyId === endpoint.id ? "Hide history" : "History"}</Button><Button className="text-button danger-button" onClick={() => void removeEndpoint(endpoint.id)}>Remove</Button></div>
              {historyId === endpoint.id && <div className="history-list">{historyLoading ? <LoadingState label="Loading history…" /> : history.length ? history.map((check) => <div key={check.id}><span>{check.success ? "UP" : "DOWN"}</span><span>{check.status_code || check.error}</span><span>{check.elapsed_ms == null ? "—" : `${check.elapsed_ms.toFixed(0)} ms`}</span><time>{formatTime(check.checked_at)}</time></div>) : <EmptyState title="No check history yet">Run a check to collect the first result.</EmptyState>}</div>}
            </div>)}</div>
          )}
          <form className="endpoint-form" onSubmit={(event) => void createEndpoint(event)}>
            <input aria-label="Endpoint name" placeholder="Endpoint name" value={endpointName} onChange={(event) => setEndpointName(event.target.value)} required maxLength={120}/>
            <input aria-label="Public HTTP or HTTPS URL" placeholder="https://example.com/health" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} required/>
            <Button className="button-primary" type="submit" disabled={savingEndpoint || apiState !== "Connected"}>{savingEndpoint ? "Adding…" : "Add endpoint"}</Button>
          </form>
          <div className="endpoint-note">Only public destinations on standard HTTP/HTTPS ports are allowed. Local, private, link-local, and reserved addresses and redirects are blocked.</div>
        </section>

        <section className="content-grid">
          <article className="panel topology-panel" id="topology">
            <div className="panel-header"><div><div className="panel-kicker">NETWORK VISUALIZATION</div><h2>Global service topology</h2></div><Button className="subtle-select" onClick={() => navigateTo("Service health", "endpoints")}>View endpoints <ChevronDown size={13}/></Button></div>
            <div className="topology">
              <div className="topology-grid"/>
              <svg className="topology-lines" viewBox="0 0 720 310" preserveAspectRatio="none" aria-hidden="true">
                <defs><linearGradient id="lineGlow"><stop offset="0%" stopColor="#3cf2a0" stopOpacity=".05"/><stop offset="50%" stopColor="#3cf2a0" stopOpacity=".8"/><stop offset="100%" stopColor="#3cf2a0" stopOpacity=".08"/></linearGradient></defs>
                <path d="M360 150 Q270 70 150 105"/><path d="M360 150 Q460 70 570 100"/><path d="M360 150 Q260 210 175 235"/><path d="M360 150 Q475 210 555 230"/><path d="M150 105 Q155 170 175 235"/><path d="M570 100 Q575 170 555 230"/><path d="M150 105 Q360 10 570 100"/>
                {[["150","105"],["570","100"],["175","235"],["555","230"]].map(([cx,cy],i)=><circle key={i} cx={cx} cy={cy} r="3" fill="#4df2a5"><animate attributeName="opacity" values=".3;1;.3" dur={`${2+i*.4}s`} repeatCount="indefinite"/></circle>)}
              </svg>
              <div className="topo-node core-node"><div className="node-rings"><span/><span/><span/></div><div className="node-center"><Cloud size={24}/></div><div className="node-label"><strong>Cloud edge</strong><small>Public status endpoints</small></div></div>
              <div className="topo-node node-na"><div className="node-dot"><Globe2 size={15}/></div><div className="node-label"><strong>North America</strong><small>External status source</small></div></div>
              <div className="topo-node node-eu"><div className="node-dot"><Globe2 size={15}/></div><div className="node-label"><strong>Europe</strong><small>Not instrumented</small></div></div>
              <div className="topo-node node-ap"><div className="node-dot"><Globe2 size={15}/></div><div className="node-label"><strong>Asia Pacific</strong><small>Not instrumented</small></div></div>
              <div className="topo-node node-sa"><div className="node-dot"><Globe2 size={15}/></div><div className="node-label"><strong>South America</strong><small>Not instrumented</small></div></div>
              <div className="topology-caption"><span className="pulse-dot"/>Animated illustration <span className="caption-divider"/> No live route telemetry</div>
            </div>
            <div className="topology-legend"><span><i className="legend-green"/>Connected data source</span><span><i className="legend-grey"/>Not instrumented</span><span className="legend-right">Topology is illustrative</span></div>
          </article>

          <article className="panel provider-panel">
            <div className="panel-header"><div><div className="panel-kicker">UPSTREAM SERVICES</div><h2>Provider health</h2></div><Button className="icon-button small" onClick={() => void refreshData()} aria-label="Refresh provider health"><RefreshCw size={14}/></Button></div>
            <div className="provider-list">{providers.map((provider) => <div className="provider-row" key={provider.name}><div className={`provider-logo ${provider.name.toLowerCase().replace(" ", "-")}`}>{provider.name === "AWS" ? <span className="aws-mark">aws</span> : provider.name === "Google Cloud" ? <span className="google-mark">G</span> : <Cloud size={17}/>}</div><div className="provider-info"><strong>{provider.name}</strong><small>{provider.description}</small></div><StatusPill state={provider.state}/></div>)}</div>
            {cloudflare?.incidents.length ? <div className="provider-extra">Active Cloudflare incidents: {cloudflare.incidents.map((incident) => incident.name).join(", ")}</div> : null}
            <div className="provider-footer"><span>{lastUpdated ? `Checked ${lastUpdated.toLocaleTimeString([], { hour12: false })}` : "Waiting for first check"}</span><a href="https://www.cloudflarestatus.com/" target="_blank" rel="noreferrer">Status source <ExternalLink size={12}/></a></div>
          </article>
        </section>

        <section className="lower-grid">
          <article className="panel chart-panel" id="telemetry">
            <div className="panel-header chart-header"><div><div className="panel-kicker">PERFORMANCE TELEMETRY</div><h2>Endpoint response time</h2></div><div className="chart-ranges" role="group" aria-label="Chart time range">{([1, 6, 24] as const).map((hours) => <Button key={hours} className={`chart-range ${chartRange === hours ? "selected" : ""}`} aria-pressed={chartRange === hours} onClick={() => setChartRange(hours)}>{hours}h</Button>)}</div></div>
            <div className="chart-summary"><strong>Measured HTTP check duration</strong><span>{chartCheckCount} persisted sample{chartCheckCount === 1 ? "" : "s"} · {chartSeries.length} endpoint{chartSeries.length === 1 ? "" : "s"}</span></div>
            {chartCheckCount === 0 ? <EmptyState title="No response-time data for this range">Run endpoint checks to chart measured response time.</EmptyState> : <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 8, right: 12, left: -16, bottom: 0 }}><CartesianGrid stroke="#1c2923" strokeDasharray="3 5" vertical={false}/><XAxis type="number" dataKey="timestamp" domain={["dataMin", "dataMax"]} tick={{ fill: "#64746b", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}/><YAxis type="number" dataKey="elapsed_ms" name="Response time" unit=" ms" tick={{ fill: "#64746b", fontSize: 10 }} axisLine={false} tickLine={false}/><Tooltip contentStyle={{ background: "#0c1510", border: "1px solid #26392e", borderRadius: 8, color: "#e2f5e9", fontSize: 12 }} labelStyle={{ color: "#8ba696" }} labelFormatter={(value) => new Date(Number(value)).toLocaleString()} formatter={(value) => [`${Number(value).toFixed(1)} ms`, "HTTP check duration"]}/><Legend wrapperStyle={{ color: "#8da195", fontSize: 10 }}/>{chartSeries.map((series, index) => <Scatter key={series.endpoint.id} name={series.endpoint.name} data={series.checks} fill={["#45eda0", "#70a7ff", "#e6b86a", "#d78cf0"][index % 4]} />)}</ScatterChart></ResponsiveContainer></div>}
            <div className="chart-footer"><span><i className="legend-green"/>Measured check duration</span><span>Persisted backend results · milliseconds</span></div>
          </article>
          <article className={`panel events-panel ${showEvents ? "" : "events-collapsed"}`} id="events">
            <div className="panel-header"><div><div className="panel-kicker">OBSERVABILITY LOG</div><h2>Event stream <span className="event-count">{events.length}</span></h2></div><button className="icon-button small" aria-label="Search events" onClick={() => document.getElementById("event-search")?.focus()}><Search size={14}/></button></div>
            {showEvents && <><div className="event-search"><Search size={14}/><input id="event-search" placeholder="Filter events..." value={eventSearch} onChange={(event) => setEventSearch(event.target.value)}/><span>API</span></div><div className="event-list">{filteredEvents.length ? filteredEvents.map((event) => <div className="event-row" key={event.id}><div className={`event-indicator ${event.type === "recovery" ? "green" : "amber"}`}>{event.type === "recovery" ? <Check size={12}/> : <CircleHelp size={12}/>}</div><div className="event-copy"><strong>{event.message}</strong><small>{event.type.replace(/_/g, " ")}</small></div><time>{new Date(event.created_at).toLocaleTimeString([], { hour12: false })}</time></div>) : <div className="empty-state">{apiState === "Disconnected" ? "Events unavailable while the API is disconnected." : events.length === 0 ? "No monitoring events yet. Events appear when checks fail or recover." : "No events match this filter."}</div>}</div><div className="events-footer"><span><span className={`connection-dot ${apiState.toLowerCase()}`}/>{apiState === "Connected" ? "Connected to monitoring API" : apiState === "Loading" ? "Connecting…" : "API disconnected"}</span><button onClick={() => setEventSearch("")}>Clear filter</button></div></>}
          </article>
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
        <footer className="footer"><span>◈ CLOUD OBSERVATORY <span className="footer-version">v0.1.0 · LOCAL PREVIEW</span></span><span><span className={`connection-dot ${apiState.toLowerCase()}`}/> {apiState === "Connected" ? `${operationalProviders} provider(s) operational` : "Monitoring API unavailable"} <span className="footer-divider"/> Response time uses persisted checks</span></footer>
      </main>
    </div>
  );
}

export default App;
