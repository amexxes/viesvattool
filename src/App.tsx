import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import type { FrJobResponse, ValidateBatchResponse, VatRow } from "./types";

type SortState = { colIndex: number | null; asc: boolean };

const COUNTRY_COORDS: Record<string, { lat: number; lon: number }> = {
  AT:{lat:48.2082,lon:16.3738}, BE:{lat:50.8503,lon:4.3517}, BG:{lat:42.6977,lon:23.3219},
  CY:{lat:35.1856,lon:33.3823}, CZ:{lat:50.0755,lon:14.4378}, DE:{lat:52.52,lon:13.405},
  DK:{lat:55.6761,lon:12.5683}, EE:{lat:59.437,lon:24.7536}, EL:{lat:37.9838,lon:23.7275},
  ES:{lat:40.4168,lon:-3.7038}, FI:{lat:60.1699,lon:24.9384}, FR:{lat:48.8566,lon:2.3522},
  HR:{lat:45.815,lon:15.9819}, HU:{lat:47.4979,lon:19.0402}, IE:{lat:53.3498,lon:-6.2603},
  IT:{lat:41.9028,lon:12.4964}, LT:{lat:54.6872,lon:25.2797}, LU:{lat:49.6116,lon:6.1319},
  LV:{lat:56.9496,lon:24.1052}, MT:{lat:35.8989,lon:14.5146}, NL:{lat:52.3676,lon:4.9041},
  PL:{lat:52.2297,lon:21.0122}, PT:{lat:38.7223,lon:-9.1393}, RO:{lat:44.4268,lon:26.1025},
  SE:{lat:59.3293,lon:18.0686}, SI:{lat:46.0569,lon:14.5058}, SK:{lat:48.1486,lon:17.1077},
  XI:{lat:54.5973,lon:-5.9301},
};

