import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { InputGroup, Stack } from "./Stack";

it("Stack defaults to a vertical flex column and hides styling props", () => {
  render(<Stack data-testid="s">x</Stack>);
  const el = screen.getByTestId("s");
  expect(el).toHaveClass("flex", "flex-col");
  expect(el.outerHTML).not.toMatch(/direction=|gap=|wrap=/);
});

it("Stack supports row, gap and wrap", () => {
  render(
    <Stack data-testid="s" direction="row" gap={4} wrap>
      x
    </Stack>,
  );
  expect(screen.getByTestId("s")).toHaveClass("flex-row", "gap-4", "flex-wrap");
});

it("InputGroup is an accessible group of joined controls", () => {
  render(
    <InputGroup aria-label="Search">
      <input aria-label="q" />
      <button type="button">Go</button>
    </InputGroup>,
  );
  expect(screen.getByRole("group", { name: "Search" })).toBeInTheDocument();
});
