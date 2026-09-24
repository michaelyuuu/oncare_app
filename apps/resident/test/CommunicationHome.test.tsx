import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Home } from "../src/screens/Home";

afterEach(cleanup);

test("the resident default is the communication-first home with preserved meeting actions", () => {
  const onAssistant = vi.fn();
  const onSchedule = vi.fn();
  const onCallNow = vi.fn();
  const onHelp = vi.fn();
  render(<Home
    name="Demo Resident"
    now={0}
    contacts={[{ userId: "family-1", displayName: "Amy", label: "daughter" }]}
    selectedContactId={null}
    onSelectContact={vi.fn()}
    onOpenAssistant={onAssistant}
    onScheduleVisit={onSchedule}
    onCallNow={onCallNow}
    onHelpStaff={onHelp}
  />);

  expect(screen.getByRole("status")).toHaveTextContent("Tap anywhere to talk");
  expect(screen.getByTestId("communication-orb")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Talk to Ontaru" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Schedule a visit" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Call now" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "I need help" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Call a caregiver" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Talk to Ontaru" }));
  fireEvent.click(screen.getByRole("button", { name: "I need help" }));
  expect(onAssistant).toHaveBeenCalledTimes(1);
  expect(onHelp).toHaveBeenCalledTimes(1);
});

test("schedule and immediate call require one selected approved contact", () => {
  const onSchedule = vi.fn();
  const onCallNow = vi.fn();
  function Harness() {
    const [selected, setSelected] = React.useState<string | null>(null);
    return <Home
      name="Demo Resident"
      now={0}
      contacts={[
        { userId: "family-1", displayName: "Amy", label: "daughter" },
        { userId: "family-2", displayName: "Ben", label: "son" },
      ]}
      selectedContactId={selected}
      onSelectContact={setSelected}
      onScheduleVisit={onSchedule}
      onCallNow={onCallNow}
      onHelpStaff={vi.fn()}
    />;
  }
  render(<Harness />);

  fireEvent.click(screen.getByRole("radio", { name: /Amy/ }));
  expect(screen.getByRole("radio", { name: /Amy/ })).toBeChecked();
  expect(screen.getByRole("button", { name: "Schedule a visit" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Call now" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Schedule a visit" }));
  fireEvent.click(screen.getByRole("button", { name: "Call now" }));

  expect(onSchedule).toHaveBeenCalledTimes(1);
  expect(onCallNow).toHaveBeenCalledTimes(1);
});
