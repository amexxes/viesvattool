// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Officiële EC VIES REST API endpoints (swagger noemt /check-vat-number & /check-status) :contentReference[oaicite:4]{index=4}
const VIES_BASE = "https://ec.europa.eu/taxation_customs/vies/rest-api";

// Optioneel: "qualified" request (dan kan requestIdentifier terugkomen) :contentReference[oaicite:5]{index=5}
const REQUESTER_MS = (process.env.REQUESTER_MS || "").toUpperCase();
const REQUESTER_VAT = process.env.REQUESTER_VAT || "";

// Tuning
const VIES_TIMEOUT_MS = Number(process.env.VIES_TIMEOUT_MS || 20000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_FR_ATTEMPTS = Number(process.env.MAX_FR_ATTEMPTS || 50);

// Jouw backoff-ladder (zoals je beschreef)
const FR_BACKOFF_SEC = [10, 20, 40, 60, 90, 120, 180, 240, 300];

// -------------------- Cache --------------------
/** key -> { ts, row } */
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.row;
}
function cacheSet(key, row) {
  cache.set(key, { ts: Date.now(), row });
}

// -------------------- VIES status cache --------------------
let statusCache = null; // { ts, data }

async function getViesStatus() {
  if (statusCache && Date.now() - statusCache.ts < 30_000) return statusCache.data;
  const r = await fetchJson(`${VIES_BASE}/check-status`, { method: "GET" }, 10_000);
  if (r.ok) statusCache = { ts: Date.now(), data: r.data };
  return r.data;
}

function memberStateAvailable(statusJson, countryCode) {
  const cc = countryCode === "GR" ? "EL" : countryCode;
  const entry = statusJson?.countries?.find?.((c) => c.countryCode === cc);
  return !entry || entry.availability === "Available";
}

// -------------------- Parsing --------------------
function normalizeVatLine(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function parseVat(line) {
  const v = normalizeVatLine(line);
  if (v.length < 3) return null;

  let countryCode = v.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;

  if (countryCode === "GR") countryCode = "EL"; // VIES gebruikt EL

  // REST request verwacht vatNumber zonder prefix (bekende gotcha) :contentReference[oaicite:6]{index=6}
  const vatNumber = v.slice(2);
  if (!vatNumber) return null;

  return { input: line, countryCode, vatNumber, vat_number: v };
}

// -------------------- Fetch JSON + timeout --------------------
async function fetchJson(url, init, timeoutMs = VIES_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { Accept: "application/json", ...(init?.headers || {}) },
    });
    const text = await resp.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: "NETWORK_ERROR", message: String(e?.message || e) } };
  } finally {
    clearTimeout(t);
  }
}

function isCommonResponse(data) {
  return data && typeof data === "object" && "actionSucceed" in data && "errorWrappers" in data;
}

function extractErrorCode(data) {
  const wrappers = data?.errorWrappers;
  if (Array.isArray(wrappers) && wrappers.length) return wrappers[0]?.error || null;
  if (typeof data?.error === "string") return data.error;
  return null;
}

function extractErrorMessage(data) {
  const wrappers = data?.errorWrappers;
  if (Array.isArray(wrappers) && wrappers.length) return wrappers[0]?.message || "";
  if (typeof data?.message === "string") return data.message;
  return "";
}

// Retryable foutcodes (uit de bekende VIES foutcode-set) :contentReference[oaicite:7]{index=7}
const RETRYABLE_CODES = new Set([
  "SERVICE_UNAVAILABLE",
  "MS_UNAVAILABLE",
  "TIMEOUT",
  "GLOBAL_MAX_CONCURRENT_REQ",
  "GLOBAL_MAX_CONCURRENT_REQ_TIME",
  "MS_MAX_CONCURRENT_REQ",
  "MS_MAX_CONCURRENT_REQ_TIME",
]);

