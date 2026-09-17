import { parseTaskProposal } from "../intent";
import type { IntentParser, ParseContext, ParseOutcome } from "./types";

/**
 * Deterministic parser: matches item synonyms in the text. No network, no model.
 * Prohibited items are matched too, on purpose, so the policy layer can reject
 * them with `prohibited_item` instead of a vague clarification.
 */
export const DEFAULT_SYNONYMS: Record<string, string[]> = {
  water_bottle: ["water bottle", "bottle of water", "water", "水瓶", "水"],
  tissue_box: ["tissue box", "tissues", "tissue", "面紙", "衛生紙"],
  tv_remote: ["tv remote", "remote control", "remote", "遙控器"],
  medication: ["medication", "medicine", "pills", "藥"],
  hot_tea: ["hot tea", "tea", "熱茶"],
  coffee: ["coffee", "咖啡"],
  knife: ["knife", "刀"],
  scissors: ["scissors", "剪刀"],
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export class KeywordParser implements IntentParser {
  constructor(private readonly synonyms: Record<string, string[]> = DEFAULT_SYNONYMS) {}

  parse(text: string, ctx: ParseContext): ParseOutcome {
    const clarify = (question: string, options: string[]): ParseOutcome => ({ kind: "clarification", question, options });
    const norm = normalize(text);
    if (norm === "") return clarify("What would you like the robot to bring?", [...ctx.catalogue.approvedItems]);

    const found = new Set<string>();
    // Longest synonyms first so "water bottle" wins over "water" for the same item.
    for (const [itemId, words] of Object.entries(this.synonyms)) {
      for (const w of [...words].sort((a, b) => b.length - a.length)) {
        const needle = normalize(w);
        const hit = /[a-z]/.test(needle)
          ? new RegExp(`(^|\\s)${needle}(\\s|$)`).test(norm)
          : norm.includes(needle);
        if (hit) { found.add(itemId); break; }
      }
    }

    if (found.size === 0) return clarify("Which item should the robot bring?", [...ctx.catalogue.approvedItems]);
    if (found.size > 1) return clarify("Which one item should the robot bring?", [...found]);

    const [item] = found;
    const result = parseTaskProposal({
      task_type: "deliver_item",
      item,
      recipient: ctx.recipientId,
      destination: ctx.defaultDestinationId,
      requires_confirmation: true,
    });
    if (!result.ok) return clarify("Sorry, I could not understand that request.", [...ctx.catalogue.approvedItems]);
    return { kind: "proposal", proposal: result.proposal };
  }
}
