import type { TaskProposal } from "../intent";
import type { ItemCatalogue } from "../policy";

export interface ParseContext {
  recipientId: string;
  defaultDestinationId: string;
  catalogue: ItemCatalogue;
}

/** Fixed snake_case codes so a clarification can be audited without free text. */
export type ClarificationCode = "clarify_no_item" | "clarify_multiple" | "clarify_unparseable";

export type ParseOutcome =
  | { kind: "proposal"; proposal: TaskProposal }
  | { kind: "clarification"; code: ClarificationCode; question: string; options: string[] };

export interface IntentParser {
  parse(text: string, ctx: ParseContext): ParseOutcome;
}
