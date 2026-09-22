import OpenAI from "openai";
import { z } from "zod";
import type { Principal } from "../auth/plugin";
import type { ToolRegistry, ToolResult } from "../tools/registry";

const DEFAULT_MODEL = "gpt-5.4";
const MAX_PROVIDER_RESPONSES = 4;
const ALLOWED = new Set(["get_laundry_overview", "find_garments"] as const);

type LaundryToolName = "get_laundry_overview" | "find_garments";
type JsonSchema = Record<string, unknown>;

export interface ManagerFunctionTool {
  type: "function";
  name: LaundryToolName;
  description: string;
  strict: true;
  parameters: JsonSchema;
}

type ManagerInputItem =
  | { role: "developer" | "user"; content: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface ManagerProviderRequest {
  model: string;
  input: string | ManagerInputItem[];
  tools: ManagerFunctionTool[];
  previous_response_id?: string;
}

export interface ManagerProviderResponse {
  id: string;
  output_text: string;
  output: Array<{
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
}

export interface ManagerAssistantClient {
  responses: {
    create(request: ManagerProviderRequest): Promise<ManagerProviderResponse>;
  };
}

export interface LaundryToolResult {
  name: LaundryToolName;
  result: ToolResult;
}

export interface LaundryAssistant {
  ask(principal: Principal, question: string): Promise<{ answer: string; toolResults: LaundryToolResult[] }>;
}

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: "null" }] };
}

const PROVIDER_TOOLS: ManagerFunctionTool[] = [
  {
    type: "function",
    name: "get_laundry_overview",
    description: "Summarize laundry garment totals and synchronization status for this facility or one accessible resident.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        residentId: nullable({ type: "string", minLength: 1 }),
      },
      required: ["residentId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_garments",
    description: "Find up to 20 facility-scoped garments by accessible resident, name, category, color, or status.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        residentId: nullable({ type: "string", minLength: 1 }),
        name: nullable({ type: "string", minLength: 1, maxLength: 100 }),
        category: nullable({ type: "string", minLength: 1, maxLength: 50 }),
        color: nullable({ type: "string", minLength: 1, maxLength: 50 }),
        status: nullable({ type: "string", enum: ["active", "lost", "discarded"] }),
      },
      required: ["residentId", "name", "category", "color", "status"],
      additionalProperties: false,
    },
  },
];

const SYSTEM_PROMPT = [
  "You are OnCare's read-only laundry assistant for a facility manager.",
  "Use only the supplied laundry tools for laundry facts; never invent records or freshness.",
  "State clearly when data is stale or has never synchronized.",
  "Do not request or reveal credentials, raw RFID identifiers, hidden reasoning, or private provider data.",
].join(" ");

const overviewInputSchema = z.object({
  residentId: z.string().min(1).optional(),
}).strict();

const findInputSchema = z.object({
  residentId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  color: z.string().trim().min(1).max(50).optional(),
  status: z.enum(["active", "lost", "discarded"]).optional(),
}).strict();

function parseArguments(name: LaundryToolName, value: string | undefined): Record<string, unknown> {
  if (value === undefined) throw new Error("invalid_tool_call");
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid_tool_call");
  const normalized = Object.fromEntries(Object.entries(parsed).filter(([, item]) => item !== null));
  return (name === "get_laundry_overview" ? overviewInputSchema : findInputSchema).parse(normalized);
}

function isAllowed(name: string | undefined): name is LaundryToolName {
  return name !== undefined && ALLOWED.has(name as LaundryToolName);
}

function createOpenAIClient(apiKey: string): ManagerAssistantClient {
  const client = new OpenAI({ apiKey });
  return {
    responses: {
      async create(request) {
        const response = await client.responses.create(request);
        return {
          id: response.id,
          output_text: response.output_text,
          output: response.output.map((item) => item.type === "function_call"
            ? {
                type: item.type,
                call_id: item.call_id,
                name: item.name,
                arguments: item.arguments,
              }
            : { type: item.type }),
        };
      },
    },
  };
}

export function createLaundryAssistant(opts: {
  tools: ToolRegistry;
  client?: ManagerAssistantClient;
  apiKey?: string;
  model?: string;
}): LaundryAssistant {
  const client = opts.client ?? (opts.apiKey?.trim() ? createOpenAIClient(opts.apiKey) : undefined);
  const model = opts.model?.trim() || DEFAULT_MODEL;

  return {
    async ask(principal, question) {
      if (!client) throw new Error("assistant_unavailable");
      const toolResults: LaundryToolResult[] = [];
      let input: ManagerProviderRequest["input"] = [
        { role: "developer", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ];
      let previousResponseId: string | undefined;

      for (let responseNumber = 0; responseNumber < MAX_PROVIDER_RESPONSES; responseNumber += 1) {
        const response = await client.responses.create({
          model,
          input,
          tools: PROVIDER_TOOLS,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        });
        if (typeof response.id !== "string" || response.id.trim().length === 0) {
          throw new Error("assistant_unavailable");
        }
        const calls = response.output.filter((item) => item.type === "function_call");
        if (calls.length === 0) {
          const answer = response.output_text.trim();
          if (!answer) throw new Error("assistant_unavailable");
          return { answer, toolResults };
        }

        const parsedCalls = calls.map((call) => {
          if (!isAllowed(call.name) || !call.call_id) throw new Error("assistant_unavailable");
          return { name: call.name, callId: call.call_id, input: parseArguments(call.name, call.arguments) };
        });
        const outputs: ManagerInputItem[] = [];
        for (const call of parsedCalls) {
          const result = await opts.tools.invoke(principal, call.name, call.input);
          toolResults.push({ name: call.name, result });
          outputs.push({ type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) });
        }
        previousResponseId = response.id;
        input = outputs;
      }

      throw new Error("assistant_unavailable");
    },
  };
}
