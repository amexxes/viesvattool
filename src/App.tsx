import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import type { FrJobResponse, ValidateBatchResponse, ValidationRow } from "./types";

type SortKey =
  | "source"
  | "state"
  | "vat_number"
  | "country_code"
  | "valid"
  | "name"
  | "address"
  | "error"
  | "details";

type SortDir = "asc" | "desc";

function safeStr(v: unknown): string {
  return String(v ?? "");
}

function normalizeForSearch(v: string): string {
  return v.toLowerCase();
}

function uniqueCountryCodes(rows: ValidationRow[]): string[] {
  const s = new Set<string>();
  for (const r of rows) {
    const cc = safeStr(r.country_code).trim().toUpperCase();
    if (cc && cc.length === 2) s.add(cc);
  }
  return Array.from(s).sort();
}

function computeProgress(rows: ValidationRow[]) {
  const total = rows.length;
  let done = 0;
  let valid = 0;
  let invalid = 0;
  let error = 0;
  let queued = 0;

  for (const r of rows) {
    const st = safeStr(r.state).toLowerCase();
    const v = r.valid;

    if (st === "valid") {
      done++;
      valid++;
    } else if (st === "invalid") {
      done++;
      invalid++;
    } else if (st === "error") {
      done++;
      error++;
    } else if (st === "retry" || st === "processing" || st === "queued") {
      queued++;
    } else if (v === true) {
      done++;
      valid++;
    } else if (v === false) {
      done++;
      invalid++;
    }
  }

  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, pct, valid, invalid, error, queued };
}

