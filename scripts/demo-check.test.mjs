import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const roles = ["family", "staff", "admin"];
const credentials = Object.fromEntries(roles.map((role) => [role, `${role}-demo-pass`]));
const laundryTools = [{ name: "get_laundry_overview" }, { name: "find_garments" }];

async function withFakeApi({ leak = false } = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const send = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/health") {
      send(200, { ok: true });
      return;
    }
    if (request.method === "POST" && request.url === "/auth/login") {
      const input = JSON.parse(body);
      if (!roles.includes(input.username) || credentials[input.username] !== input.password) {
        send(401, { error: "invalid_credentials" });
        return;
      }
      send(200, { token: `${input.username}-token`, principal: { role: input.username } });
      return;
    }
    if (request.method === "GET" && request.url === "/tools") {
      const role = request.headers.authorization?.replace(/^Bearer /, "").replace(/-token$/, "");
      calls.push(role);
      const tools = role === "admin" || (leak && role === "staff")
        ? [{ name: "list_my_residents_or_contacts" }, ...laundryTools]
        : [{ name: "list_my_residents_or_contacts" }];
      send(200, { tools });
      return;
    }
    send(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function runDemo(baseUrl) {
  return await execFileAsync(process.execPath, ["scripts/demo-check.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ONCARE_DEMO_API_BASE: baseUrl, OPENAI_API_KEY: "" },
  });
}

test("demo check calls structured tools as every seeded user and accepts admin-only laundry tools", async () => {
  const api = await withFakeApi();
  try {
    const result = await runDemo(api.baseUrl);
    assert.deepEqual(api.calls, roles);
    assert.match(result.stdout, /laundry tools admin-only\s+ok/);
  } finally {
    await api.close();
  }
});

test("demo check fails if a laundry tool is exposed to staff", async () => {
  const api = await withFakeApi({ leak: true });
  try {
    await assert.rejects(runDemo(api.baseUrl), (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /staff.*laundry tools/i);
      return true;
    });
  } finally {
    await api.close();
  }
});
