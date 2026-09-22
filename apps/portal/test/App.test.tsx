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

  expect(screen.queryByText(/username|password|token|facility|identity/i)).toBeNull();
  expect(container.querySelector("input, select, textarea")).toBeNull();
});
