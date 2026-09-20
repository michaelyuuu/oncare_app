import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Home } from "../src/screens/Home";

afterEach(cleanup);

test("the resident default is the communication-first home with preserved meeting actions", () => {
  const onAssistant = vi.fn();
  const onCaregiver = vi.fn();
  const onHelp = vi.fn();
  render(<Home name="Demo Resident" now={0} onOpenAssistant={onAssistant} onCallCaregiver={onCaregiver} onHelpStaff={onHelp} />);

  expect(screen.getByRole("status")).toHaveTextContent("Tap anywhere to talk");
  expect(screen.getByTestId("communication-orb")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Talk to Ontaru" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "I need help" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Call a caregiver" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Talk to Ontaru" }));
  fireEvent.click(screen.getByRole("button", { name: "I need help" }));
  fireEvent.click(screen.getByRole("button", { name: "Call a caregiver" }));
  expect(onAssistant).toHaveBeenCalledTimes(1);
  expect(onHelp).toHaveBeenCalledTimes(1);
  expect(onCaregiver).toHaveBeenCalledTimes(1);
});
