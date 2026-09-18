# Parser accuracy corpus

This regression corpus covers the handover speech-parsing target: every clear request should produce exactly the intended approved item, while at least 90% of ambiguous or empty requests should produce a clarification rather than an executable proposal. Multi-item sentences are always asserted as clarification cases.

The corpus currently contains 20 clear phrases and 21 ambiguous phrases. The measured result from `npx vitest run packages/core/test/parser-corpus.test.ts` is recorded by the test runner; the local run for this implementation passed all three assertions (20/20 clear phrases, 21/21 ambiguous phrases clarified, 100% clarification rate).

To add a phrase, place it in `CLEAR` with the expected catalogue item or in `AMBIGUOUS` when it must clarify. Add a synonym in `packages/core/src/parser/keyword.ts` only when a genuinely clear phrase fails; keep the ambiguity assertions strict and rerun the focused test plus the full suite.
