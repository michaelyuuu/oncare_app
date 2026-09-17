import { z } from "zod";

/**
 * Structured intents that a language model or a deterministic parser may
 * produce from family speech or text. This is the ONLY shape the parsing
 * layer is allowed to emit; anything that fails this schema is discarded.
 *
 * Design rules (handover section 15):
 * - strict object: unknown keys are rejected so a model cannot smuggle
 *   commands, topics, or arguments past the schema.
 * - identifiers are lowercase snake_case catalogue keys, never free text.
 * - requires_confirmation is literally `true`; a proposal can never opt out.
 */

/** Catalogue identifier: `water_bottle`, `bedside_table_demo`, `resident_demo_01`. */
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "must be lowercase snake_case");

export const TASK_TYPES = ["deliver_item"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TaskProposalSchema = z
  .object({
    task_type: z.enum(TASK_TYPES),
    item: IdentifierSchema,
    recipient: IdentifierSchema,
    destination: IdentifierSchema,
    requires_confirmation: z.literal(true),
  })
  .strict();

export type TaskProposal = z.infer<typeof TaskProposalSchema>;

export type ParseResult =
  | { ok: true; proposal: TaskProposal }
  | { ok: false; issues: string[] };

export function parseTaskProposal(input: unknown): ParseResult {
  const result = TaskProposalSchema.safeParse(input);
  if (result.success) {
    return { ok: true, proposal: result.data };
  }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return { ok: false, issues };
}
