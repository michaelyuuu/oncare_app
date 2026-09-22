import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { RESERVATION_STATUSES, VISIT_SLOT_STATES } from "../src";

const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

function findLocalSchedulingDeclarations(_fileName: string, _sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    _fileName,
    _sourceText,
    ts.ScriptTarget.Latest,
    true,
    _fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const contracts = [
    { label: "reservation status", values: new Set<string>(RESERVATION_STATUSES) },
    { label: "visit slot state", values: new Set<string>(VISIT_SLOT_STATES) },
  ];
  const declarations: string[] = [];

  const matchingContracts = (values: string[]) => {
    const valueSet = new Set(values);
    return contracts.filter((contract) =>
      [...contract.values].every((value) => valueSet.has(value))
    );
  };

  const unwrapExpression = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (
      ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isParenthesizedExpression(current)
      || ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };

  const stringValue = (node: ts.Node): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    return undefined;
  };

  const recordMatch = (
    node: ts.Node,
    kind: "union" | "array" | "object" | "enum",
    values: Array<string | undefined>,
  ) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const stringValues = values.filter((value): value is string => value !== undefined);
    for (const contract of matchingContracts(stringValues)) {
      declarations.push(`${contract.label} ${kind} at line ${line}`);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isUnionTypeNode(node)) {
      recordMatch(
        node,
        "union",
        node.types.map((member) =>
          ts.isLiteralTypeNode(member) ? stringValue(member.literal) : undefined
        ),
      );
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        recordMatch(
          node,
          "array",
          initializer.elements.map((element) => stringValue(unwrapExpression(element))),
        );
      }
      if (ts.isObjectLiteralExpression(initializer)) {
        recordMatch(
          node,
          "object",
          initializer.properties.map((property) =>
            ts.isPropertyAssignment(property)
              ? stringValue(unwrapExpression(property.initializer))
              : undefined
          ),
        );
      }
    }

    if (ts.isEnumDeclaration(node)) {
      recordMatch(
        node,
        "enum",
        node.members.map((member) =>
          member.initializer ? stringValue(unwrapExpression(member.initializer)) : undefined
        ),
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return declarations;
}

describe("shared scheduling contracts", () => {
  test("exports each reservation status once", () => {
    expect(RESERVATION_STATUSES).toEqual(["pending", "confirmed", "expired", "cancelled"]);
    expect(new Set(RESERVATION_STATUSES).size).toBe(RESERVATION_STATUSES.length);
  });

  test("exports each rendered slot state once", () => {
    expect(VISIT_SLOT_STATES).toEqual(["available", "blocked", "pending", "confirmed"]);
    expect(new Set(VISIT_SLOT_STATES).size).toBe(VISIT_SLOT_STATES.length);
  });

  test("detects app-owned scheduling contract declarations without flagging ordinary uses", () => {
    const sourceText = `
      type LocalReservationStatus = "pending" | "confirmed" | "expired" | "cancelled";
      const localSlotStates = ["available", "blocked", "pending", "confirmed"] as const;
      const isConfirmed = reservation.status === "confirmed";
    `;

    expect(findLocalSchedulingDeclarations("apps/family/src/scheduling.ts", sourceText)).toEqual([
      "reservation status union at line 2",
      "visit slot state array at line 3",
    ]);
    expect(findLocalSchedulingDeclarations(
      "apps/family/src/visit.ts",
      `const isConfirmed = reservation.status === "confirmed";`,
    )).toEqual([]);
  });

  test("detects object-valued scheduling contract declarations", () => {
    const sourceText = `
      const LocalReservationStatus = {
        Pending: "pending",
        Confirmed: "confirmed",
        Expired: "expired",
        Cancelled: "cancelled",
      } as const;
    `;

    expect(findLocalSchedulingDeclarations("apps/family/src/scheduling.ts", sourceText)).toEqual([
      "reservation status object at line 2",
    ]);
  });

  test("detects string-valued scheduling contract enums", () => {
    const sourceText = `
      enum LocalVisitSlotState {
        Available = "available",
        Blocked = "blocked",
        Pending = "pending",
        Confirmed = "confirmed",
      }
    `;

    expect(findLocalSchedulingDeclarations("apps/family/src/scheduling.ts", sourceText)).toEqual([
      "visit slot state enum at line 2",
    ]);
  });

  test("detects scheduling contract declaration supersets", () => {
    const sourceText = `
      const localSlotStates = ["available", "blocked", "pending", "confirmed", "unknown"] as const;
    `;

    expect(findLocalSchedulingDeclarations("apps/family/src/scheduling.ts", sourceText)).toEqual([
      "visit slot state array at line 2",
    ]);
  });

  test("allows ordinary single-value scheduling comparisons", () => {
    const sourceText = `
      const isConfirmed = reservation.status === "confirmed";
      const isAvailable = slot.state === "available";
    `;

    expect(findLocalSchedulingDeclarations("apps/family/src/visit.ts", sourceText)).toEqual([]);
  });

  test("apps do not redeclare shared scheduling contracts", () => {
    const appSourceFiles = execFileSync(
      "git",
      ["ls-files", "--", "apps/**/*.ts", "apps/**/*.tsx"],
      { cwd: repositoryRoot, encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .filter((fileName) => !/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/u.test(fileName))
      .filter((fileName) => !/\.(?:test|spec)\.tsx?$/u.test(fileName));

    const violations = appSourceFiles.flatMap((fileName) => {
      const sourceText = readFileSync(resolve(repositoryRoot, fileName), "utf8");
      return findLocalSchedulingDeclarations(fileName, sourceText)
        .map((declaration) => `${fileName}: ${declaration}`);
    });

    expect(
      violations,
      `Scheduling statuses and slot states must be imported from @oncare/web-common.\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