function normalizeLine(s: string): string {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function stateClass(state?: string): string {
  const s = String(state || "").toLowerCase();
  if (["valid","invalid","retry","queued","processing","error"].includes(s)) return s;
  return "queued";
}

function stateLabel(state?: string): string {
  const s = String(state || "").toLowerCase();
  return s || "unknown";
}

function valText(v: unknown): string {
  if (v === true) return "true";
  if (v === false) return "false";
  if (v === null || v === undefined || v === "") return "";
  return String(v);
}

function computeCountryCountsFromInput(text: string): Record<string, number> {
  const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const seen = new Set<string>();
  const counts: Record<string, number> = {};

  for (const line of lines) {
    const v = normalizeLine(line);
    if (!v || v.length < 2) continue;

    let cc = v.slice(0, 2);
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    if (cc === "GR") cc = "EL";

    const key = cc + v.slice(2);
    if (seen.has(key)) continue;
    seen.add(key);

    counts[cc] = (counts[cc] || 0) + 1;
  }
  return counts;
}

export default function App() {
  const [vatInput, setVatInput] = useState<string>("");
  const [filter, setFilter] = useState<string>("");
  const [rows, setRows] = useState<VatRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [frText, setFrText] = useState("-");
  const [lastUpdate, setLastUpdate] = useState("-");
  const [progressText, setProgressText] = useState("0/0");

  const [sortState, setSortState] = useState<SortState>({ colIndex: null, asc: true });
  const [sortLabel, setSortLabel] = useState<string>("");

  const [mapLegend, setMapLegend] = useState("—");
  const [mapCount, setMapCount] = useState("0 countries");

  const currentFrJobIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);

  const countryCounts = useMemo(() => computeCountryCountsFromInput(vatInput), [vatInput]);

  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
  }, [rows, filter]);

  const stats = useMemo(() => {
    let total = rows.length;
    let done = 0, vOk = 0, vBad = 0, pending = 0, err = 0;

    for (const r of rows) {
      const st = String(r.state || "").toLowerCase();
      if (st === "valid") { done++; vOk++; }
      else if (st === "invalid") { done++; vBad++; }
      else if (st === "error") { done++; err++; }
      else if (st === "queued" || st === "retry" || st === "processing") { pending++; }
    }

    return { total, done, vOk, vBad, pending, err };
  }, [rows]);

  const progressPct = useMemo(() => {
    if (!stats.total) return 0;
    return Math.round((stats.done / stats.total) * 100);
  }, [stats.total, stats.done]);

  function stopPolling() {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    currentFrJobIdRef.current = null;
  }

  async function pollFrJob(jobId: string) {
    try {
      const resp = await fetch(`/api/fr-job/${encodeURIComponent(jobId)}`);
      if (!resp.ok) return;
      const data = (await resp.json()) as FrJobResponse;

      setFrText(`${data.job.done}/${data.job.total} (${data.job.status})`);

      setRows((prev) => {
        const map = new Map<string, VatRow>();
        for (const r of prev) {
          const k = r.vat_number || r.input || crypto.randomUUID();
          map.set(k, r);
        }
        for (const r of (data.results || [])) {
          const k = r.vat_number || r.input || crypto.randomUUID();
          map.set(k, r);
        }
        return Array.from(map.values());
      });

      setLastUpdate(new Date().toLocaleString("nl-NL"));

      if (data.job.status === "completed") stopPolling();
    } catch {
      // ignore
    }
  }

  async function onValidate() {
    stopPolling();
    setRows([]);
    setFrText("-");
    setLastUpdate("-");
    setSortState({ colIndex: null, asc: true });
    setSortLabel("");
    setLoading(true);

    const lines = vatInput.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { setLoading(false); return; }

    try {
      const resp = await fetch("/api/validate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vat_numbers: lines })
      });
      const data = (await resp.json()) as ValidateBatchResponse;

      setRows(data.results || []);
      setLastUpdate(new Date().toLocaleString("nl-NL"));

      if (data.fr_job_id) {
        currentFrJobIdRef.current = data.fr_job_id;
        await pollFrJob(data.fr_job_id);

        pollTimerRef.current = window.setInterval(() => {
          const id = currentFrJobIdRef.current;
          if (id) void pollFrJob(id);
        }, 3000);
      } else {
        setFrText("-");
      }
    } finally {
      setLoading(false);
    }
  }

  function onClear() {
    stopPolling();
    setVatInput("");
    setFilter("");
    setRows([]);
    setFrText("-");
    setLastUpdate("-");
    setProgressText("0/0");
    setSortState({ colIndex: null, asc: true });
    setSortLabel("");
  }

  function getCellText(r: VatRow, colIndex: number): string {
    const cols: Array<string> = [
      r.source ?? "",
      r.state ?? "",
      r.vat_number ?? "",
      r.country_code ?? "",
      valText(r.valid),
      r.name ?? "",
      r.address ?? "",
      r.error ?? "",
      r.details ?? ""
    ];
    return cols[colIndex] ?? "";
  }

  function sortByColumn(colIndex: number, label: string) {
    setRows((prev) => {
      const asc = (sortState.colIndex === colIndex) ? !sortState.asc : true;
      setSortState({ colIndex, asc });
      setSortLabel(`Sort: ${label} (${asc ? "asc" : "desc"})`);

      const copy = [...prev];
      copy.sort((a, b) => {
        const ta = getCellText(a, colIndex).toLowerCase();
        const tb = getCellText(b, colIndex).toLowerCase();
        const cmp = ta.localeCompare(tb, "nl");
        return asc ? cmp : -cmp;
      });
      return copy;
    });
  }

  useEffect(() => {
    const el = document.getElementById("countryMap");
    if (!el) return;

    try {
      const map = L.map(el, {
        zoomControl: false,
        attributionControl: false,
        dragging: true,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
      }).setView([53.5, 10], 3);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 6,
        minZoom: 2
      }).addTo(map);

      const layer = L.layerGroup().addTo(map);

      mapRef.current = map;
      markerLayerRef.current = layer;
    } catch {
      el.innerHTML = "<div style='padding:12px;color:#6b7280;font-size:12px;'>Map unavailable</div>";
    }

    return () => {
      if (mapRef.current) mapRef.current.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const entries = Object.entries(countryCounts).sort((a,b) => b[1] - a[1]);
    setMapCount(`${entries.length} countries`);

    if (!entries.length) {
      setMapLegend("—");
    } else {
      const top = entries.slice(0, 6).map(([cc,n]) => `${cc}(${n})`).join(" · ");
      const more = entries.length > 6 ? ` +${entries.length - 6}` : "";
      setMapLegend(top + more);
    }

    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();
    const markers: L.Layer[] = [];

    for (const [cc, n] of Object.entries(countryCounts)) {
      const c = COUNTRY_COORDS[cc];
      if (!c) continue;

      const radius = 4 + Math.min(10, Math.round(Math.sqrt(n) * 3));
      const m = L.circleMarker([c.lat, c.lon], {
        radius,
        color: "#0b2e5f",
        weight: 1,
        fillColor: "#2bb3e6",
        fillOpacity: 0.85
      });

      m.bindTooltip(`${cc} • ${n}`, { direction: "top", opacity: 0.9 });
      m.addTo(layer);
      markers.push(m);
    }

    if (markers.length) {
      const group = L.featureGroup(markers as any);
      map.fitBounds(group.getBounds().pad(0.25), { animate: false, maxZoom: 4 });
    } else {
      map.setView([53.5, 10], 3, { animate: false } as any);
    }
  }, [countryCounts]);

  useEffect(() => {
    setProgressText(`${stats.done}/${stats.total}`);
  }, [stats.done, stats.total]);

  return (
    <>
      <div className="banner">
        <div className="banner-accent"></div>
        <div className="banner-inner">
          <div className="brand">
            <div className="mark" aria-label="RSM">
              <div className="mark-bars" aria-hidden="true">
                <span></span><span></span><span></span>
              </div>
              <div className="mark-text">RSM</div>
            </div>
            <div className="title">VAT validation</div>
          </div>
        </div>
      </div>

      <div className="wrap">
        <section className="grid">
          <div className="card">
            <h2>VAT numbers</h2>
            <p className="hint">Paste VAT numbers with country prefix (1 per line). Duplicates are ignored.</p>

            <textarea
              value={vatInput}
              onChange={(e) => setVatInput(e.target.value)}
              placeholder={"FR23450327580\nDE123456789\nRO12345678"}
            />

            <div className="row">
              <button className="btn btn-primary" onClick={() => void onValidate()} disabled={loading}>
                {loading ? "Validating..." : "Validate"}
              </button>
              <button className="btn btn-secondary" onClick={onClear} disabled={loading}>
                Clear
              </button>
            </div>

            <div className="progress" aria-label="Progress bar">
              <div className="bar" style={{ width: `${progressPct}%` }} />
            </div>

            <div className="stats">
              <div className="stat"><span>Total</span><b>{stats.total}</b></div>
              <div className="stat"><span>Done</span><b>{stats.done}</b></div>
              <div className="stat"><span>Valid</span><b>{stats.vOk}</b></div>
              <div className="stat"><span>Invalid</span><b>{stats.vBad}</b></div>
              <div className="stat"><span>Pending</span><b>{stats.pending}</b></div>
              <div className="stat"><span>Error</span><b>{stats.err}</b></div>
            </div>
          </div>

          <div className="card">
            <h2>Filter & notes</h2>
            <div className="filterBox">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter (searches all columns)..."
              />

              <div className="callout">
                <b>France (FR)</b><br/>
                FR is processed in a background job (token + polling). Details shows retry timing and error codes.
              </div>

              <div className="mapbox">
                <div className="mapbox-head">
                  <div className="mapbox-title">VAT origins</div>
                  <div className="mapbox-sub">{mapCount}</div>
                </div>
                <div id="countryMap" aria-label="Map of VAT origins"></div>
                <div className="mapbox-foot">
                  <div id="mapLegend">{mapLegend}</div>
                  <div className="map-attrib">
                    <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OSM</a>
                  </div>
                </div>
              </div>

              <div className="chipsRow">
                <div className="chip"><span>Progress</span><b>{progressText}</b></div>
                <div className="chip"><span>FR job</span><b>{frText}</b></div>
                <div className="chip"><span>Last update</span><b>{lastUpdate}</b></div>
              </div>

              <p className="hint" style={{ margin: 0 }}>Sorting: click table headers.</p>
            </div>
          </div>
        </section>

        <div className="tableWrap">
          <div className="tableHeader">
            <div>
              <strong>Results</strong>{" "}
              <span className="muted">• {filteredRows.length} rows</span>
            </div>
            <div className="muted">{sortLabel}</div>
          </div>

          <div style={{ overflow: "auto", maxHeight: 600 }}>
            <table>
              <thead>
                <tr>
                  <th onClick={() => sortByColumn(0, "Source")}>Source</th>
                  <th onClick={() => sortByColumn(1, "State")}>State</th>
                  <th onClick={() => sortByColumn(2, "VAT")}>VAT</th>
                  <th onClick={() => sortByColumn(3, "Country")}>Country</th>
                  <th onClick={() => sortByColumn(4, "Valid")}>Valid</th>
                  <th onClick={() => sortByColumn(5, "Name")}>Name</th>
                  <th onClick={() => sortByColumn(6, "Address")}>Address</th>
                  <th onClick={() => sortByColumn(7, "Error")}>Error</th>
                  <th onClick={() => sortByColumn(8, "Details")}>Details</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, idx) => {
                  const key = r.vat_number || r.input || String(idx);
                  const st = stateClass(r.state);
                  return (
                    <tr key={key} data-state={st}>
                      <td>{r.source ?? ""}</td>
                      <td className="nowrap">
                        <span className={`pill ${st}`}><i></i>{stateLabel(r.state)}</span>
                      </td>
                      <td className="mono nowrap">{r.vat_number ?? ""}</td>
                      <td className="mono nowrap">{r.country_code ?? ""}</td>
                      <td className="mono nowrap">{valText(r.valid)}</td>
                      <td>{r.name ?? ""}</td>
                      <td>{r.address ?? ""}</td>
                      <td className="mono nowrap">{r.error ?? ""}</td>
                      <td>{r.details ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
