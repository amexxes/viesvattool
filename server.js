import express from "express";
import Database from "better-sqlite3";
import https from "https";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * =========================================================
 * EC VIES REST
 * =========================================================
 */
const VIES_BASE = "https://ec.europa.eu/taxation_customs/vies/rest-api";
const VIES_CHECK_URL = `${VIES_BASE}/check-vat-number`;
const VIES_STATUS_URL = `${VIES_BASE}/check-status`;

const PORT = process.env.PORT || 3000;

/**
 * Optional requester fields (leave empty if you don't want them)
 */
const REQUESTER_MEMBER_STATE_CODE = (process.env.REQUESTER_MEMBER_STATE_CODE || "").trim().toUpperCase();
const REQUESTER_NUMBER = (process.env.REQUESTER_NUMBER || "").trim().toUpperCase();

/**
 * =========================================================
 * Config
 * =========================================================
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * NON-FR: slower + retries on MS_MAX_CONCURRENT_REQ
 * - Per-country sequential processing (prevents self-triggering MS_MAX)
 * - Country streams in small parallel
 * - Start-time limiter (extra latency)
 */
const NON_FR_COUNTRY_WORKERS = 3;
const NON_FR_TIMEOUT_MS = 20000;
const NON_FR_MAX_ATTEMPTS = 5;

// baseline spacing (increased latency)
const NON_FR_MIN_GAP_GLOBAL_MS = 650;
const NON_FR_MIN_GAP_PER_COUNTRY_MS = 1600;

// extra conservative for specific countries that also hit MS_MAX often
const NON_FR_COUNTRY_OVERRIDES = {
  DE: { minGapPerCountryMs: 2600 }, // Germany
  RO: { minGapPerCountryMs: 2600 }, // Romania
};

const NON_FR_MS_MAX_BACKOFF_S = [6, 12, 20, 30, 45];
const NON_FR_OTHER_BACKOFF_S = [2, 4, 8, 12, 18];

/**
 * FR: async worker “batch-like” job system (UNCHANGED)
 */
const FR_MIN_GAP_MS = 2500;
const FR_TIMEOUT_MS = 20000;

const FR_MS_MAX_BACKOFF_S = [10, 20, 40, 60, 90, 120, 180, 240, 300];
const FR_OTHER_BACKOFF_S = [5, 10, 20, 30, 60, 90, 120];

const FR_GLOBAL_MS_MAX_COOLDOWN_MS = 8000;

const STATUS_CACHE_MS = 60 * 1000;

const RETRYABLE_CODES = new Set([
  "MS_MAX_CONCURRENT_REQ",
  "GLOBAL_MAX_CONCURRENT_REQ",
  "MS_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
  "TECHNICAL_ERROR",
  "IO_ERROR",
]);

/**
 * =========================================================
 * HTTP agents
 * =========================================================
 */
const agentFast = new https.Agent({ keepAlive: true, maxSockets: 32 });
const agentFr = new https.Agent({ keepAlive: false, maxSockets: 1 });

/**
 * =========================================================
 * SQLite
 * =========================================================
 */
