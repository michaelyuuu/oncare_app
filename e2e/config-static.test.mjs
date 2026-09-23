import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("./playwright.config.ts", import.meta.url), "utf8");
const fixture = readFileSync(new URL("./fake-rfid-ledger.mjs", import.meta.url), "utf8");
const launcher = readFileSync(new URL("./start-gateway.mjs", import.meta.url), "utf8");
const urls = [...config.matchAll(/url:\s*"(http:[^"]+)"/g)].map((match) => match[1]);
assert.equal(urls.length, 3, "Playwright config should have fixture, API, and gateway readiness URLs");
const ports = urls.map((url) => new URL(url).port).sort();
assert.deepEqual(ports, ["3000", "3031", "3101"],
  "Playwright readiness must cover API, gateway, and RFID fixture ports");
assert.equal(new Set(urls).size, 3, "webServer entries must not share readiness URLs");
assert.match(fixture, /const PORT = 3101/,
  "RFID fixture must expose the readiness port checked by Playwright");
assert.match(launcher, /listen\(3031/,
  "gateway launcher must expose the readiness port checked by Playwright");
console.log("e2e webServer readiness configuration is distinct and statically verified");
