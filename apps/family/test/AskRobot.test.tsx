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
  expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't send your request. Check your connection and try again.");
  expect(screen.getByRole("alert")).not.toHaveTextContent("Staff have been notified");
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
  expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't cancel the request. Check your connection and try again.");
  expect(screen.getByRole("alert")).not.toHaveTextContent("Staff have been notified");
  expect(screen.getByText(/Send the robot with/)).toBeInTheDocument();
});

test("confirmation failure gives truthful translated retry guidance", async () => {
  const api = apiWith((path) => {
    if (path === "/tasks") return { kind: "proposal", task: proposalTask() };
    if (path === "/tasks/t1/confirm") throw new Error("raw confirm failure");
    throw new Error(path);
  });
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "water");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await userEvent.click(await screen.findByRole("button", { name: "Yes, send the robot" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't confirm the request. Check your connection and try again.");
  expect(screen.getByRole("alert")).not.toHaveTextContent("Staff have been notified");
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
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.pointerUp(speak);
  expect(recognitions[0].stop).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/tasks", { residentId: "r", text: "bring water", visitId: "v1" }));
  expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("bring water"));

  view.rerender(<AskRobot api={apiWith(() => ({}))} apiBase="http://api" token="jwt" residentId="r" visitId="v2" residentName="Mom" />);
  view.unmount();
  expect(recognitions[0].stop).toHaveBeenCalled();
});

test("a final speech result after release submits once", async () => {
  let recognition: any;
  class Recognition {
    lang = ""; interimResults = true; maxAlternatives = 0; onresult: any; onend: any; onerror: any;
    start = vi.fn(); stop = vi.fn();
    constructor() { recognition = this; }
  }
  vi.stubGlobal("SpeechRecognition", Recognition);
  const api = apiWith((path) => path === "/tasks" ? { kind: "proposal", task: proposalTask() } : {});
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  const speak = screen.getByRole("button", { name: "Hold to speak" });
  fireEvent.pointerDown(speak);
  fireEvent.pointerUp(speak);
  act(() => recognition.onresult({ results: [[{ transcript: "bring tissues" }]] }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/tasks", { residentId: "r", text: "bring tissues", visitId: "v1" }));
  expect(api.post).toHaveBeenCalledTimes(1);
});

test("a transcript that ends while held waits for release before submitting", async () => {
  let recognition: any;
  class Recognition {
    lang = ""; interimResults = true; maxAlternatives = 0; onresult: any; onend: any; onerror: any;
    start = vi.fn(); stop = vi.fn();
    constructor() { recognition = this; }
  }
  vi.stubGlobal("SpeechRecognition", Recognition);
  const api = apiWith((path) => path === "/tasks" ? { kind: "proposal", task: proposalTask() } : {});
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  const speak = screen.getByRole("button", { name: "Hold to speak" });
  fireEvent.pointerDown(speak);
  act(() => {
    recognition.onresult({ results: [[{ transcript: "bring tissues" }]] });
    recognition.onend();
  });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.pointerUp(speak);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/tasks", { residentId: "r", text: "bring tissues", visitId: "v1" }));
});

test("a final speech result after unmount cannot submit a request", () => {
  let recognition: any;
  class Recognition {
    lang = ""; interimResults = true; maxAlternatives = 0; onresult: any; onend: any; onerror: any;
    start = vi.fn(); stop = vi.fn();
    constructor() { recognition = this; }
  }
  vi.stubGlobal("SpeechRecognition", Recognition);
  const api = apiWith(() => ({ kind: "proposal", task: proposalTask() }));
  const view = render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Hold to speak" }));
  view.unmount();
  act(() => recognition.onresult({ results: [[{ transcript: "bring water" }]] }));
  expect(api.post).not.toHaveBeenCalled();
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

test("a tracking refresh failure gives truthful translated retry guidance", async () => {
  const api = {
    post: vi.fn(async (path: string) => path === "/tasks" ? { kind: "proposal", task: proposalTask() } : { task: proposalTask("awaiting_policy_or_staff") }),
    get: vi.fn(async () => { throw new Error("private transport failure"); }),
  } as any;
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "water");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await userEvent.click(await screen.findByRole("button", { name: "Yes, send the robot" }));
  act(() => (sockets.at(-1)!.onmessage as any)({ data: JSON.stringify({ entityId: "t1", type: "task_transition" }) }));
  expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't refresh the robot's progress. Check your connection; we'll keep trying.");
  expect(screen.getByRole("alert")).not.toHaveTextContent("Staff have been notified");
  expect(screen.queryByText(/private transport failure/)).toBeNull();
});

test("Speak is hidden when speech recognition is unavailable", () => {
  render(<AskRobot api={apiWith(() => ({}))} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  expect(screen.queryByRole("button", { name: /speak/i })).toBeNull();
});

test.each(["completed", "safety_stopped", "navigation_failed"])("slow progress responses survive polls/events and reveal terminal %s", async (state) => {
  vi.useFakeTimers();
  const waiting: Array<(value: unknown) => void> = [];
  const api = apiWith(path => path === "/tasks" ? { kind: "proposal", task: proposalTask() }
    : path.endsWith("/confirm") ? { task: proposalTask("awaiting_policy_or_staff") }
    : new Promise(resolve => waiting.push(resolve)));
  const view = render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  fireEvent.change(screen.getByPlaceholderText(/Type what you need/), { target: { value: "water" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Yes, send the robot" })));
  const event = () => (sockets.at(-1)!.onmessage as any)({ data: '{"entityId":"t1"}' });
  act(event);
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); event(); event(); });
  await act(async () => waiting[0]!({ task: proposalTask("navigating_to_delivery") }));
  expect(screen.getByText("On the way to Mom")).toHaveAttribute("aria-current", "step");
  expect(waiting).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); event(); });
  await act(async () => waiting[1]!({ task: proposalTask(state) }));
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  if (state === "completed") expect(screen.getByText("Done")).toHaveAttribute("aria-current", "step");
  else expect(screen.getByText(state === "safety_stopped" ? /stopped for safety/ : /could not reach/)).toBeInTheDocument();
  const count = waiting.length;
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); event(); });
  expect(waiting).toHaveLength(count);
});

