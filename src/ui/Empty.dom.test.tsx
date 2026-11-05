import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Empty } from "./Empty";

it("renders its description with a decorative icon", () => {
  const { container } = render(<Empty description="Nothing here" />);
  expect(screen.getByText("Nothing here")).toBeInTheDocument();
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

it("accepts children as an action", () => {
  render(
    <Empty description="None">
      <button type="button">Add</button>
    </Empty>,
  );
  expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
});

it("pins the description and icon classes", () => {
  const { container } = render(<Empty description="Nothing here" />);
  expect(screen.getByText("Nothing here")).toHaveClass("text-sm");
  expect(container.querySelector("svg")).toHaveClass("size-8", "text-muted-text");
});
