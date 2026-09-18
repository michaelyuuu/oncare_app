import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AskRobot } from "../src/components/AskRobot";

const sockets: NoopSocket[] = [];
class NoopSocket {
  onopen: unknown; onmessage: unknown; onclose: unknown;
  constructor(_url: string) { sockets.push(this); }
  close() {}
}

function apiWith(handler: (path: string, body?: unknown) => unknown) {
  return {
    get: vi.fn(async (path: string) => handler(path)),
    post: vi.fn(async (path: string, body?: unknown) => handler(path, body)),
  } as any;
}

const proposalTask = (state = "awaiting_user_confirmation") => ({
  id: "t1",
  state,
  correlationId: "task-t1",
  proposal: { task_type: "deliver_item", item: "water_bottle", recipient: "r", destination: "bedside_table_demo", requires_confirmation: true },
});

beforeEach(() => {
  sockets.length = 0;
  vi.unstubAllGlobals();
  vi.stubGlobal("WebSocket", NoopSocket);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test("text -> translated clarification chips -> proposal card -> confirm -> tracking", async () => {
  let task = proposalTask();
  const api = apiWith((path, body: any) => {
    if (path === "/tasks" && body.text === "something") return { kind: "clarification", question: "server parser text", options: ["water_bottle", "tissue_box", "tv_remote"] };
    if (path === "/tasks") return { kind: "proposal", task };
    if (path === "/tasks/t1/confirm") { task = proposalTask("awaiting_policy_or_staff"); return { task }; }
    if (path === "/tasks/t1") return { task };
    throw new Error(path);
  });
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "something");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Which one?")).toBeInTheDocument();
  expect(screen.queryByText("server parser text")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "water bottle" }));
  expect(await screen.findByText("Send the robot with the water bottle to Mom's bedside table?")).toBeInTheDocument();
  expect(api.post).toHaveBeenLastCalledWith("/tasks", { residentId: "r", text: "water bottle", visitId: "v1" });
  await userEvent.click(screen.getByRole("button", { name: "Yes, send the robot" }));
  expect(await screen.findByText("Care home approval")).toHaveAttribute("aria-current", "step");
});

test("request failure gives translated staff-notified feedback and retry", async () => {
  let fail = true;
  const api = apiWith((path) => {
    if (path === "/tasks" && fail) { fail = false; throw new Error("secret backend detail"); }
    if (path === "/tasks") return { kind: "proposal", task: proposalTask() };
    throw new Error(path);
  });
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "water");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't send your request. Staff have been notified. Try again.");
  expect(screen.queryByText(/secret backend detail/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Send the robot with the water bottle to Mom's bedside table?")).toBeInTheDocument();
});

test("confirmation cancellation waits for success and reports a translated failure", async () => {
  const api = apiWith((path) => {
    if (path === "/tasks") return { kind: "proposal", task: proposalTask() };
    if (path === "/tasks/t1/cancel") throw new Error("raw cancel failure");
    throw new Error(path);
  });
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "water");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await userEvent.click(await screen.findByRole("button", { name: "No" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't cancel the request. Staff have been notified. Try again.");
  expect(screen.getByText(/Send the robot with/)).toBeInTheDocument();
});

test("policy rejection shows the translated reason and offers another request", async () => {
  const api = apiWith((path) => path === "/tasks" ? { kind: "rejected", task: proposalTask("rejected"), code: "prohibited_item", reason: "raw reason" } : {});
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "medication");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That item can't be delivered by the robot");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByPlaceholderText(/Type what you need/)).toHaveValue("");
});

test("hold-to-talk submits speech only to POST /tasks and stops recognition on release and unmount", async () => {
  const recognitions: any[] = [];
  class Recognition {
    lang = ""; interimResults = true; maxAlternatives = 0; onresult: any; onend: any; onerror: any;
    start = vi.fn(); stop = vi.fn();
    constructor() { recognitions.push(this); }
  }
  vi.stubGlobal("SpeechRecognition", Recognition);
  const api = apiWith((path) => path === "/tasks" ? { kind: "proposal", task: proposalTask() } : {});
  const view = render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  const speak = screen.getByRole("button", { name: "Hold to speak" });
  fireEvent.pointerDown(speak);
  expect(recognitions[0].start).toHaveBeenCalledTimes(1);
  expect(recognitions[0]).toMatchObject({ lang: "en-US", interimResults: false, maxAlternatives: 1 });
  act(() => recognitions[0].onresult({ results: [[{ transcript: "bring water" }]] }));
  fireEvent.pointerUp(speak);
  expect(recognitions[0].stop).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/tasks", { residentId: "r", text: "bring water", visitId: "v1" }));
  expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("bring water"));

  view.rerender(<AskRobot api={apiWith(() => ({}))} apiBase="http://api" token="jwt" residentId="r" visitId="v2" residentName="Mom" />);
  view.unmount();
  expect(recognitions[0].stop).toHaveBeenCalled();
});

test("a task event refreshes tracking to the server's latest state", async () => {
  let resolveRefresh!: (value: unknown) => void;
  const api = {
    post: vi.fn(async (path: string) => path === "/tasks" ? { kind: "proposal", task: proposalTask() } : { task: proposalTask("awaiting_policy_or_staff") }),
    get: vi.fn(() => new Promise((resolve) => { resolveRefresh = resolve; })),
  } as any;
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "water");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await userEvent.click(await screen.findByRole("button", { name: "Yes, send the robot" }));
  expect(await screen.findByText("Care home approval")).toHaveAttribute("aria-current", "step");
  act(() => (sockets.at(-1)!.onmessage as any)({ data: JSON.stringify({ entityId: "t1", type: "task_transition" }) }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/tasks/t1"));
  act(() => resolveRefresh({ task: proposalTask("queued") }));
  expect(await screen.findByText("Robot to the station")).toHaveAttribute("aria-current", "step");
});

test("a tracking refresh failure is translated and explains that staff were notified", async () => {
  const api = {
    post: vi.fn(async (path: string) => path === "/tasks" ? { kind: "proposal", task: proposalTask() } : { task: proposalTask("awaiting_policy_or_staff") }),
    get: vi.fn(async () => { throw new Error("private transport failure"); }),
  } as any;
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "water");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await userEvent.click(await screen.findByRole("button", { name: "Yes, send the robot" }));
  act(() => (sockets.at(-1)!.onmessage as any)({ data: JSON.stringify({ entityId: "t1", type: "task_transition" }) }));
  expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't refresh the robot's progress. Staff have been notified. Trying again.");
  expect(screen.queryByText(/private transport failure/)).toBeNull();
});

test("Speak is hidden when speech recognition is unavailable", () => {
  render(<AskRobot api={apiWith(() => ({}))} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  expect(screen.queryByRole("button", { name: /speak/i })).toBeNull();
});