function isRetryable(errorCode, httpStatus) {
  if (RETRYABLE_CODES.has(errorCode)) return true;
  if (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return true;
  if (httpStatus === 0) return true; // network/timeout
  return false;
}

// -------------------- Rows --------------------
function rowFromOk(p, d) {
  return {
    input: p.input,
    source: "vies",
    state: d?.valid ? "valid" : "invalid",
    vat_number: p.vat_number,
    country_code: d?.countryCode || p.countryCode,
    vat_part: d?.vatNumber || p.vatNumber,
    valid: !!d?.valid,
    name: d?.name && d.name !== "---" ? d.name : "",
    address: d?.address && d.address !== "---" ? d.address : "",
    error: "",
    details: d?.requestIdentifier ? `requestIdentifier=${d.requestIdentifier}` : "",
  };
}

function rowFromQueued(p) {
  return {
    input: p.input,
    source: "vies",
    state: "queued",
    vat_number: p.vat_number,
    country_code: p.countryCode,
    vat_part: p.vatNumber,
    valid: null,
    name: "",
    address: "",
    error: "",
    details: "",
  };
}

function rowFromRetry(p, errorCode, details) {
  return {
    input: p.input,
    source: "vies",
    state: "retry",
    vat_number: p.vat_number,
    country_code: p.countryCode,
    vat_part: p.vatNumber,
    valid: null,
    name: "",
    address: "",
    error: errorCode || "RETRY",
    details: details ? String(details).slice(0, 1000) : "",
  };
}

function rowFromError(p, errorCode, details) {
  return {
    input: p.input,
    source: "vies",
    state: "error",
    vat_number: p.vat_number,
    country_code: p.countryCode,
    vat_part: p.vatNumber,
    valid: null,
    name: "",
    address: "",
    error: errorCode || "ERROR",
    details: details ? String(details).slice(0, 1000) : "",
  };
}

// -------------------- VIES call --------------------
async function viesCheck(p) {
  const body = { countryCode: p.countryCode, vatNumber: p.vatNumber };

  if (REQUESTER_MS && REQUESTER_VAT) {
    body.requesterMemberStateCode = REQUESTER_MS;
    body.requesterNumber = normalizeVatLine(REQUESTER_VAT).replace(/^[A-Z]{2}/, "");
  }

  const r = await fetchJson(`${VIES_BASE}/check-vat-number`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // In de praktijk komen fouten terug als CommonResponse met errorWrappers :contentReference[oaicite:8]{index=8}
  if (isCommonResponse(r.data) && r.data.actionSucceed === false) {
    return {
      ok: false,
      status: r.status,
      errorCode: extractErrorCode(r.data),
      message: extractErrorMessage(r.data),
      data: r.data,
    };
  }

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      errorCode: extractErrorCode(r.data) || `HTTP_${r.status || 0}`,
      message: extractErrorMessage(r.data),
      data: r.data,
    };
  }

  return { ok: true, status: r.status, data: r.data };
}

// -------------------- Non-FR concurrency --------------------
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) break;
      out[idx] = await fn(arr[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

// -------------------- FR async job system --------------------
/**
 * jobs: jobId -> {
 *   job: { job_id, status, total, done, created_at, updated_at, message }
 *   results: Map<key,row>
 * }
 */
const jobs = new Map();

/**
 * queue items: { jobId, key, p, attempt, nextRunAt }
 */
const frQueue = [];
let workerTimer = null;
let workerRunning = false;

function frBackoffMs(attempt) {
  const sec = FR_BACKOFF_SEC[Math.min(attempt - 1, FR_BACKOFF_SEC.length - 1)];
  const jitter = Math.floor(Math.random() * 1000);
  return sec * 1000 + jitter;
}

function scheduleWorker() {
  if (workerRunning) return;
  if (workerTimer) return;
  if (frQueue.length === 0) return;

  const nextAt = frQueue.reduce((min, t) => Math.min(min, t.nextRunAt), Infinity);
  const delay = Math.max(0, nextAt - Date.now());

  workerTimer = setTimeout(() => {
    workerTimer = null;
    void runWorker();
  }, delay);
}

function takeNextReadyTask() {
  const now = Date.now();
  let bestIdx = -1;
  let bestTime = Infinity;

  for (let i = 0; i < frQueue.length; i++) {
    const t = frQueue[i];
    if (t.nextRunAt <= now && t.nextRunAt < bestTime) {
      bestIdx = i;
      bestTime = t.nextRunAt;
    }
  }

  if (bestIdx === -1) return null;
  return frQueue.splice(bestIdx, 1)[0];
}

function finalizeJobIfDone(jobEntry) {
  if (jobEntry.job.done >= jobEntry.job.total) jobEntry.job.status = "completed";
}

async function processFrTask(task) {
  const jobEntry = jobs.get(task.jobId);
  if (!jobEntry) return;

  const { job, results } = jobEntry;
  job.status = "running";
  job.updated_at = Date.now();

  const cur = results.get(task.key) || rowFromQueued(task.p);
  results.set(task.key, { ...cur, state: "processing" });

  // check-status gate (FR down -> niet meteen callen) :contentReference[oaicite:9]{index=9}
  const status = await getViesStatus();
  if (status && !memberStateAvailable(status, "FR")) {
    const attempt = task.attempt + 1;

    if (attempt > MAX_FR_ATTEMPTS) {
      results.set(task.key, rowFromError(task.p, "RETRY_EXHAUSTED", "FR remained unavailable (check-status)"));
      job.done++;
      job.updated_at = Date.now();
      finalizeJobIfDone(jobEntry);
      return;
    }

    results.set(task.key, rowFromRetry(task.p, "MS_UNAVAILABLE", "check-status: Unavailable"));
    task.attempt = attempt;
    task.nextRunAt = Date.now() + frBackoffMs(attempt);
    frQueue.push(task);
    job.updated_at = Date.now();
    scheduleWorker();
    return;
  }

  const r = await viesCheck(task.p);

  if (r.ok) {
    const row = rowFromOk(task.p, r.data);
    results.set(task.key, row);
    cacheSet(task.key, row);

    job.done++;
    job.updated_at = Date.now();
    finalizeJobIfDone(jobEntry);
    return;
  }

  const code = r.errorCode || `HTTP_${r.status || 0}`;
  const details = r.message || JSON.stringify(r.data);

  if (isRetryable(code, r.status)) {
    const attempt = task.attempt + 1;

    if (attempt > MAX_FR_ATTEMPTS) {
      results.set(task.key, rowFromError(task.p, "RETRY_EXHAUSTED", `${code} (${attempt - 1} retries)`));
      job.done++;
      job.updated_at = Date.now();
      finalizeJobIfDone(jobEntry);
      return;
    }

    results.set(task.key, rowFromRetry(task.p, code, details));
    task.attempt = attempt;
    task.nextRunAt = Date.now() + frBackoffMs(attempt);
    frQueue.push(task);
    job.updated_at = Date.now();
    scheduleWorker();
    return;
  }

  results.set(task.key, rowFromError(task.p, code, details));
  job.done++;
  job.updated_at = Date.now();
  finalizeJobIfDone(jobEntry);
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (true) {
      const task = takeNextReadyTask();
      if (!task) break;
      await processFrTask(task);
    }
  } finally {
    workerRunning = false;
    scheduleWorker();
  }
}

// Cleanup (in-memory)
setInterval(() => {
  const now = Date.now();

  for (const [jobId, jobEntry] of jobs.entries()) {
    if (now - jobEntry.job.created_at > 6 * 60 * 60 * 1000) jobs.delete(jobId);
  }

  for (const [k, v] of cache.entries()) {
    if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
  }
}, 10 * 60 * 1000).unref();

// -------------------- API --------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/vies-status", async (req, res) => {
  const r = await fetchJson(`${VIES_BASE}/check-status`, { method: "GET" }, 10_000);
  res.status(r.ok ? 200 : r.status || 500).json(r.data);
});

