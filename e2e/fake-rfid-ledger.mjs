import { createServer } from "node:http";

const STATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STATION_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "e2e-station-token";
const PORT = 3101;

let mode = "healthy";

const resident = {
  resident_id: "resident_demo_01",
  name: "Demo Resident",
  room: "Demo room",
  floor: "1",
  photo: "",
  kana: "",
  admitted_on: "2026-01-01",
  active: true,
};

function ledger() {
  return {
    station_id: mode === "identity_mismatch" ? OTHER_STATION_ID : STATION_ID,
    registry: {
      version: 7,
      written_at: "2026-09-21T11:59:00.000Z",
      etag: "e2e-ledger-v7",
    },
    baseline: {},
    baseline_etag: null,
    garments: [{
      epc: "E200001",
      name: "Blue cardigan",
      color: "blue",
      category: "cardigan",
      owner: "Demo Resident",
      added_at: "2026-01-01T00:00:00.000Z",
      resident_id: "resident_demo_01",
      size: "M",
      brand: "",
      care_label: "",
      tag_type: "uhf",
      status: "active",
      notes: "",
      resident,
      wash_count: 4,
      last_seen: "2026-09-21T11:59:00.000Z",
      photo_url: null,
    }],
    residents: [resident],
    categories: ["cardigan"],
    statuses: ["active", "lost", "discarded"],
    warnings: [],
  };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024) throw new Error("body_too_large");
  }
  return body === "" ? {} : JSON.parse(body);
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true, mode });
    return;
  }
  if (request.method === "POST" && request.url === "/__control/reset") {
    mode = "healthy";
    json(response, 200, { ok: true, mode });
    return;
  }
  if (request.method === "POST" && request.url === "/__control") {
    try {
      const input = await readJson(request);
      if (!["healthy", "unavailable", "identity_mismatch"].includes(input.mode)) {
        json(response, 400, { error: "invalid_mode" });
        return;
      }
      mode = input.mode;
      json(response, 200, { ok: true, mode });
    } catch {
      json(response, 400, { error: "invalid_request" });
    }
    return;
  }
  if (request.method === "GET" && request.url === "/api/ledger") {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (mode === "unavailable") {
      json(response, 503, { error: "fixture_unavailable" });
      return;
    }
    json(response, 200, ledger());
    return;
  }
  json(response, 404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1");
const stop = () => server.close();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
