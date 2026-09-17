import { expect, test } from "vitest";
import * as core from "../src/index";

test("index exports the public surface", () => {
  for (const name of [
    "VISIT_STATES", "transitionVisit", "TASK_STATES", "transitionTask",
    "parseTaskProposal", "TaskProposalSchema", "evaluateProposal", "DEMO_CATALOGUE",
    "makeTransitionEvent", "AuditEventSchema", "KeywordParser",
  ]) {
    expect(core, name).toHaveProperty(name);
  }
});
