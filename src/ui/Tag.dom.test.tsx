import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Tag } from "./Tag";

it("renders tone classes and hides tone from the DOM", () => {
  render(<Tag tone="success">Merged</Tag>);
  const el = screen.getByText("Merged");
  expect(el).toHaveClass(
    "bg-success-soft",
    "border-success-border",
    "text-on-success-soft",
    "rounded-full",
  );
  expect(el.outerHTML).not.toMatch(/tone=/);
});

it("neutral tag is primary-soft / primary-ink", () => {
  render(<Tag>P2</Tag>);
  expect(screen.getByText("P2")).toHaveClass("bg-primary-soft", "text-primary-ink", "rounded-full");
});

it("closable renders an accessible close button that calls onClose", async () => {
  const onClose = vi.fn();
  render(
    <Tag closable closeLabel="Remove tag" onClose={onClose}>
      main
    </Tag>,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Remove tag" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("is not closable by default", () => {
  render(<Tag>x</Tag>);
  expect(screen.queryByRole("button")).toBeNull();
});
