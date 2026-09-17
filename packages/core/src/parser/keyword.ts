import { parseTaskProposal } from "../intent";
import type { ClarificationCode, IntentParser, ParseContext, ParseOutcome } from "./types";

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

/** Escape regex metacharacters so a needle can be interpolated into a RegExp safely. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class KeywordParser implements IntentParser {
  constructor(private readonly synonyms: Record<string, string[]> = DEFAULT_SYNONYMS) {}

  parse(text: string, ctx: ParseContext): ParseOutcome {
    const clarify = (code: ClarificationCode, question: string, options: string[]): ParseOutcome =>
      ({ kind: "clarification", code, question, options });
    const approvedItemsList = [...ctx.catalogue.approvedItems];

    let norm = normalize(text);
    if (norm === "") return clarify("clarify_unparseable", "What would you like the robot to bring?", approvedItemsList);

    // Build flat list of (itemId, normalizedSynonym) pairs and skip empty normalized strings
    const allSynonyms: Array<[string, string]> = [];
    for (const [itemId, words] of Object.entries(this.synonyms)) {
      for (const w of words) {
        const needle = normalize(w);
        if (needle !== "") {
          allSynonyms.push([itemId, needle]);
        }
      }
    }

    // Sort by synonym length descending (longest first)
    allSynonyms.sort((a, b) => b[1].length - a[1].length);

    const found = new Set<string>();

    // Walk through sorted synonyms once; remove matched text so shorter synonyms cannot re-match
    for (const [itemId, needle] of allSynonyms) {
      const isLatin = /[a-z]/.test(needle);

      // Build regex once and reuse for both test and replacement
      // Use lookahead for trailing boundary so it's not consumed; allows matching multiple back-to-back occurrences
      const escaped = escapeRegExp(needle);
      const regex = isLatin
        ? new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "g")
        : undefined; // CJK uses replaceAll, no regex needed

      const hit = isLatin
        ? regex!.test(norm)
        : norm.includes(needle);

      if (hit) {
        found.add(itemId);
        // Remove ALL occurrences of the matched text so shorter synonyms cannot re-match
        if (isLatin) {
          norm = norm.replace(regex!, " ");
        } else {
          norm = norm.replaceAll(needle, " ");
        }
        // Normalize whitespace after removal
        norm = norm.replace(/\s+/g, " ").trim();
      }
    }

    if (found.size === 0) return clarify("clarify_no_item", "Which item should the robot bring?", approvedItemsList);
    if (found.size > 1) {
      // Never offer a prohibited item as a choice; fall back to the whole
      // approved list when nothing matched is approved.
      const approvedMatches = [...found].filter((i) => ctx.catalogue.approvedItems.includes(i));
      const options = approvedMatches.length > 0 ? approvedMatches : approvedItemsList;
      return clarify("clarify_multiple", "Which one item should the robot bring?", options);
    }

    const [item] = found;
    const result = parseTaskProposal({
      task_type: "deliver_item",
      item,
      recipient: ctx.recipientId,
      destination: ctx.defaultDestinationId,
      requires_confirmation: true,
    });
    if (!result.ok) return clarify("clarify_unparseable", "Sorry, I could not understand that request.", approvedItemsList);
    return { kind: "proposal", proposal: result.proposal };
  }
}
