import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { Api } from "@oncare/web-common";
import { LaundryAI } from "../src/admin/LaundryAI";

const tools = { tools: [
  { name: "get_laundry_overview" },
  { name: "find_garments" },
] };
const overview = { result: {
  availability: "available" as const,
  total: 12,
  active: 9,
  lostOrDiscarded: 2,
  recentlyWashed: 4,
  syncedAt: "2026-09-21T12:04:59.999Z",
  stale: false,
  warnings: [],
} };

type ApiOverrides = {
  get?: (path: string) => Promise<unknown>;
  post?: (path: string, body?: unknown) => Promise<unknown>;
};

function fakeApi(overrides: ApiOverrides = {}) {
  const getMock = vi.fn(overrides.get ?? (async () => tools));
  const postMock = vi.fn(overrides.post ?? (async (path: string) => path === "/tools/get_laundry_overview/invoke"
    ? overview
    : path === "/tools/find_garments/invoke"
      ? { result: { availability: "available", syncedAt: overview.result.syncedAt,
          stale: false, warnings: [], garments: [] } }
      : { answer: "Laundry records are current.", toolResults: [] }));
  const api: Api = {
    get: async <T,>(path: string) => await getMock(path) as T,
    post: async <T,>(path: string, body?: unknown) => await postMock(path, body) as T,
    patch: async <T,>() => undefined as T,
    del: async <T,>() => undefined as T,
  };
  return { api, getMock, postMock };
}

afterEach(cleanup);

test("keeps answer provenance independent from current overview and model prose", async () => {
  const client = fakeApi({ post: async (path) => path === "/tools/get_laundry_overview/invoke" ? overview : {
    answer: "There are twelve garments.",
    provider: "provider-secret", arguments: "raw-arguments-secret",
    toolResults: [
      { name: "get_laundry_overview", arguments: "raw-arguments-secret", result: { ok: true, result: {
        ...overview.result, syncedAt: "2026-09-20T10:00:00.000Z", stale: true,
        warnings: [{ kind: "station_unavailable", message: "station-token-secret" }],
        sourceKey: "EPC-secret",
      } } },
      { name: "find_garments", result: { ok: true, result: {
        availability: "available", syncedAt: "2026-09-21T11:00:00.000Z", stale: false, warnings: [], garments: [],
      } } },
    ],
  } });
  render(<LaundryAI api={client.api} />);
  await screen.findByText("12");
  await userEvent.type(screen.getByLabelText("Ask about laundry"), "How many?");
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
  const answer = await screen.findByRole("status", { name: "Laundry assistant answer" });
  expect(within(answer).getByText("There are twelve garments.")).toBeInTheDocument();
  const rails = within(answer).getAllByLabelText("Assistant result freshness");
  expect(rails).toHaveLength(2);
  expect(within(rails[0]!).getByText("Stale")).toBeInTheDocument();
  expect(within(rails[0]!).getByText("Sep 20, 2026, 10:00 AM")).toBeInTheDocument();
  expect(within(rails[1]!).getByText("Current")).toBeInTheDocument();
  expect(within(rails[1]!).getByText("Sep 21, 2026, 11:00 AM")).toBeInTheDocument();
  expect(within(answer).getByText("Station data is temporarily unavailable.")).toBeInTheDocument();
  expect(within(screen.getByLabelText("Overview data freshness")).getByText("Current")).toBeInTheDocument();
  for (const secret of ["provider-secret", "raw-arguments-secret", "station-token-secret", "EPC-secret"]) {
    expect(document.body.textContent).not.toContain(secret);
  }
});

test.each(["never", "failed", "none"])("does not invent verified answer freshness for %s results", async (state) => {
  const result = state === "never"
    ? { ok: true, result: { ...overview.result, availability: "never_synced", syncedAt: null, total: 0, active: 0, lostOrDiscarded: 0, recentlyWashed: 0 } }
    : { ok: false, status: 403, error: "private-error", detail: "private-detail" };
  const client = fakeApi({ post: async (path) => path === "/tools/get_laundry_overview/invoke" ? overview : {
    answer: "Please review the records.",
    toolResults: state === "none" ? [] : [{ name: "get_laundry_overview", result }],
  } });
  render(<LaundryAI api={client.api} />);
  await screen.findByText("12");
  await userEvent.type(screen.getByLabelText("Ask about laundry"), "Summary?");
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
  const answer = await screen.findByRole("status", { name: "Laundry assistant answer" });
  expect(within(answer).getByText(state === "never" ? "Never synced"
    : state === "failed" ? "Unavailable" : "No verified laundry data was used for this answer.")).toBeInTheDocument();
  expect(within(answer).queryByText("Current")).toBeNull();
  expect(document.body.textContent).not.toMatch(/private-error|private-detail/);
});

