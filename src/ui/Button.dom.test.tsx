import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Button } from "./Button";

it("renders primary/md by default and keeps styling props out of the DOM", () => {
  render(<Button>Save</Button>);
  const btn = screen.getByRole("button", { name: "Save" });
  expect(btn).toHaveClass(
    "bg-primary",
    "text-on-primary",
    "rounded-md",
    "h-control-md",
    "focus-visible:ring-primary",
  );
  expect(btn.className).not.toMatch(/shadow/);
  expect(btn).toHaveAttribute("type", "button");
  expect(btn.outerHTML).not.toMatch(/variant=|size=|icononly=|loading=/i);
});

it("renders danger/sm variants", () => {
  render(
    <Button variant="danger" size="sm">
      Delete
    </Button>,
  );
  expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
    "bg-danger",
    "text-on-danger",
    "h-control-sm",
  );
});

it("lets a caller class override a variant class", () => {
  render(<Button className="bg-heading">Ok</Button>);
  const btn = screen.getByRole("button", { name: "Ok" });
  expect(btn).toHaveClass("bg-heading");
  expect(btn).not.toHaveClass("bg-primary");
});

it("secondary uses the page fill, a hairline and hover-fill", () => {
  render(<Button variant="secondary">Cancel</Button>);
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass(
    "bg-background",
    "border-border",
    "text-heading",
    "hover:bg-hover-fill",
  );
});

it("allows type=submit to override the default", () => {
  render(<Button type="submit">Go</Button>);
  expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "submit");
});

it("loading sets aria-busy, disables the button and blocks clicks", async () => {
  const onClick = vi.fn();
  const { container } = render(
    <Button loading onClick={onClick}>
      Run
    </Button>,
  );
  const btn = screen.getByRole("button", { name: "Run" });
  expect(btn).toHaveAttribute("aria-busy", "true");
  expect(btn).toBeDisabled();
  expect(container.querySelectorAll("svg").length).toBe(2);
  await userEvent.setup().click(btn);
  expect(onClick).not.toHaveBeenCalled();
});

it("is not busy when idle, and honours disabled", () => {
  render(<Button disabled>Idle</Button>);
  const btn = screen.getByRole("button", { name: "Idle" });
  expect(btn).not.toHaveAttribute("aria-busy");
  expect(btn).toBeDisabled();
});

it("icon-only mode is named by aria-label and is square", () => {
  render(<Button iconOnly aria-label="Copy" size="sm" />);
  expect(screen.getByRole("button", { name: "Copy" })).toHaveClass("w-control-sm");
});

// Compile-time assertion only; never rendered.
export const iconOnlyNeedsLabel = () => (
  // @ts-expect-error iconOnly without aria-label must not compile
  <Button iconOnly />
);

it("requires aria-label for icon-only buttons at the type level", () => {
  expect(iconOnlyNeedsLabel).toBeTypeOf("function");
});
