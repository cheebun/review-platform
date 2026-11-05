import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { FormError, Input } from "./form";

it("Input is a surface control with hairline, md radius and muted placeholder", () => {
  render(<Input aria-label="name" />);
  expect(screen.getByLabelText("name")).toHaveClass(
    "bg-surface",
    "border-border",
    "rounded-md",
    "text-heading",
    "placeholder:text-muted-text",
    "focus-visible:ring-primary",
  );
});

it("FormError uses the on-danger-soft helper colour", () => {
  render(<FormError>bad</FormError>);
  expect(screen.getByRole("alert")).toHaveClass("text-on-danger-soft");
});
