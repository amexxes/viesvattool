// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "2mb" }));

const VIES_BASE = "https://ec.europa.eu/taxation_customs/vies/rest-api";

// Optioneel (aanrader) voor "qualified" requests:
// - REQUESTER_MS: bijv "NL"
// - REQUESTER_VAT: je eigen VAT nummer ZONDER landcode (bijv "123456789B01" -> zonder "NL")
const REQUESTER_MS = process.env.REQUESTER_MS || "";
const REQUESTER_VAT = process.env.REQUESTER_VAT || "";

// --- Helpers ---
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

  // VIES gebruikt EL voor Griekenland
  if (countryCode === "GR") countryCode = "EL";

  // IMPORTANT: REST API verwacht vatNumber ZONDER landcode (zie bekend issue/voorbeeld) :contentReference[oaicite:2]{index=2}
  const vatNumber = v.slice(2);
  if (!vatNumber) return null;

  return { input: line, countryCode, vatNumber, vat_number: v };
}

// simpele concurrency limit
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

async function viesCheck({ countryCode, vatNumber }) {
  const body = {
    countryCode,
    vatNumber,
  };

  // Voeg requester info toe als die aanwezig is
  if (REQUESTER_MS && REQUESTER_VAT) {
    body.requesterMemberStateCode = REQUESTER_MS.toUpperCase();
    body.requesterNumber = normalizeVatLine(REQUESTER_VAT).replace(/^[A-Z]{2}/, "");
  }

  const resp = await fetch(`${VIES_BASE}/check-vat-number`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      data,
    };
  }

  return { ok: true, data };
}

// --- API endpoints ---
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/vies-status", async (req, res) => {
  try {
    const r = await fetch(`${VIES_BASE}/check-status`, { headers: { "Accept": "application/json" } });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: "VIES_STATUS_FAILED", details: String(e?.message || e) });
  }
});

// UI verwacht deze:
app.post("/api/validate-batch", async (req, res) => {
  const vat_numbers = Array.isArray(req.body?.vat_numbers) ? req.body.vat_numbers : [];
  const parsed = vat_numbers.map(parseVat).filter(Boolean);

  // dedupe op land+nummer
  const seen = new Set();
  const unique = [];
  for (const p of parsed) {
    const k = `${p.countryCode}:${p.vatNumber}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
  }

  // lege input -> lege output
  if (!unique.length) return res.json({ count: 0, fr_job_id: null, results: [] });

  // VIES heeft rate limits; hou concurrency laag
  const results = await mapLimit(unique, 4, async (p) => {
    try {
      const r = await viesCheck(p);

      if (!r.ok) {
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
          error: `HTTP_${r.status || "ERR"}`,
          details: JSON.stringify(r.data),
        };
      }

      const d = r.data;

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
        // laat extra velden desnoods in details (handig voor debugging)
        details: d?.requestIdentifier ? `requestIdentifier=${d.requestIdentifier}` : "",
      };
    } catch (e) {
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
        error: "EXCEPTION",
        details: String(e?.message || e),
      };
    }
  });

  res.json({
    count: results.length,
    fr_job_id: null,
    results,
  });
});

// --- Vite build (dist) serveren ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback: alle niet-/api routes naar React
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
