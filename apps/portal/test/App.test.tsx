import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "../src/App";

afterEach(cleanup);

test("routes each role to its application without collecting identity data", () => {
  const { container } = render(<App urls={{ resident: "http://r", family: "http://f", staff: "http://s" }} />);

  expect(screen.getByRole("link", { name: "Resident" })).toHaveAttribute("href", "http://r");
  expect(screen.getByRole("link", { name: "Family" })).toHaveAttribute("href", "http://f");
  expect(screen.getByRole("link", { name: "Staff" })).toHaveAttribute("href", "http://s");
  expect(screen.getByRole("link", { name: "Manager" })).toHaveAttribute("href", "http://s?mode=manager");
  expect(screen.queryByText("SIMULATED")).toBeNull();

  expect(screen.queryByText(/username|password|token|facility|identity/i)).toBeNull();
  expect(container.querySelector("input, select, textarea")).toBeNull();
});

test("labels explicitly configured demo portals without changing role destinations", () => {
  render(<App demo urls={{ resident: "http://r", family: "http://f", staff: "http://s" }} />);

  expect(screen.getByText("SIMULATED")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Resident" })).toHaveAttribute("href", "http://r");
  expect(screen.getByRole("link", { name: "Family" })).toHaveAttribute("href", "http://f");
  expect(screen.getByRole("link", { name: "Staff" })).toHaveAttribute("href", "http://s");
  expect(screen.getByRole("link", { name: "Manager" })).toHaveAttribute("href", "http://s?mode=manager");
});

test.each([
  [
    "existing query parameters",
    "https://staff.example/sign-in?lang=en",
    "https://staff.example/sign-in?lang=en&mode=manager",
  ],
  [
    "a fragment",
    "https://staff.example/sign-in#credentials",
    "https://staff.example/sign-in?mode=manager#credentials",
  ],
])("adds the manager hint while preserving %s", (_case, staff, expected) => {
  render(<App urls={{ resident: "http://r", family: "http://f", staff }} />);

  expect(screen.getByRole("link", { name: "Manager" })).toHaveAttribute("href", expected);
});