app.post("/api/validate-batch", async (req, res) => {
  const vat_numbers = Array.isArray(req.body?.vat_numbers) ? req.body.vat_numbers : [];
  const parsed = vat_numbers.map(parseVat).filter(Boolean);

  // dedupe on countryCode+vatNumber
  const seen = new Set();
  const unique = [];
  for (const p of parsed) {
    const key = `${p.countryCode}:${p.vatNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  const fr = unique.filter((p) => p.countryCode === "FR");
  const other = unique.filter((p) => p.countryCode !== "FR");

  // Non-FR realtime
  const otherResults = await mapLimit(other, 6, async (p) => {
    const key = `${p.countryCode}:${p.vatNumber}`;
    const cached = cacheGet(key);
    if (cached) return { ...cached, input: p.input, vat_number: p.vat_number };

    const r = await viesCheck(p);
    if (r.ok) {
      const row = rowFromOk(p, r.data);
      cacheSet(key, row);
      return row;
    }

    const code = r.errorCode || `HTTP_${r.status || 0}`;
    const details = r.message || JSON.stringify(r.data);
    return rowFromError(p, code, details);
  });

  // FR async job
  let fr_job_id = null;
  let frRows = [];

  if (fr.length) {
    fr_job_id = randomUUID();

    const jobEntry = {
      job: {
        job_id: fr_job_id,
        status: "queued",
        total: fr.length,
        done: 0,
        updated_at: Date.now(),
        created_at: Date.now(),
        message: null,
      },
      results: new Map(),
    };

    for (const p of fr) {
      const key = `${p.countryCode}:${p.vatNumber}`;
      const cached = cacheGet(key);

      if (cached) {
        jobEntry.results.set(key, { ...cached, input: p.input, vat_number: p.vat_number });
        jobEntry.job.done++;
      } else {
        jobEntry.results.set(key, rowFromQueued(p));
        frQueue.push({ jobId: fr_job_id, key, p, attempt: 0, nextRunAt: Date.now() });
      }
    }

    jobEntry.job.status = jobEntry.job.done >= jobEntry.job.total ? "completed" : "running";
    jobEntry.job.updated_at = Date.now();

    jobs.set(fr_job_id, jobEntry);
    scheduleWorker();

    frRows = Array.from(jobEntry.results.values());
  }

  res.json({
    count: otherResults.length + frRows.length,
    fr_job_id,
    results: [...otherResults, ...frRows],
  });
});

app.get("/api/fr-job/:jobId", (req, res) => {
  const jobEntry = jobs.get(req.params.jobId);
  if (!jobEntry) return res.status(404).json({ error: "Not found" });

  res.json({
    job: jobEntry.job,
    results: Array.from(jobEntry.results.values()),
  });
});

// --- Vite build (dist) serveren ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
