import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("./playwright.config.ts", import.meta.url), "utf8");
const launcher = readFileSync(new URL("./start-gateway.mjs", import.meta.url), "utf8");
const urls = [...config.matchAll(/url:\s*"(http:[^"]+)"/g)].map((match) => match[1]);
assert.equal(urls.length, 2, "Playwright config should have API and gateway readiness URLs");
assert.equal(new URL(urls[0]).port, "3000", "API webServer must wait on port 3000");
assert.equal(new URL(urls[1]).port, "3031", "gateway webServer must wait on its own readiness port");
assert.notEqual(urls[0], urls[1], "webServer entries must not share a readiness URL");
assert.match(launcher, /listen\(3031/,
  "gateway launcher must expose the readiness port checked by Playwright");
console.log("e2e webServer readiness configuration is distinct and statically verified");
