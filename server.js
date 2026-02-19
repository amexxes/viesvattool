// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- TODO: zet hier jouw API endpoints ---
// app.post("/api/validate-batch", async (req, res) => { ... });
// app.get("/api/fr-job/:jobId", async (req, res) => { ... });

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
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
