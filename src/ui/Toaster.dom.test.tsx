import { act, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Toaster, notify } from "./Toaster";

it.each([
  ["success", "Saved"],
  ["error", "Failed"],
  ["warning", "Careful"],
] as const)("notify.%s shows the caller-supplied text", async (kind, text) => {
  render(<Toaster />);
  act(() => {
    notify[kind](text);
  });
  expect(await screen.findByText(text)).toBeInTheDocument();
});

it("toast chrome uses md radius, surface fill and a hairline", async () => {
  const { container } = render(<Toaster />);
  act(() => {
    notify.success("Chrome");
  });
  const el = (await screen.findByText("Chrome")).closest("li");
  expect(el, container.innerHTML).not.toBeNull();
  expect(el).toHaveClass("rounded-md", "bg-surface", "border-border");
});