test.each([
  [{ name: "get_laundry_overview", result: { ok: true, result: { ...overview.result, syncedAt: "not-a-date" } } }],
  [{ name: "get_laundry_overview", result: { ok: true, result: { ...overview.result, warnings: "raw-secret" } } }],
  [{ name: "unknown_tool", result: { ok: true, result: overview.result } }],
  [{ name: "find_garments", result: { ok: true, result: { ...overview.result, garments: [{ epc: "EPC-secret" }] } } }],
].map((toolResults) => ({ toolResults })))("rejects malformed assistant result envelopes without rendering unverified prose", async ({ toolResults }) => {
  const client = fakeApi({ post: async (path) => path === "/tools/get_laundry_overview/invoke" ? overview : {
    answer: "Unverified answer", toolResults,
  } });
  render(<LaundryAI api={client.api} />);
  await screen.findByText("12");
  await userEvent.type(screen.getByLabelText("Ask about laundry"), "Summary?");
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
  expect(await screen.findByText("The laundry assistant could not answer. Structured search still works.")).toBeInTheDocument();
  expect(screen.queryByText("Unverified answer")).toBeNull();
  expect(document.body.textContent).not.toMatch(/raw-secret|EPC-secret/);
});

test("loads the tool catalog and overview with exact freshness and one metric ledger", async () => {
  const client = fakeApi();
  render(<LaundryAI api={client.api} />);

  expect(await screen.findByRole("heading", { name: "Laundry AI" })).toBeInTheDocument();
  expect(client.getMock).toHaveBeenCalledWith("/tools");
  expect(client.postMock).toHaveBeenCalledWith("/tools/get_laundry_overview/invoke", {});
  expect(screen.getByText("Sep 21, 2026, 12:04 PM")).toBeInTheDocument();
  expect(screen.getByText("Current")).toBeInTheDocument();
  const ledger = screen.getByLabelText("Laundry totals");
  for (const value of ["12", "9", "2", "4"]) {
    expect(within(ledger).getByText(value)).toBeInTheDocument();
  }
});

test("distinguishes stale, valid zero, safe warnings, and never-synced data", async () => {
  const staleApi = fakeApi({ post: async () => ({ result: {
    ...overview.result,
    total: 0,
    active: 0,
    lostOrDiscarded: 0,
    recentlyWashed: 0,
    stale: true,
    warnings: [{ kind: "invalid_data", message: "do not render raw" }],
  } }) });
  const first = render(<LaundryAI api={staleApi.api} />);
  const staleStatus = await screen.findByRole("status", { name: "Laundry overview notices" });
  expect(within(staleStatus).getByText("Laundry data is stale.")).toBeInTheDocument();
  expect(within(staleStatus).getByText("No garments are recorded in the current data.")).toBeInTheDocument();
  expect(within(staleStatus).getByText("Some station data could not be verified.")).toBeInTheDocument();
  expect(screen.queryByText("do not render raw")).toBeNull();
  expect(within(screen.getByLabelText("Laundry totals")).getAllByText("0")).toHaveLength(4);
  first.unmount();

  const neverApi = fakeApi({ post: async () => ({ result: {
    ...overview.result,
    availability: "never_synced",
    total: 0,
    active: 0,
    lostOrDiscarded: 0,
    recentlyWashed: 0,
    syncedAt: null,
  } }) });
  render(<LaundryAI api={neverApi.api} />);
  const neverStatus = await screen.findByRole("status", { name: "Laundry overview notices" });
  expect(within(neverStatus).getByText("Laundry stations have never synced.")).toBeInTheDocument();
  expect(screen.getByText("Never synced")).toBeInTheDocument();
  expect(screen.queryByText("No garments are recorded in the current data.")).toBeNull();
  expect(screen.queryByLabelText("Laundry totals")).toBeNull();
});

test("keeps overview freshness on the ledger and search freshness by results", async () => {
  const searchSyncedAt = "2026-09-22T08:30:00.000Z";
  const client = fakeApi({ post: async (path: string) => path === "/tools/get_laundry_overview/invoke"
    ? overview
    : { result: {
      availability: "available",
      syncedAt: searchSyncedAt,
      stale: true,
      warnings: [],
      garments: [{
        residentId: "r1", residentName: "Ana Bell", name: "Green jumper",
        category: "jumper", color: "green", status: "active", washCount: 2,
        lastSeen: null, syncedAt: searchSyncedAt, stale: true,
      }],
    } } });
  render(<LaundryAI api={client.api} />);
  await screen.findByText("12");
  await userEvent.click(screen.getByRole("button", { name: "Find garments" }));

  const overviewFreshness = screen.getByLabelText("Overview data freshness");
  expect(within(overviewFreshness).getByText("Current")).toBeInTheDocument();
  expect(within(overviewFreshness).getByText("Sep 21, 2026, 12:04 PM")).toBeInTheDocument();
  const searchFreshness = await screen.findByLabelText("Search result freshness");
  expect(within(searchFreshness).getByText("Stale")).toBeInTheDocument();
  expect(within(searchFreshness).getByText("Sep 22, 2026, 8:30 AM")).toBeInTheDocument();
});

