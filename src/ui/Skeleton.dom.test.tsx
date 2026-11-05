import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Skeleton } from "./Skeleton";

it("renders the requested number of pulsing lines, motion-safe", () => {
  render(<Skeleton lines={4} />);
  const root = screen.getByRole("status");
  expect(root).toHaveAttribute("aria-busy", "true");
  const lines = root.querySelectorAll("[data-skeleton-line]");
  expect(lines).toHaveLength(4);
  lines.forEach((l) => {
    expect(l).toHaveClass("motion-safe:animate-pulse", "bg-border", "rounded-sm");
    expect(l).toHaveAttribute("aria-hidden", "true");
  });
  expect(root.outerHTML).not.toMatch(/lines=/);
});

it("defaults to three lines", () => {
  const { container } = render(<Skeleton />);
  expect(container.querySelectorAll("[data-skeleton-line]")).toHaveLength(3);
});
