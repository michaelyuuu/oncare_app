import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const roles = ["family", "staff", "admin"];
const credentials = Object.fromEntries(roles.map((role) => [role, `${role}-demo-pass`]));
const laundryTools = [{ name: "get_laundry_overview" }, { name: "find_garments" }];
const FETCH_FORBIDDEN_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514,
  515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

function isFetchForbiddenPort(port) {
  return FETCH_FORBIDDEN_PORTS.has(port);
}

async function listenOnFetchSafeEphemeralPort(server, {
  maxAttempts = 16,
  isForbiddenPort = isFetchForbiddenPort,
} = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const address = await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address());
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    assert(address && typeof address === "object");
    if (!isForbiddenPort(address.port)) return address;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  throw new Error(`could not allocate a fetch-safe test port after ${maxAttempts} attempts`);
}


test("test API allocator rejects every WHATWG Fetch-forbidden port", () => {
  const forbiddenPorts = [
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
    69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
    119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514,
    515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
    990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
    6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
  ];
  for (const port of forbiddenPorts) {
    assert.equal(isFetchForbiddenPort(port), true, `expected port ${port} to be forbidden`);
  }
  for (const port of [80, 443, 6001, 65535]) {
    assert.equal(isFetchForbiddenPort(port), false, `expected port ${port} to be fetch-safe`);
  }
});

test("test API allocator retries rejected ports and retains the accepted socket", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  let inspected = 0;
  try {
    const address = await listenOnFetchSafeEphemeralPort(server, {
      maxAttempts: 16,
      isForbiddenPort(port) {
        inspected += 1;
        return inspected === 1 || isFetchForbiddenPort(port);
      },
    });
    assert.ok(inspected >= 2, "expected the forced first rejection to be retried");
    assert.equal(server.listening, true);
    assert.equal(server.address()?.port, address.port);
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(await response.text(), "ok");
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

test("test API allocator stops after its bounded retry count", async () => {
  const server = createServer();
  let inspected = 0;
  await assert.rejects(
    listenOnFetchSafeEphemeralPort(server, {
      maxAttempts: 2,
      isForbiddenPort() {
        inspected += 1;
        return true;
      },
    }),
    /could not allocate a fetch-safe test port/,
  );
  assert.equal(inspected, 2);
  assert.equal(server.listening, false);
});

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
  const address = await listenOnFetchSafeEphemeralPort(server);
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
