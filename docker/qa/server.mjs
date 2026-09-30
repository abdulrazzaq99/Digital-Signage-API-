// Tiny results store for the QA checklist at /qa. Not part of the product: one JSON file, one
// shared access code (QA_KEY). Without QA_KEY every request is refused.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const KEY = process.env.QA_KEY ?? "";
const DIR = process.env.QA_DATA ?? "/data";
const FILE = `${DIR}/results.json`;
mkdirSync(DIR, { recursive: true });

let results = {};
try { results = JSON.parse(readFileSync(FILE, "utf8")); } catch { /* first run */ }

const persist = () => { writeFileSync(`${FILE}.tmp`, JSON.stringify(results)); renameSync(`${FILE}.tmp`, FILE); };
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const authed = (req) => {
  const given = Buffer.from(String(req.headers["x-qa-key"] ?? ""));
  const want = Buffer.from(KEY);
  return KEY.length >= 8 && given.length === want.length && timingSafeEqual(given, want);
};

createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (!authed(req)) return send(res, 401, { error: "Wrong access code" });

  if (req.method === "GET" && path === "/qa/api/results") return send(res, 200, { results });

  const m = /^\/qa\/api\/results\/([A-Z]\d{1,2})$/.exec(path);
  if (req.method === "PUT" && m) {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on("end", () => {
      let b;
      try { b = JSON.parse(raw); } catch { return send(res, 400, { error: "Bad JSON" }); }
      if (!["", "pass", "fail"].includes(b?.r)) return send(res, 400, { error: "Bad result" });
      results[m[1]] = { r: b.r, n: String(b.n ?? "").slice(0, 2000), by: String(b.by ?? "").slice(0, 60), at: new Date().toISOString() };
      try { persist(); } catch (err) { console.error("could not save results", err); return send(res, 500, { error: "Could not save" }); }
      send(res, 200, { ok: true, saved: results[m[1]] });
    });
    return;
  }
  send(res, 404, { error: "Not found" });
}).listen(8080, () => console.log("qa results store listening on 8080", KEY ? "" : "(QA_KEY not set: all requests refused)"));
