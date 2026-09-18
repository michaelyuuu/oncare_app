import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "@oncare/web-common";
import { Locations } from "../src/components/Locations";

afterEach(cleanup);
const row = { id: "standby", name: "Standby", kind: "standby", x: 1, y: 2, yaw: 0, approved: true };
const pose = { x: 3.25, y: -1.5, yaw: 1.57 };
function setup() {
  const writes: unknown[] = [];
  let failure = false;
  let finish: ((response: Response) => void) | undefined;
  let defer = false;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as object;
      writes.push(body);
      if (defer) return new Promise<Response>(resolve => { finish = resolve; });
      return new Response(JSON.stringify(failure ? { error: "request" } : { location: { ...row, ...body } }), { status: failure ? 503 : 200 });
    }
    return new Response(JSON.stringify({ locations: [row] }));
  });
  return { api: createApi("http://api", () => "token", fetcher), writes, fail: () => { failure = true; }, defer: () => { defer = true; }, finish: () => finish!(new Response(JSON.stringify({ location: { ...row, ...pose } }))) };
}

test("Use robot position PATCHes immediately; manual coordinates wait for Save", async () => {
  const { api, writes } = setup();
  render(<Locations api={api} pose={pose}/>);
  await userEvent.click(await screen.findByRole("button", { name: "Use robot's position here" }));
  expect(writes).toEqual([pose]);
  expect(await screen.findByText("Saved")).toBeInTheDocument();
  expect(screen.getByLabelText("Standby: x (m)")).toHaveValue(3.25);
  fireEvent.change(screen.getByLabelText("Standby: x (m)"), { target: { value: "4" } });
  expect(writes).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Save coordinates" }));
  expect(writes[1]).toEqual({ x: 4, y: -1.5, yaw: 1.57 });
});

test("missing pose disables capture, blank coordinates do not send, and errors preserve edits", async () => {
  const { api, writes, fail } = setup();
  render(<Locations api={api} pose={null}/>);
  expect(await screen.findByRole("button", { name: "Use robot's position here" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Standby: x (m)"), { target: { value: "" } });
  await userEvent.click(screen.getByRole("button", { name: "Save coordinates" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter finite numbers");
  expect(writes).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Standby: x (m)"), { target: { value: "9" } });
  fail();
  await userEvent.click(screen.getByRole("button", { name: "Save coordinates" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("not saved");
  expect(screen.getByLabelText("Standby: x (m)")).toHaveValue(9);
  expect(screen.getByRole("button", { name: "Save coordinates" })).toBeEnabled();
});

test("pending row prevents duplicates and late saves cannot cross API sessions or unmount", async () => {
  const old = setup(); old.defer();
  const view = render(<Locations api={old.api} pose={pose}/>);
  await userEvent.dblClick(await screen.findByRole("button", { name: "Use robot's position here" }));
  expect(old.writes).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Save coordinates" })).toBeDisabled();
  const next = setup();
  view.rerender(<Locations api={next.api} pose={null}/>);
  await screen.findByLabelText("Standby: x (m)");
  await act(async () => old.finish());
  expect(screen.getByLabelText("Standby: x (m)")).toHaveValue(1);
  expect(screen.queryByText("Saved")).toBeNull();
  next.defer();
  await userEvent.click(screen.getByRole("button", { name: "Save coordinates" }));
  view.unmount();
  await act(async () => next.finish());
});

test("load errors have a retry and stale loads cannot replace a new session", async () => {
  let finish!: (response: Response) => void;
  const old = createApi("http://old", () => "old", () => new Promise(resolve => { finish = resolve; }));
  const view = render(<Locations api={old} pose={null}/>);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValue(new Response(JSON.stringify({ locations: [row] })));
  view.rerender(<Locations api={createApi("http://new", () => "new", fetcher)} pose={null}/>);
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Retry locations" }));
  await screen.findByLabelText("Standby: x (m)");
  await act(async () => finish(new Response('{"locations":[]}')));
  await waitFor(() => expect(screen.getByLabelText("Standby: x (m)")).toBeInTheDocument());
});
