import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Alert } from "./Alert";
import { Button } from "./Button";

it("danger uses role=alert, tone classes, title and body", () => {
  render(
    <Alert tone="danger" title="Failed">
      Could not save
    </Alert>,
  );
  const el = screen.getByRole("alert");
  expect(el).toHaveClass(
    "bg-danger-soft",
    "border-danger-border",
    "text-on-danger-soft",
    "rounded-lg",
  );
  expect(el).toHaveTextContent("Failed");
  expect(el).toHaveTextContent("Could not save");
  expect(el.outerHTML).not.toMatch(/tone=/);
});

it("warning uses role=alert; info and success use role=status", () => {
  const { rerender } = render(<Alert tone="warning" title="w" />);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  rerender(<Alert tone="info" title="i" />);
  expect(screen.getByRole("status")).toBeInTheDocument();
  rerender(<Alert tone="success" title="s" />);
  expect(screen.getByRole("status")).toHaveClass(
    "bg-success-soft",
    "border-success-border",
    "text-on-success-soft",
  );
});

it("defaults to info", () => {
  render(<Alert title="hi" />);
  expect(screen.getByRole("status")).toHaveClass(
    "bg-info-soft",
    "border-info-border",
    "text-on-info-soft",
  );
});

it("renders an action slot that is interactive", async () => {
  const onClick = vi.fn();
  render(<Alert title="t" action={<Button onClick={onClick}>Retry</Button>} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("keeps the default icon decorative and allows hiding it", () => {
  const { container, rerender } = render(<Alert title="t" />);
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  rerender(<Alert title="t" icon={null} />);
  expect(container.querySelector("svg")).toBeNull();
});

it("pins the default icon classes and leaves caller icons untouched", () => {
  const { container, rerender } = render(<Alert title="t" />);
  expect(container.querySelector("svg")).toHaveClass("mt-0.5", "size-4", "shrink-0");
  rerender(<Alert title="t" icon={<i data-testid="mine" />} />);
  expect(container.querySelector("svg")).toBeNull();
  expect(screen.getByTestId("mine")).toBeInTheDocument();
});
