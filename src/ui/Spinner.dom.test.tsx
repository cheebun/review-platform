import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { Spinner } from "./Spinner";

it("renders an animated icon hidden under reduced motion paired with a static one", () => {
  const { container } = render(<Spinner />);
  const svgs = container.querySelectorAll("svg");
  expect(svgs).toHaveLength(2);
  expect(svgs[0]).toHaveClass("motion-reduce:hidden");
  expect(svgs[1]).toHaveClass("motion-safe:hidden");
  svgs.forEach((svg) => expect(svg).toHaveAttribute("aria-hidden", "true"));
});