test("submits trimmed filters and preserves API order in the result table", async () => {
  const client = fakeApi({ post: async (path: string) => path === "/tools/get_laundry_overview/invoke"
    ? overview
    : { result: {
      availability: "available",
      syncedAt: overview.result.syncedAt,
      stale: false,
      warnings: [],
      garments: [
        { residentId: "r2", residentName: "Zara Cole", name: "Blue cardigan",
          category: "cardigan", color: "blue", status: "active", washCount: 4,
          lastSeen: "2026-09-21T11:59:00.000Z", syncedAt: overview.result.syncedAt,
          stale: false },
        { residentId: "r1", residentName: "Ana Bell", name: "Green jumper",
          category: "jumper", color: "green", status: "lost", washCount: 2,
          lastSeen: null, syncedAt: overview.result.syncedAt, stale: false },
      ],
    } } });
  render(<LaundryAI api={client.api} />);
  await screen.findByText("12");
  await userEvent.type(screen.getByLabelText("Resident id"), "resident_1");
  await userEvent.type(screen.getByLabelText("Garment name"), " cardigan ");
  await userEvent.type(screen.getByLabelText("Category"), " tops ");
  await userEvent.type(screen.getByLabelText("Color"), " blue ");
  await userEvent.selectOptions(screen.getByLabelText("Status"), "active");
  await userEvent.click(screen.getByRole("button", { name: "Find garments" }));

  expect(client.postMock).toHaveBeenLastCalledWith("/tools/find_garments/invoke", {
    residentId: "resident_1", name: "cardigan", category: "tops", color: "blue",
    status: "active",
  });
  const rows = screen.getAllByRole("row");
  expect(within(rows[1]!).getByText("Zara Cole")).toBeInTheDocument();
  expect(within(rows[2]!).getByText("Ana Bell")).toBeInTheDocument();
  expect(screen.getByText("2 results returned by the laundry service.")).toBeInTheDocument();
});

test("shows all twenty API-bounded results and asks for narrower filters", async () => {
  const client = fakeApi({ post: async (path: string) => path === "/tools/get_laundry_overview/invoke"
    ? overview
    : { result: {
      availability: "available", syncedAt: overview.result.syncedAt, stale: false,
      warnings: [], garments: Array.from({ length: 20 }, (_, index) => ({
        residentId: `r${index}`, residentName: `Resident ${index}`,
        name: `Garment ${index}`, category: "top", color: "blue", status: "active",
        washCount: index, lastSeen: null, syncedAt: overview.result.syncedAt, stale: false,
      })),
    } } });
  render(<LaundryAI api={client.api} />);
  await screen.findByText("12");
  await userEvent.click(screen.getByRole("button", { name: "Find garments" }));
  expect(await screen.findByText("Showing the first 20 results. Add filters to narrow the list.")).toBeInTheDocument();
  expect(screen.getAllByRole("row")).toHaveLength(21);
  expect(screen.getByText("Garment 19")).toBeInTheDocument();
});

test("an assistant 503 leaves structured overview and search usable", async () => {
  const client = fakeApi({ post: async (path: string) => {
    if (path === "/tools/get_laundry_overview/invoke") return overview;
    if (path === "/admin/laundry/ask") {
      throw Object.assign(new Error("unavailable"), { status: 503 });
    }
    return { result: { availability: "available", syncedAt: overview.result.syncedAt,
      stale: false, warnings: [], garments: [] } };
  } });
  render(<LaundryAI api={client.api} />);
  await screen.findByText("12");
  await userEvent.type(screen.getByLabelText("Ask about laundry"), "What needs attention?");
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
  expect(await screen.findByText(
    "The laundry assistant is unavailable. Structured search still works.",
  )).toBeInTheDocument();
  expect(screen.getByText("12")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Find garments" }));
  expect(await screen.findByText("No garments match these filters.")).toBeInTheDocument();
});

test("a failed search keeps entered filters and uses a safe request warning", async () => {
  const client = fakeApi({ post: async (path: string) => {
    if (path === "/tools/get_laundry_overview/invoke") return overview;
    throw new Error("private upstream detail");
  } });
  render(<LaundryAI api={client.api} />);
  await screen.findByText("12");
  await userEvent.type(screen.getByLabelText("Color"), "violet");
  await userEvent.click(screen.getByRole("button", { name: "Find garments" }));
  expect(await screen.findByText(
    "Garments could not be loaded. Check the connection and try again.",
  )).toBeInTheDocument();
  expect(screen.getByLabelText("Color")).toHaveValue("violet");
  expect(screen.queryByText("private upstream detail")).toBeNull();
});

test("malformed overview data produces a safe unavailable state", async () => {
  const client = fakeApi({ post: async () => ({ result: { total: "secret" } }) });
  render(<LaundryAI api={client.api} />);
  expect(await screen.findByText("Laundry data could not be verified. Try again.")).toBeInTheDocument();
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.queryByText("secret")).toBeNull();
});
