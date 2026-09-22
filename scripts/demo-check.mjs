import assert from "node:assert/strict";

const apiBase = (process.env.ONCARE_DEMO_API_BASE ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const targets = [
  ["api", `${apiBase}/health`],
  ["resident", "http://127.0.0.1:5173/"],
  ["family", "http://127.0.0.1:5174/"],
];
for (const [name, url] of targets) {
  try {
    const response = await fetch(url);
    console.log(`${name.padEnd(9)} ${response.ok ? "up" : `http ${response.status}`}  ${url}`);
  } catch {
    console.log(`${name.padEnd(9)} DOWN ${url}`);
  }
}

const accounts = [
  { role: "family", username: "family", password: "family-demo-pass" },
  { role: "staff", username: "staff", password: "staff-demo-pass" },
  { role: "admin", username: "admin", password: "admin-demo-pass" },
];
const laundryTools = ["get_laundry_overview", "find_garments"];

async function json(url, init, label) {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, `${label} failed with HTTP ${response.status}`);
  return await response.json();
}

for (const account of accounts) {
  const login = await json(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: account.username, password: account.password }),
  }, `${account.role} login`);
  assert.equal(typeof login.token, "string", `${account.role} login did not return a token`);
  const catalog = await json(`${apiBase}/tools`, {
    headers: { authorization: `Bearer ${login.token}` },
  }, `${account.role} tool catalog`);
  assert.equal(Array.isArray(catalog.tools), true, `${account.role} tool catalog is malformed`);
  const names = new Set(catalog.tools.map((tool) => tool?.name));
  for (const tool of laundryTools) {
    assert.equal(
      names.has(tool),
      account.role === "admin",
      account.role === "admin"
        ? `admin is missing laundry tool ${tool}`
        : `${account.role} must not expose laundry tools (${tool})`,
    );
  }
}
console.log("laundry tools admin-only ok");
