import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

function Harness({
  dismissible,
  onOpenChange,
}: {
  dismissible?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          setOpen(next);
        }}
        title="Confirm"
        description="Are you sure?"
        dismissible={dismissible}
        footer={<button type="button">Do it</button>}
      >
        <p>body text</p>
      </Dialog>
    </>
  );
}

it("opens with title, description, body and footer wired for a11y", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm" });
  expect(dialog).toHaveAccessibleDescription("Are you sure?");
  expect(dialog).toHaveClass("rounded-lg", "bg-surface", "border-border");
  expect(dialog.className).not.toMatch(/shadow/);
  expect(dialog).toHaveTextContent("body text");
  expect(screen.getByRole("button", { name: "Do it" })).toBeInTheDocument();
});

it("Escape closes and focus returns to the opener", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open" });
  await user.click(opener);
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(opener).toHaveFocus());
});

it("moves focus into the dialog and keeps it off the inert page behind", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  // jsdom does not emulate Base UI's focus-guard redirect, so only assert the page behind
  // is inert and never receives focus.
  for (let i = 0; i < 5; i++) {
    await user.tab();
    expect(opener).not.toHaveFocus();
  }
  expect(opener.closest("[aria-hidden='true']")).not.toBeNull();
});

it("the close button closes a dismissible dialog", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("dismissible={false} ignores Escape and has no close button", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(<Harness dismissible={false} onOpenChange={onOpenChange} />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});
