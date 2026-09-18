import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const gateway = resolve(root, "robot_gateway");
const python = resolve(gateway, ".venv", "Scripts", "python.exe");
const child = spawn(python, ["-m", "gateway"], {
  cwd: gateway,
  env: { ...process.env, ONCARE_API_URL: "ws://127.0.0.1:3000", ONCARE_ROBOT_TOKEN: "robot-demo-token", ROBOT_ADAPTER: "mock" },
  stdio: "inherit",
});
const readiness = createServer((request, response) => {
  if (request.url !== "/health") { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": "text/plain" }).end("gateway process started\n");
});
readiness.listen(3031, "127.0.0.1");
const stop = () => child.kill();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
child.once("exit", (code, signal) => { readiness.close(); process.exitCode = code ?? (signal ? 1 : 0); });
