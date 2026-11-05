import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { Select } from "./Select";

const items = [
  { value: "apple", label: "Apple" },
  { value: "pear", label: "Pear" },
  { value: "fig", label: "Fig", disabled: true },
];

function Harness({ onChange }: { onChange?: (v: string | null) => void }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <Select
      aria-label="Fruit"
      items={items}
      value={value}
      placeholder="Pick one"
      onValueChange={(v) => {
        onChange?.(v);
        setValue(v);
      }}
    />
  );
}

it("shows the placeholder, then the selected label (not the raw value)", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const trigger = screen.getByRole("combobox", { name: "Fruit" });
  expect(trigger).toHaveTextContent("Pick one");
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: "Pear" }));
  await waitFor(() => expect(trigger).toHaveTextContent("Pear"));
});

it("opens with the keyboard and picks an option", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  await user.tab();
  expect(screen.getByRole("combobox", { name: "Fruit" })).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("listbox");
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  expect(onChange.mock.calls[0]?.[0]).toMatch(/^(apple|pear)$/);
});

it("disabled blocks opening", async () => {
  const user = userEvent.setup();
  render(<Select aria-label="Fruit" items={items} disabled />);
  const trigger = screen.getByRole("combobox", { name: "Fruit" });
  await user.click(trigger);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(trigger).toBeDisabled();
});

it("applies size classes and keeps size out of the DOM", () => {
  render(<Select aria-label="Fruit" items={items} size="sm" />);
  const trigger = screen.getByRole("combobox", { name: "Fruit" });
  expect(trigger).toHaveClass("h-control-sm", "rounded-md", "bg-surface", "border-border");
  expect(trigger.outerHTML).not.toMatch(/ size=/);
});