test("late progress cannot enter a new visit session", async () => {
  let finish!: (value: unknown) => void;
  const api = apiWith(path => path === "/tasks" ? { kind: "proposal", task: proposalTask() }
    : path.endsWith("/confirm") ? { task: proposalTask("awaiting_policy_or_staff") }
    : new Promise(resolve => { finish = resolve; }));
  const view = render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "water");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await userEvent.click(await screen.findByRole("button", { name: "Yes, send the robot" }));
  act(() => (sockets.at(-1)!.onmessage as any)({ data: '{"entityId":"t1"}' }));
  view.rerender(<AskRobot api={api} apiBase="http://api" token="new-jwt" residentId="other" visitId="v2" residentName="Dad" />);
  await act(async () => finish({ task: proposalTask("completed") }));
  expect(screen.queryByText("Done")).toBeNull();
  expect(screen.getByPlaceholderText(/Type what you need/)).toHaveValue("");
});

test("cancelling a pending clarification choice releases busy and ignores its late proposal", async () => {
  let finish!: (value: unknown) => void;
  const api = apiWith((_path, body: any) => body.text === "something"
    ? { kind: "clarification", options: ["water_bottle"] }
    : body.text === "water bottle" ? new Promise(resolve => { finish = resolve; })
    : { kind: "proposal", task: { ...proposalTask(), proposal: { ...proposalTask().proposal, item: "tissue_box" } } });
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "something");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await userEvent.click(await screen.findByRole("button", { name: "water bottle" }));
  await userEvent.click(screen.getByRole("button", { name: "No" }));
  await act(async () => finish({ kind: "proposal", task: proposalTask() }));
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  await userEvent.clear(screen.getByPlaceholderText(/Type what you need/));
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "tissues");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Send the robot with the tissue box to Mom's bedside table?")).toBeInTheDocument();
});
