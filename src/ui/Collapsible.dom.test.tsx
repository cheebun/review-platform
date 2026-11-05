import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Collapsible } from "./Collapsible";

it("starts closed and toggles with Enter and Space", async () => {
  const user = userEvent.setup();
  render(
    <Collapsible title="Details">
      <p>inner</p>
    </Collapsible>,
  );
  const trigger = screen.getByRole("button", { name: "Details" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("inner")).toBeNull();
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await screen.findByText("inner")).toBeInTheDocument();
  await user.keyboard(" ");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

it("respects defaultOpen", () => {
  render(
    <Collapsible title="Details" defaultOpen>
      <p>inner</p>
    </Collapsible>,
  );
  expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("inner")).toBeInTheDocument();
});