function compare(a: unknown, b: unknown) {
  const aa = a ?? "";
  const bb = b ?? "";
  if (typeof aa === "number" && typeof bb === "number") return aa - bb;
  const sa = String(aa).toLowerCase();
  const sb = String(bb).toLowerCase();
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function sortRows(rows: ValidationRow[], key: SortKey, dir: SortDir): ValidationRow[] {
  const out = [...rows];
  out.sort((r1, r2) => {
    let v1: unknown;
    let v2: unknown;

    switch (key) {
      case "valid":
        v1 = r1.valid === null ? "" : r1.valid ? "1" : "0";
        v2 = r2.valid === null ? "" : r2.valid ? "1" : "0";
        break;
      default:
        v1 = (r1 as any)[key];
        v2 = (r2 as any)[key];
    }

    const c = compare(v1, v2);
    return dir === "asc" ? c : -c;
  });
  return out;
}

function formatTime(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("nl-NL");
}

export default function App() {
  const [vatText, setVatText] = useState<string>("");
  const [filterText, setFilterText] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [rows, setRows] = useState<ValidationRow[]>([]);
  const [frJobId, setFrJobId] = useState<string | null>(null);
  const [frJobStatus, setFrJobStatus] = useState<string>("");

  const [isRunning, setIsRunning] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("vat_number");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const mapRef = useRef<L.Map | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  const filteredRows = useMemo(() => {
    const q = normalizeForSearch(filterText.trim());
    if (!q) return rows;

    return rows.filter((r) => {
      const blob =
        `${r.source} ${r.state} ${r.vat_number} ${r.country_code} ${r.valid} ${r.name} ${r.address} ${r.error} ${r.details}`;
      return normalizeForSearch(blob).includes(q);
    });
  }, [rows, filterText]);

  const sortedRows = useMemo(() => {
    return sortRows(filteredRows, sortKey, sortDir);
  }, [filteredRows, sortKey, sortDir]);

  const progress = useMemo(() => computeProgress(rows), [rows]);

  // Leaflet map init
  useEffect(() => {
    if (!mapDivRef.current) return;
    if (mapRef.current) return;

    const map = L.map(mapDivRef.current, {
      center: [52.1, 5.1],
      zoom: 4,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 18,
    }).addTo(map);

    const layer = L.layerGroup().addTo(map);

    mapRef.current = map;
    markersLayerRef.current = layer;

    return () => {
      map.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
    };
  }, []);

  // Update map markers based on country codes in current rows
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    const codes = uniqueCountryCodes(rows);

    // Simple “label markers” around Europe-ish area (not accurate geography).
    // Purpose: show which country codes are present.
    const baseLat = 54;
    const baseLng = -10;

    codes.forEach((cc, i) => {
      const lat = baseLat - Math.floor(i / 8) * 3.0;
      const lng = baseLng + (i % 8) * 6.0;

      const icon = L.divIcon({
        className: "",
        html: `<div style="
          background:#0b2d4d;color:#fff;border-radius:10px;
          padding:6px 8px;font-weight:700;font-size:12px;
          border:1px solid rgba(255,255,255,.35);
          box-shadow:0 6px 18px rgba(15,23,42,.12);
        ">${cc}</div>`,
      });

      L.marker([lat, lng], { icon }).addTo(layer);
    });

    if (codes.length > 0) {
      map.setView([52.1, 5.1], 4);
    }
  }, [rows]);

  // Poll FR job if exists
  useEffect(() => {
    if (!frJobId) return;

    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      try {
        const resp = await fetch(`/api/fr-job/${encodeURIComponent(frJobId)}`, { method: "GET" });
        if (!resp.ok) return;

        const data = (await resp.json()) as FrJobResponse;
        if (cancelled) return;

        setFrJobStatus(`${data.job.status} (${data.job.done}/${data.job.total})`);

        // Merge FR results into rows by vat_number
        setRows((prev) => {
          const mapByVat = new Map<string, ValidationRow>();
          prev.forEach((r) => mapByVat.set(r.vat_number, r));

          data.results.forEach((r) => {
            mapByVat.set(r.vat_number, r);
          });

          return Array.from(mapByVat.values());
        });

        setLastUpdate(Date.now());

        const status = safeStr(data.job.status).toLowerCase();
        if (status === "completed") {
          setIsRunning(false);
          return; // stop polling
        }

        timer = window.setTimeout(poll, 2000);
      } catch {
        timer = window.setTimeout(poll, 3000);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [frJobId]);

  async function onValidate() {
    const lines = vatText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    if (lines.length === 0) return;

    setIsRunning(true);
    setFrJobId(null);
    setFrJobStatus("");
    setLastUpdate(Date.now());

    try {
      const resp = await fetch("/api/validate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vat_numbers: lines }),
      });

      if (!resp.ok) {
        setIsRunning(false);
        return;
      }

      const data = (await resp.json()) as ValidateBatchResponse;

      setRows(data.results || []);
      setLastUpdate(Date.now());

      if (data.fr_job_id) {
        setFrJobId(data.fr_job_id);
        setFrJobStatus(`queued`);
        // polling start via useEffect
      } else {
        setIsRunning(false);
      }
    } catch {
      setIsRunning(false);
    }
  }

  function onClear() {
    setVatText("");
    setRows([]);
    setFilterText("");
    setFrJobId(null);
    setFrJobStatus("");
    setLastUpdate(null);
    setIsRunning(false);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir("asc");
  }

  const frBadgeDot =
    frJobId && (frJobStatus.toLowerCase().includes("running") || frJobStatus.toLowerCase().includes("queued"))
      ? "dotRun"
      : frJobId && frJobStatus.toLowerCase().includes("completed")
        ? "dotOk"
        : frJobId
          ? "dotWarn"
          : "";

  return (
    <div className="page">
      <div className="banner">VAT validation</div>

      <div className="container">
        <div className="topRow">
          <div className="card panel">
            <div className="panelHeader">
              <h2 className="h2">VAT numbers</h2>
              <div className="small">1 per regel (bv. NL123..., FR123...)</div>
            </div>

            <textarea
              className="vatInput"
              value={vatText}
              onChange={(e) => setVatText(e.target.value)}
              placeholder="Plak hier VAT nummers, 1 per regel"
            />

            <div className="controlsRow">
              <button className="btn" onClick={onValidate} disabled={isRunning || vatText.trim().length === 0}>
                Validate
              </button>
              <button className="btn btnSecondary" onClick={onClear} disabled={isRunning && rows.length > 0}>
                Clear
              </button>
            </div>
          </div>

          <div className="card panel">
            <div className="panelHeader">
              <h2 className="h2">Filter & Notes</h2>
              <div className="small">Zoek in resultaten + notities</div>
            </div>

            <div className="noteBox">
              <div>
                <div className="noteLabel">Filter</div>
                <input
                  className="input"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Zoek (VAT, naam, error, landcode...)"
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <div className="noteLabel">Notes</div>
                <textarea
                  className="noteArea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Notities..."
                />
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="statusRow">
            <div className="badge">
              <span className={`dot ${isRunning ? "dotRun" : "dotOk"}`} />
              <span>{isRunning ? "Running" : "Idle"}</span>
            </div>

            <div className="badge">
              <span className={`dot ${rows.length ? "dotOk" : ""}`} />
              <span>
                Results: <b>{rows.length}</b> (done {progress.done}/{progress.total})
              </span>
            </div>

            <div className="badge">
              <span className={`dot ${frBadgeDot}`} />
              <span>
                FR job: <b>{frJobId ? frJobStatus || "..." : "n/a"}</b>
              </span>
            </div>

            <div className="badge">
              <span className="dot" />
              <span>
                Last update: <b>{lastUpdate ? formatTime(lastUpdate) : "-"}</b>
              </span>
            </div>
          </div>

          <div className="progressWrap">
            <div className="small" style={{ marginBottom: 8 }}>
              Progress: <b>{progress.pct}%</b> — valid {progress.valid}, invalid {progress.invalid}, error{" "}
              {progress.error}, queued {progress.queued}
            </div>
            <div className="progressBar">
              <div className="progressFill" style={{ width: `${progress.pct}%` }} />
            </div>
          </div>
        </div>

        <div className="lowerGrid">
          <div className="card">
            <div className="panelHeader">
              <h2 className="h2">Countries</h2>
              <div className="small">Op basis van eerste 2 letters</div>
            </div>
            <div ref={mapDivRef} className="mapBox" />
          </div>

          <div className="card">
            <div className="panelHeader">
              <h2 className="h2">Results</h2>
              <div className="small">
                Klik header voor sort ({sortKey} {sortDir})
              </div>
            </div>

            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th onClick={() => toggleSort("source")}>Source</th>
                    <th onClick={() => toggleSort("state")}>State</th>
                    <th onClick={() => toggleSort("vat_number")}>VAT</th>
                    <th onClick={() => toggleSort("country_code")}>Country</th>
                    <th onClick={() => toggleSort("valid")}>Valid</th>
                    <th onClick={() => toggleSort("name")}>Name</th>
                    <th onClick={() => toggleSort("address")}>Address</th>
                    <th onClick={() => toggleSort("error")}>Error</th>
                    <th onClick={() => toggleSort("details")}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r, idx) => (
                    <tr key={`${r.vat_number}-${idx}`}>
                      <td>{r.source}</td>
                      <td>{r.state}</td>
                      <td className="mono">{r.vat_number}</td>
                      <td className="mono">{r.country_code}</td>
                      <td>{r.valid === null ? "" : r.valid ? "true" : "false"}</td>
                      <td>{r.name}</td>
                      <td>{r.address}</td>
                      <td className="mono">{r.error}</td>
                      <td>{r.details}</td>
                    </tr>
                  ))}
                  {sortedRows.length === 0 && (
                    <tr>
                      <td colSpan={9} style={{ color: "#64748b" }}>
                        No results
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="small" style={{ marginTop: 10 }}>
              Tip: Filter werkt op alle kolommen tegelijk.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
