import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";

it("Dialog opens from its trigger and closes with Escape", async () => {
  const user = userEvent.setup();
  render(
    <Dialog.Root>
      <Dialog.Trigger>Open</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup>
          <Dialog.Title>Hello</Dialog.Title>
          <Dialog.Description>Body</Dialog.Description>
          <Dialog.Close>Close</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open" }));
  expect(await screen.findByRole("dialog", { name: "Hello" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

const fruits = [
  { value: "apple", label: "Apple" },
  { value: "pear", label: "Pear" },
];

function Fruit() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <Select.Root items={fruits} value={value} onValueChange={setValue}>
        <Select.Trigger aria-label="Fruit">
          <Select.Value placeholder="Pick" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner>
            <Select.Popup>
              <Select.List>
                <Select.Item value="apple">
                  <Select.ItemText>Apple</Select.ItemText>
                </Select.Item>
                <Select.Item value="pear">
                  <Select.ItemText>Pear</Select.ItemText>
                </Select.Item>
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      <output data-testid="value">{value ?? "none"}</output>
    </>
  );
}

it("Select opens and picks an option", async () => {
  const user = userEvent.setup();
  render(<Fruit />);
  await user.click(screen.getByRole("combobox", { name: "Fruit" }));
  await user.click(await screen.findByRole("option", { name: "Pear" }));
  await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("pear"));
  expect(screen.getByRole("combobox", { name: "Fruit" })).toHaveTextContent("Pear");
});