const db = new Database("cache.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS vat_cache (
    vat_key TEXT NOT NULL PRIMARY KEY,
    response_json TEXT NOT NULL,
    checked_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS fr_jobs (
    job_id TEXT NOT NULL PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    total INTEGER NOT NULL,
    done INTEGER NOT NULL,
    message TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS fr_job_items (
    job_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    input TEXT NOT NULL,
    vat_key TEXT NOT NULL,
    country_code TEXT NOT NULL,
    vat_number TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_retry_at INTEGER,
    last_code TEXT,
    last_message TEXT,
    result_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, vat_key)
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_fr_due
  ON fr_job_items(state, next_retry_at);
`);

/**
 * =========================================================
 * Helpers
 * =========================================================
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(ms, spread = 800) {
  return ms + Math.floor(Math.random() * spread);
}
function normalizeVatLine(line) {
  return String(line || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}
function normalizeCountryCode(cc) {
  const c = String(cc || "").toUpperCase();
  if (c === "GR") return "EL";
  return c;
}
function parseVat(norm) {
  if (!norm || norm.length < 3) return { ok: false, error: "EMPTY_OR_TOO_SHORT" };
  const cc = normalizeCountryCode(norm.slice(0, 2));
  if (!/^[A-Z]{2}$/.test(cc)) return { ok: false, error: "MISSING_OR_INVALID_COUNTRY_PREFIX" };
  const vatPart = norm.slice(2);
  if (!vatPart) return { ok: false, error: "MISSING_VAT_NUMBER" };
  const vatKey = `${cc}${vatPart}`;
  return { ok: true, countryCode: cc, vatNumber: vatPart, vatKey };
}

function getCached(vatKey) {
  const row = db.prepare("SELECT response_json, checked_at FROM vat_cache WHERE vat_key=?").get(vatKey);
  if (!row) return null;
  if (Date.now() - row.checked_at > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.response_json);
  } catch {
    return null;
  }
}
function setCached(vatKey, data) {
  db.prepare(`
    INSERT INTO vat_cache(vat_key, response_json, checked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(vat_key) DO UPDATE SET
      response_json=excluded.response_json,
      checked_at=excluded.checked_at
  `).run(vatKey, JSON.stringify(data), Date.now());
}

function toUiSuccess(input, vatKey, data, source) {
  const cc = data?.countryCode || vatKey.slice(0, 2);
  const vatPart = data?.vatNumber || vatKey.slice(2);
  return {
    input,
    source,
    state: data?.valid ? "valid" : "invalid",
    vat_number: vatKey,
    country_code: cc,
    vat_part: vatPart,
    valid: !!data?.valid,
    name: data?.name ?? "",
    address: data?.address ?? "",
    request_date: data?.requestDate ?? "",
    request_identifier: data?.requestIdentifier ?? "",
    error: "",
    details: "",
  };
}

function toUiInfo(input, vatKey, cc, vatPart, source, state, code, message, nextRetryAt, attempts) {
  const parts = [];
  if (attempts !== undefined && attempts !== null) parts.push(`attempt: ${attempts}`);
  if (code) parts.push(`code: ${code}`);
  if (message) parts.push(String(message).slice(0, 400));
  if (nextRetryAt) parts.push(`next retry: ${new Date(nextRetryAt).toLocaleString("nl-NL")}`);

  return {
    input,
    source,
    state,
    vat_number: vatKey,
    country_code: cc,
    vat_part: vatPart,
    valid: null,
    name: "",
    address: "",
    request_date: "",
    request_identifier: "",
    error: code || "",
    details: parts.join(" | "),
  };
}

function isRetryable(code, httpStatus) {
  if (RETRYABLE_CODES.has(code)) return true;
  if (httpStatus === 408 || httpStatus === 429) return true;
  if (httpStatus >= 500) return true;
  return false;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const text = await resp.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { resp, text, json };
  } catch (e) {
    return { resp: null, text: String(e?.name || e?.message || e), json: null, error: e };
  } finally {
    clearTimeout(t);
  }
}

/**
 * =========================================================
 * VIES calls
 * =========================================================
 */
let statusCache = { fetchedAt: 0, data: null };

async function getViesStatusCached() {
  const now = Date.now();
  if (statusCache.data && now - statusCache.fetchedAt < STATUS_CACHE_MS) return statusCache.data;

  const { resp, json } = await fetchJson(
    VIES_STATUS_URL,
    { method: "GET", agent: agentFast, headers: { Accept: "application/json" } },
    12000
  );

  if (resp?.ok && json?.vow) {
    statusCache = { fetchedAt: now, data: json };
    return json;
  }
  return statusCache.data;
}

async function callViesCheckVat(countryCode, vatNumber, timeoutMs, agent) {
  const body = { countryCode, vatNumber };

  if (REQUESTER_MEMBER_STATE_CODE && REQUESTER_NUMBER) {
    body.requesterMemberStateCode = REQUESTER_MEMBER_STATE_CODE;
    body.requesterNumber = REQUESTER_NUMBER;
  }

  const { resp, text, json } = await fetchJson(
    VIES_CHECK_URL,
    {
      method: "POST",
      agent,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!resp) return { ok: false, httpStatus: 0, code: "NETWORK_ERROR", message: text || "Network error" };

  if (resp.ok && json && typeof json.valid === "boolean") {
    return { ok: true, httpStatus: resp.status, data: json };
  }

  const ew0 = Array.isArray(json?.errorWrappers) ? json.errorWrappers[0] : null;
  const code = ew0?.error || json?.error || "UNKNOWN";
  const message = ew0?.message || json?.message || text || "Unknown error";
  return { ok: false, httpStatus: resp.status, code, message: String(message).slice(0, 800) };
}

/**
 * =========================================================
 * Non-FR increased latency: reservation-based start limiter
 * =========================================================
 */
let nonFrScheduleLock = Promise.resolve();
let nonFrNextGlobalAt = 0;
const nonFrNextByCountryAt = new Map();

function nonFrCountryGap(country) {
  const o = NON_FR_COUNTRY_OVERRIDES[country];
  return o?.minGapPerCountryMs ?? NON_FR_MIN_GAP_PER_COUNTRY_MS;
}

async function reserveNonFrStartAt(country) {
  let release;
  const p = new Promise((r) => (release = r));
  const prev = nonFrScheduleLock;
  nonFrScheduleLock = p;
  await prev;

  try {
    const now = Date.now();
    const nextCountry = nonFrNextByCountryAt.get(country) || 0;

    const startAt = Math.max(now, nonFrNextGlobalAt, nextCountry);

    nonFrNextGlobalAt = startAt + NON_FR_MIN_GAP_GLOBAL_MS;
    nonFrNextByCountryAt.set(country, startAt + nonFrCountryGap(country));

    return startAt;
  } finally {
    release();
  }
}

function nonFrBackoffMs(code, attempt) {
  const idx = Math.min(NON_FR_MAX_ATTEMPTS - 1, Math.max(0, attempt - 1));
  if (code === "MS_MAX_CONCURRENT_REQ" || code === "GLOBAL_MAX_CONCURRENT_REQ") {
    return NON_FR_MS_MAX_BACKOFF_S[Math.min(NON_FR_MS_MAX_BACKOFF_S.length - 1, idx)] * 1000;
  }
  return NON_FR_OTHER_BACKOFF_S[Math.min(NON_FR_OTHER_BACKOFF_S.length - 1, idx)] * 1000;
}

async function callViesNonFrWithRetry(countryCode, vatNumber) {
  for (let attempt = 1; attempt <= NON_FR_MAX_ATTEMPTS; attempt++) {
    const startAt = await reserveNonFrStartAt(countryCode);
    const now = Date.now();
    if (startAt > now) await sleep(startAt - now);

    const r = await callViesCheckVat(countryCode, vatNumber, NON_FR_TIMEOUT_MS, agentFast);
    if (r.ok) return r;

    const retryable = isRetryable(r.code, r.httpStatus);
    if (!retryable || attempt === NON_FR_MAX_ATTEMPTS) return r;

    const delay = nonFrBackoffMs(r.code, attempt);
    await sleep(jitter(delay, 1200));
  }
  return { ok: false, httpStatus: 500, code: "UNKNOWN", message: "Unknown error" };
}

/**
 * =========================================================
 * FR async “batch-like” job system (UNCHANGED)
 * =========================================================
 */
let frWorkerRunning = false;
let frNextCallAt = 0;
let frWakeTimer = null;
let frGlobalPauseUntil = 0;

async function enforceFrGap() {
  const now = Date.now();
  const waitUntil = Math.max(frNextCallAt, now);
  if (waitUntil > now) await sleep(waitUntil - now);
  frNextCallAt = Date.now() + FR_MIN_GAP_MS;
}

function computeFrDelayMs(code, attempts) {
  const a = Math.max(1, attempts);

  if (code === "MS_MAX_CONCURRENT_REQ" || code === "GLOBAL_MAX_CONCURRENT_REQ") {
    const s = FR_MS_MAX_BACKOFF_S[Math.min(FR_MS_MAX_BACKOFF_S.length - 1, a - 1)];
    return s * 1000;
  }
  const s = FR_OTHER_BACKOFF_S[Math.min(FR_OTHER_BACKOFF_S.length - 1, a - 1)];
  return s * 1000;
}

function frRecalcJob(jobId) {
  const total = db.prepare("SELECT total FROM fr_jobs WHERE job_id=?").get(jobId)?.total ?? 0;
  const done = db
    .prepare(`
      SELECT COUNT(*) AS c
      FROM fr_job_items
      WHERE job_id=? AND state IN ('done','error')
    `)
    .get(jobId)?.c ?? 0;

  const open = db
    .prepare(`
      SELECT COUNT(*) AS c
      FROM fr_job_items
      WHERE job_id=? AND state IN ('queued','processing','retry')
    `)
    .get(jobId)?.c ?? 0;

  const status = open === 0 ? "completed" : "running";

  db.prepare(`
    UPDATE fr_jobs
    SET done=?, total=?, status=?, updated_at=?
    WHERE job_id=?
  `).run(done, total, status, Date.now(), jobId);
}

function frPickNextDueItem() {
  const now = Date.now();
  return db
    .prepare(`
      SELECT job_id, vat_key, country_code, vat_number, input, state, attempts, next_retry_at
      FROM fr_job_items
      WHERE (state='queued' OR state='retry')
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY COALESCE(next_retry_at, 0) ASC, updated_at ASC, position ASC
      LIMIT 1
    `)
    .get(now);
}

function frGetNextWakeAt() {
  return (
    db
      .prepare(`
        SELECT MIN(next_retry_at) AS t
        FROM fr_job_items
        WHERE state IN ('queued','retry')
          AND next_retry_at IS NOT NULL
      `)
      .get()?.t ?? null
  );
}

function scheduleFrWake() {
  if (frWakeTimer) {
    clearTimeout(frWakeTimer);
    frWakeTimer = null;
  }

  const dueNow = frPickNextDueItem();
  if (dueNow) {
    setImmediate(() => runFrWorker().catch(() => {}));
    return;
  }

  const t = frGetNextWakeAt();
  if (!t) return;

  const now = Date.now();
  const ms = Math.max(50, t - now);
  frWakeTimer = setTimeout(() => {
    frWakeTimer = null;
    runFrWorker().catch(() => {});
  }, ms);
}

function frUpdateItem(jobId, vatKey, patch) {
  const now = Date.now();
  db.prepare(`
    UPDATE fr_job_items
    SET state=?,
        attempts=?,
        next_retry_at=?,
        last_code=?,
        last_message=?,
        result_json=?,
        updated_at=?
    WHERE job_id=? AND vat_key=?
  `).run(
    patch.state,
    patch.attempts,
    patch.next_retry_at ?? null,
    patch.last_code ?? null,
    patch.last_message ?? null,
    patch.result_json ?? null,
    now,
    jobId,
    vatKey
  );

  frRecalcJob(jobId);
}

async function runFrWorker() {
  if (frWorkerRunning) return;
  frWorkerRunning = true;

  try {
    while (true) {
      const now = Date.now();
      if (frGlobalPauseUntil > now) await sleep(frGlobalPauseUntil - now);

      const item = frPickNextDueItem();
      if (!item) break;

      frUpdateItem(item.job_id, item.vat_key, {
        state: "processing",
        attempts: item.attempts,
        next_retry_at: null,
        last_code: item.last_code ?? null,
        last_message: item.last_message ?? null,
        result_json: null,
      });

      const cached = getCached(item.vat_key);
      if (cached && typeof cached.valid === "boolean") {
        frUpdateItem(item.job_id, item.vat_key, {
          state: "done",
          attempts: item.attempts,
          next_retry_at: null,
          last_code: null,
          last_message: null,
          result_json: JSON.stringify(cached),
        });
        continue;
      }

      const status = await getViesStatusCached();
      const vowAvailable = status?.vow?.available;
      const frRow = Array.isArray(status?.vow?.countries)
        ? status.vow.countries.find((c) => String(c?.countryCode || "").toUpperCase() === "FR")
        : null;

      if (vowAvailable === false || (frRow && frRow.availability && frRow.availability !== "Available")) {
        const attempts = item.attempts + 1;
        const next = Date.now() + jitter(60 * 1000, 3000);
        frUpdateItem(item.job_id, item.vat_key, {
          state: "retry",
          attempts,
          next_retry_at: next,
          last_code: "MS_STATUS_UNAVAILABLE",
          last_message: `check-status: vow.available=${vowAvailable}, FR=${frRow?.availability || "unknown"}`,
          result_json: null,
        });
        continue;
      }

      await enforceFrGap();
      const r = await callViesCheckVat("FR", item.vat_number, FR_TIMEOUT_MS, agentFr);

      if (r.ok) {
        setCached(item.vat_key, r.data);
        frUpdateItem(item.job_id, item.vat_key, {
          state: "done",
          attempts: item.attempts,
          next_retry_at: null,
          last_code: null,
          last_message: null,
          result_json: JSON.stringify(r.data),
        });
        continue;
      }

      const retryable = isRetryable(r.code, r.httpStatus);

      if (retryable) {
        const attempts = item.attempts + 1;
        const delayMs = computeFrDelayMs(r.code, attempts);
        const next = Date.now() + jitter(delayMs, 1500);

        frUpdateItem(item.job_id, item.vat_key, {
          state: "retry",
          attempts,
          next_retry_at: next,
          last_code: r.code,
          last_message: r.message,
          result_json: null,
        });

        if (r.code === "MS_MAX_CONCURRENT_REQ" || r.code === "GLOBAL_MAX_CONCURRENT_REQ") {
          frGlobalPauseUntil = Math.max(frGlobalPauseUntil, Date.now() + FR_GLOBAL_MS_MAX_COOLDOWN_MS);
        }
      } else {
        frUpdateItem(item.job_id, item.vat_key, {
          state: "error",
          attempts: item.attempts + 1,
          next_retry_at: null,
          last_code: r.code,
          last_message: r.message,
          result_json: null,
        });
      }
    }
  } finally {
    frWorkerRunning = false;
    scheduleFrWake();
  }
}

function createFrJob(frItems) {
  const jobId = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO fr_jobs(job_id, created_at, updated_at, status, total, done, message)
    VALUES (?, ?, ?, 'queued', ?, 0, ?)
  `).run(jobId, now, now, frItems.length, "FR async job created");

  const insert = db.prepare(`
    INSERT INTO fr_job_items(
      job_id, position, input, vat_key, country_code, vat_number,
      state, attempts, next_retry_at, last_code, last_message, result_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let done = 0;

  frItems.forEach((it, idx) => {
    const cached = getCached(it.vatKey);
    if (cached && typeof cached.valid === "boolean") {
      done += 1;
      insert.run(
        jobId,
        idx,
        it.input,
        it.vatKey,
        it.countryCode,
        it.vatNumber,
        "done",
        0,
        null,
        null,
        null,
        JSON.stringify(cached),
        now
      );
    } else {
      insert.run(
        jobId,
        idx,
        it.input,
        it.vatKey,
        it.countryCode,
        it.vatNumber,
        "queued",
        0,
        now,
        null,
        null,
        null,
        now
      );
    }
  });

  db.prepare(`
    UPDATE fr_jobs
    SET done=?, updated_at=?, status=?
    WHERE job_id=?
  `).run(done, now, done === frItems.length ? "completed" : "queued", jobId);

  scheduleFrWake();
  return jobId;
}

function resumeFrWorkerIfNeeded() {
  const openCount = db
    .prepare(`
      SELECT COUNT(*) AS c
      FROM fr_job_items
      WHERE state IN ('queued','retry','processing')
    `)
    .get()?.c ?? 0;

  if (openCount > 0) {
    scheduleFrWake();
    runFrWorker().catch(() => {});
  }
}

/**
 * =========================================================
 * Non-FR: per-country sequential, countries in small parallel
 * =========================================================
 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await mapper(items[idx], idx);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.max(1, limit); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * =========================================================
 * API
 * =========================================================
 */
app.post("/api/validate-batch", async (req, res) => {
  try {
    const lines = Array.isArray(req.body.vat_numbers) ? req.body.vat_numbers : [];
    if (!lines.length) return res.status(400).json({ error: "vat_numbers array is required" });

    const seen = new Set();
    const parsed = [];
    const immediateErrors = [];

    for (const raw of lines) {
      const norm = normalizeVatLine(raw);
      if (!norm) continue;

      const p = parseVat(norm);
      if (!p.ok) {
        immediateErrors.push({
          input: raw,
          source: "input",
          state: "error",
          vat_number: norm,
          country_code: "",
          vat_part: "",
          valid: null,
          name: "",
          address: "",
          request_date: "",
          request_identifier: "",
          error: p.error,
          details: p.error,
        });
        continue;
      }

      if (seen.has(p.vatKey)) continue;
      seen.add(p.vatKey);

      parsed.push({ input: raw, ...p });
    }

    const frItems = parsed.filter((x) => x.countryCode === "FR");
    const otherItems = parsed.filter((x) => x.countryCode !== "FR");

    let fr_job_id = null;
    if (frItems.length) {
      fr_job_id = createFrJob(frItems);
      runFrWorker().catch(() => {});
    }

    const byCountry = new Map();
    for (const it of otherItems) {
      if (!byCountry.has(it.countryCode)) byCountry.set(it.countryCode, []);
      byCountry.get(it.countryCode).push(it);
    }
    const countries = Array.from(byCountry.keys());
    const resultMap = new Map();

    await mapLimit(countries, NON_FR_COUNTRY_WORKERS, async (cc) => {
      const items = byCountry.get(cc) || [];
      for (const it of items) {
        const cached = getCached(it.vatKey);
        if (cached && typeof cached.valid === "boolean") {
          resultMap.set(it.vatKey, toUiSuccess(it.input, it.vatKey, cached, "cache"));
          continue;
        }

        const r = await callViesNonFrWithRetry(it.countryCode, it.vatNumber);

        if (r.ok) {
          setCached(it.vatKey, r.data);
          resultMap.set(it.vatKey, toUiSuccess(it.input, it.vatKey, r.data, "vies"));
        } else {
          resultMap.set(
            it.vatKey,
            toUiInfo(
              it.input,
              it.vatKey,
              it.countryCode,
              it.vatNumber,
              "vies",
              "error",
              r.code || "UNKNOWN",
              r.message || "Unknown error",
              null,
              null
            )
          );
        }
      }
    });

    const otherResults = otherItems.map((it) => resultMap.get(it.vatKey)).filter(Boolean);

    const frPlaceholders = frItems.map((it) => {
      const cached = getCached(it.vatKey);
      if (cached && typeof cached.valid === "boolean") return toUiSuccess(it.input, it.vatKey, cached, "cache");
      return toUiInfo(it.input, it.vatKey, "FR", it.vatNumber, "fr-job", "queued", "", `job_id=${fr_job_id}`, null, 0);
    });

    res.json({
      count: immediateErrors.length + otherResults.length + frPlaceholders.length,
      fr_job_id,
      results: [...immediateErrors, ...otherResults, ...frPlaceholders],
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

app.get("/api/fr-job/:jobId", (req, res) => {
  try {
    const jobId = String(req.params.jobId || "").trim();

    const job = db
      .prepare(`
        SELECT job_id, created_at, updated_at, status, total, done, message
        FROM fr_jobs
        WHERE job_id=?
      `)
      .get(jobId);

    if (!job) return res.status(404).json({ error: "NOT_FOUND" });

    const items = db
      .prepare(`
        SELECT position, input, vat_key, country_code, vat_number, state, attempts, next_retry_at, last_code, last_message, result_json
        FROM fr_job_items
        WHERE job_id=?
        ORDER BY position ASC
      `)
      .all(jobId);

    const results = items.map((it) => {
      if (it.state === "done" && it.result_json) {
        let data = null;
        try {
          data = JSON.parse(it.result_json);
        } catch {
          data = null;
        }
        if (data && typeof data.valid === "boolean") return toUiSuccess(it.input, it.vat_key, data, "vies");
      }

      if (it.state === "retry") {
        return toUiInfo(
          it.input,
          it.vat_key,
          it.country_code,
          it.vat_number,
          "vies",
          "retry",
          it.last_code || "RETRY",
          it.last_message || "Retry scheduled",
          it.next_retry_at || null,
          it.attempts
        );
      }
      if (it.state === "processing") {
        return toUiInfo(
          it.input,
          it.vat_key,
          it.country_code,
          it.vat_number,
          "vies",
          "processing",
          it.last_code || "",
          it.last_message || "processing",
          null,
          it.attempts
        );
      }
      if (it.state === "error") {
        return toUiInfo(
          it.input,
          it.vat_key,
          it.country_code,
          it.vat_number,
          "vies",
          "error",
          it.last_code || "ERROR",
          it.last_message || "error",
          null,
          it.attempts
        );
      }

      return toUiInfo(
        it.input,
        it.vat_key,
        it.country_code,
        it.vat_number,
        "fr-job",
        "queued",
        "",
        `job_id=${jobId}`,
        it.next_retry_at || null,
        it.attempts
      );
    });

    res.json({ job, results });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

app.get("/api/vies-status", async (_req, res) => {
  try {
    const s = await getViesStatusCached();
    res.json(s || { error: "NO_STATUS" });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * =========================================================
 * Serve Vite dist/ (React)
 * =========================================================
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback (niet voor /api)
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  resumeFrWorkerIfNeeded();
});
