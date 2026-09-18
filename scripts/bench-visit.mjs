import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";

const API = process.env.API ?? "http://127.0.0.1:3000";
const N = Number(process.env.N ?? 20);
if (!Number.isInteger(N) || N < 1) throw new Error("N must be a positive integer");

const j = async (path, opts = {}, token) => {
  const response = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`${path} ${response.status} ${await response.text()}`);
  return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
};
const login = async (username, password) => (await j("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) })).token;
const family = await login("family", "family-demo-pass");
const staff = await login("staff", "staff-demo-pass");
const device = (await j("/auth/device", { method: "POST", body: JSON.stringify({ deviceToken: "device-demo-token" }) })).token;
const residents = (await j("/me/residents", {}, family)).residents;
const residentId = residents[0]?.id;
if (!residentId) throw new Error("family account has no resident");

const waiters = new Map();
const ws = new WebSocket(`${API.replace(/^http/, "ws")}/events?token=${encodeURIComponent(device)}`);
ws.on("message", (data) => {
  const event = JSON.parse(data.toString());
  const key = `${event.entityId}:${event.toState}`;
  waiters.get(key)?.(Date.now());
});
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
const waitFor = (id, state, timeoutMs = 15_000) => new Promise((resolve, reject) => {
  const key = `${id}:${state}`;
  const timer = setTimeout(() => { waiters.delete(key); reject(new Error(`timeout ${key}`)); }, timeoutMs);
  waiters.set(key, (at) => { clearTimeout(timer); waiters.delete(key); resolve(at); });
});

const rows = [];
for (let i = 0; i < N; i += 1) {
  const t0 = Date.now();
  const { visit } = await j("/visits", { method: "POST", body: JSON.stringify({ residentId }) }, family);
  const ringing = waitFor(visit.id, "awaiting_resident_consent");
  let notifyMs = null;
  let ok = false;
  try {
    const at = await ringing;
    notifyMs = at - t0;
    await j("/device/screen-shown", { method: "POST", body: JSON.stringify({ screen: "incoming", entityId: visit.id }) }, device);
    await j(`/visits/${visit.id}/answer`, { method: "POST" }, device);
    await j(`/visits/${visit.id}/connected`, { method: "POST" }, family);
    const done = waitFor(visit.id, "completed");
    await j(`/visits/${visit.id}/end`, { method: "POST" }, family);
    await done;
    ok = true;
  } catch (error) {
    console.error(`run ${i}: ${error instanceof Error ? error.message : String(error)}`);
  }
  rows.push({ i, visitId: visit.id, notifyMs, ok, totalMs: Date.now() - t0 });
  process.stdout.write(`run ${i + 1}/${N} notify=${notifyMs ?? "-"}ms ok=${ok}\n`);
}
ws.close();

const nums = rows.filter((row) => row.notifyMs !== null).map((row) => row.notifyMs).sort((a, b) => a - b);
const q = (p) => nums[Math.min(nums.length - 1, Math.floor(p * nums.length))] ?? null;
const success = rows.filter((row) => row.ok).length / rows.length;
const summary = {
  n: rows.length,
  notifyMedianMs: q(0.5),
  notifyP95Ms: q(0.95),
  connectSuccess: success,
  pass: q(0.5) !== null && q(0.5) < 3000 && success >= 0.95,
};
console.log(JSON.stringify(summary, null, 2));
const date = new Date().toISOString().slice(0, 10);
mkdirSync("docs/benchmarks", { recursive: true });
writeFileSync(`docs/benchmarks/visit-${date}.csv`, await j("/benchmark.csv", {}, staff));
writeFileSync(`docs/benchmarks/visit-${date}.summary.json`, JSON.stringify({ ...summary, rows }, null, 2));
process.exitCode = summary.pass ? 0 : 1;
