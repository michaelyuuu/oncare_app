import { mkdirSync, writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GatewayDownSchema, GatewayUpSchema } from "../src/gateway";

const outDir = new URL("../../../robot_gateway/schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const write = (name: string, schema: object) =>
  writeFileSync(new URL(name, outDir), JSON.stringify(schema, null, 2) + "\n");
write("gateway-down.json", zodToJsonSchema(GatewayDownSchema, "GatewayDown"));
write("gateway-up.json", zodToJsonSchema(GatewayUpSchema, "GatewayUp"));
console.log("wrote robot_gateway/schema/gateway-{down,up}.json");
