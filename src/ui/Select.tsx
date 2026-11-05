import { Select as BaseSelect } from "@base-ui/react/select";
import type { cn } from "tailwind-variants";
import { tv, type VariantProps } from "tailwind-variants";
import type { TwcComponentProps } from "react-twc";
import Check from "~icons/lucide/check";
import ChevronDown from "~icons/lucide/chevron-down";
import { twx } from "./twx";

const triggerVariants = tv({
  base: "inline-flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface text-heading outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
  variants: {
    size: {
      sm: "h-control-sm px-2 text-sm",
      md: "h-control-md px-3 text-sm",
      lg: "h-control-lg px-4 text-base",
    },
  },
  defaultVariants: { size: "md" },
});

type TriggerVariants = VariantProps<typeof triggerVariants>;

const Trigger = twx(BaseSelect.Trigger).transientProps(["size"])<
  TwcComponentProps<typeof BaseSelect.Trigger, typeof cn> & TriggerVariants
>((props) => triggerVariants({ size: props.size }));
const Value = twx(BaseSelect.Value)(() => "truncate data-[placeholder]:text-muted-text");
const Chevron = twx(ChevronDown)(() => "size-4 shrink-0 text-secondary-text");
const Positioner = twx(BaseSelect.Positioner)(() => "z-50 outline-none");
const Popup = twx(BaseSelect.Popup)(
  () =>
    "min-w-(--anchor-width) rounded-md border border-border bg-surface py-1 text-sm text-on-surface outline-none",
);
const List = twx(BaseSelect.List)(() => "max-h-64 overflow-y-auto");
const Item = twx(BaseSelect.Item)(
  () =>
    "flex cursor-default items-center justify-between gap-2 px-3 py-1.5 outline-none data-[highlighted]:bg-hover-fill data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
);
const CheckIcon = twx(Check)(() => "size-4");
const ItemIndicator = twx(BaseSelect.ItemIndicator)(() => "text-primary-ink");

export interface SelectItem {
  value: string;
  label: string;
  disabled?: boolean;
}

type SelectProps = TriggerVariants & {
  items: readonly SelectItem[];
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

export function Select({
  items,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled,
  name,
  size,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps) {
  return (
    // `items` lets Select.Value render the selected label instead of the raw value.
    <BaseSelect.Root
      items={items}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
    >
      <Trigger id={id} size={size} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}>
        <Value placeholder={placeholder} />
        <BaseSelect.Icon>
          <Chevron aria-hidden />
        </BaseSelect.Icon>
      </Trigger>
      <BaseSelect.Portal>
        <Positioner sideOffset={4}>
          <Popup>
            <List>
              {items.map((item) => (
                <Item key={item.value} value={item.value} disabled={item.disabled}>
                  <BaseSelect.ItemText>{item.label}</BaseSelect.ItemText>
                  <ItemIndicator>
                    <CheckIcon aria-hidden />
                  </ItemIndicator>
                </Item>
              ))}
            </List>
          </Popup>
        </Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
