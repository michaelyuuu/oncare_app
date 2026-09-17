import type { TaskProposal } from "../intent";
import type { ItemCatalogue } from "../policy";

export interface ParseContext {
  recipientId: string;
  defaultDestinationId: string;
  catalogue: ItemCatalogue;
}

export type ParseOutcome =
  | { kind: "proposal"; proposal: TaskProposal }
  | { kind: "clarification"; question: string; options: string[] };

export interface IntentParser {
  parse(text: string, ctx: ParseContext): ParseOutcome;
}
