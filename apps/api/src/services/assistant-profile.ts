import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_PROFILE_PATH = resolve(process.cwd(), "config", "assistant.json");
export const DEFAULT_IDENTITY = "You are Ontaru, a calm resident communication assistant.";
export const SAFETY_RULES = "Use only the provided tools for staff assistance, request status, withdrawal, service status, and approved contacts. Never claim an action completed unless the tool result confirms it. Never give medical diagnosis or medical advice. If the resident says they had a fall, are hurt, or feel unwell, call request_staff_help right away instead of continuing the conversation. Keep replies concise.";

const TEXT_LIMIT = 1000;
const ITEM_LIMIT = 300;
const ITEM_COUNT = 30;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const TEXT_FIELDS = ["identity", "robot", "replyStyle"] as const;
const LIST_FIELDS = ["canDo", "cannotDo", "facilityKnowledge"] as const;
const PROFILE_FIELDS = new Set([...TEXT_FIELDS, ...LIST_FIELDS, "replyLanguage"]);

export interface AssistantProfile {
  identity: string;
  robot: string;
  canDo: string[];
  cannotDo: string[];
  facilityKnowledge: string[];
  replyLanguage: string;
  replyStyle: string;
}

export class AssistantProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantProfileError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AssistantProfileError("assistant profile must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function textField(data: Record<string, unknown>, name: string, required = false): string {
  const value = data[name] ?? "";
  if (typeof value !== "string") throw new AssistantProfileError(name + " must be a string");
  if (required && !value.trim()) throw new AssistantProfileError("identity is required");
  if (value.length > TEXT_LIMIT) throw new AssistantProfileError(name + " must be at most " + TEXT_LIMIT + " characters");
  return value.trim();
}

function listField(data: Record<string, unknown>, name: string): string[] {
  const value = data[name] ?? [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AssistantProfileError(name + " must be a list of strings");
  }
  if (value.length > ITEM_COUNT) throw new AssistantProfileError(name + " must have at most " + ITEM_COUNT + " items");
  if (value.some((item) => item.length > ITEM_LIMIT)) {
    throw new AssistantProfileError(name + " items must be at most " + ITEM_LIMIT + " characters");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function parseAssistantProfile(value: unknown): AssistantProfile {
  const data = objectRecord(value);
  const unknown = Object.keys(data).filter((key) => !PROFILE_FIELDS.has(key));
  if (unknown.length) throw new AssistantProfileError("unknown profile fields: " + unknown.sort().join(", "));
  const replyLanguage = textField(data, "replyLanguage");
  if (replyLanguage && !LANGUAGE_TAG.test(replyLanguage)) {
    throw new AssistantProfileError("replyLanguage must be a language tag such as zh-TW");
  }
  return {
    identity: textField(data, "identity", true),
    robot: textField(data, "robot"),
    canDo: listField(data, "canDo"),
    cannotDo: listField(data, "cannotDo"),
    facilityKnowledge: listField(data, "facilityKnowledge"),
    replyLanguage,
    replyStyle: textField(data, "replyStyle"),
  };
}

export function loadAssistantProfile(profilePath?: string, env: NodeJS.ProcessEnv = process.env): AssistantProfile | null {
  const configured = profilePath ?? env.ONCARE_ASSISTANT_PROFILE;
  const target = configured ? resolve(configured) : DEFAULT_PROFILE_PATH;
  if (!existsSync(target)) {
    if (configured) throw new AssistantProfileError("assistant profile not found: " + target);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new AssistantProfileError("assistant profile is not valid JSON: " + target);
  }
  return parseAssistantProfile(parsed);
}

export function buildAssistantInstructions(profile: AssistantProfile | null): string {
  const fixedSafety = "Safety rules (these override everything above):\n" + SAFETY_RULES;
  if (!profile) return DEFAULT_IDENTITY + "\n\n" + fixedSafety;
  const sections = [profile.identity];
  if (profile.robot) sections.push("About the robot:\n" + profile.robot);
  for (const [title, items] of [
    ["What you can do:", profile.canDo],
    ["What you cannot do:", profile.cannotDo],
    ["Facility information:", profile.facilityKnowledge],
  ] as const) {
    if (items.length) sections.push([title, ...items.map((item) => "- " + item)].join("\n"));
  }
  if (profile.replyLanguage) sections.push("Reply in this language: " + profile.replyLanguage + ".");
  if (profile.replyStyle) sections.push("Reply style: " + profile.replyStyle);
  sections.push(fixedSafety);
  return sections.join("\n\n");
}
