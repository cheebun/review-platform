# Styling

Styling rules for this app.

**Scope.** All UI code under `src/`. The stack is Tailwind CSS v4 + `react-twc` + `tailwind-variants` + Base UI, with icons compiled from Iconify sets by `unplugin-icons`. antd is not used; do not reintroduce it or any other component library that ships its own styling.

Shared primitives (`twx`, `Icon`, `Button`, `Spinner`, `Dialog`, `Select`, ...) live in `src/ui/`. Feature code imports them from `@/ui` and does not restyle them by reaching into their internals.

---

## 0. Design tokens live in `@theme`

[DESIGN.md](../DESIGN.md) is the normative source for colours, typography, radii and spacing. `src/styles/app.css` implements it as Tailwind v4 `@theme` tokens, and `src/styles/tokens.test.ts` checks the CSS against DESIGN.md (values, dark overrides, and WCAG contrast). Change DESIGN.md first, then the CSS.

Components use the generated utilities (`bg-surface`, `text-heading`, `border-border`, `rounded-md`, `text-label-md`, ...). They never hard-code hex values or read CSS variables through inline `style`. A new colour is a new DESIGN.md token, never a one-off arbitrary value such as `bg-[#123456]`.

| DESIGN.md group                  | CSS variable                                                              | Utility example                    |
| -------------------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| `colors.<name>`                  | `--color-<name>`                                                          | `bg-primary`, `text-heading`       |
| `colors.<name>-dark`             | overrides `--color-<name>` under `:root.dark` and `prefers-color-scheme`  | automatic, no `dark:` needed       |
| `rounded.<name>`                 | `--radius-<name>`                                                         | `rounded-md`                       |
| `spacing.<name>` (except `unit`) | `--spacing-<name>`                                                        | `h-control-md`, `p-card-padding-x` |
| `typography.<name>`              | `--text-<name>` plus `--line-height`, `--font-weight`, `--letter-spacing` | `text-label-md`                    |
| `typography.*.fontFamily`        | `--font-sans`, `--font-mono`                                              | `font-sans`, `font-mono`           |
| `typography.*.fontFeature`       | `font-feature-settings` on `html`, once                                   | none                               |

The dark selector is `:root.dark`, or `@media (prefers-color-scheme: dark)` on `:root:not(.light)`. The `dark:` variant follows the same rule (`@custom-variant dark`).

The `@google/design.md` `css-tailwind` exporter is not used verbatim. It emits a `--font-<name>` and a `--font-weight-<name>` variable for every typography token, which creates conflicting `font-<name>` utilities, and it drops `fontFeature`. See DESIGN.md, Typography ("In code").

---

## 1. `twx` IS `react-twc`

`src/ui/twx.ts` is the configured instance used by every component:

```ts
import { createTwc } from "react-twc";
import { cn } from "tailwind-variants";

export const twx = createTwc({ compose: cn });
```

`twx` and `twc` are not alternatives, and `twx` is not a wrapper that hides anything. The whole `twc` API is available on it: `.attrs`, `.transientProps`, template or function form, and component targets.

Always import `twx`. The unconfigured `twc` has no `compose`, so a later class cannot override an earlier one. Both classes end up in the DOM, and which one wins depends on the order Tailwind emits them in, not on the call site.

**`cn` comes from `tailwind-variants` and is imported directly from there at each call site.** `twx.ts` does not re-export it. `tailwind-variants` is already a dependency for `tv()`. Its `cn` joins its arguments and runs tailwind-merge over the result, so `clsx` and a hand-written `twMerge(clsx(...))` are not needed.

Use `cn`, not `cnMerge`. `cnMerge` is the curried form that accepts a twMerge config, and this app uses the default configuration.

> **Guard test.** `src/ui/twx.test.tsx` asserts that a `twx(() => 'w-5')` component given `className="w-6"` renders `class="w-6"` only. The test exists because the whole scheme depends on `cn` actually merging. A `tailwind-variants` release that stops bundling or requiring `tailwind-merge` would make `compose` silently degrade to string concatenation. If this test fails after a dependency upgrade, stop and fix the merge before changing any component.

### Bad → Good

```ts
// ❌ no compose — `w-5` and `w-6` both reach the DOM, and which wins depends on stylesheet order
import { twc } from "react-twc";
const Box = twc.div`w-5`;

// ❌ hand-rolled compose: two extra dependencies and a duplicate of a function
//    `tailwind-variants` already exports
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
export const cn = (...inputs) => twMerge(clsx(inputs));

// ✅ one dependency, already present for `tv()`
import { twx } from "@/ui/twx";
const Box = twx("div")(() => "w-5");
```

---

## 2. Always use the function form

`twx` accepts either a tagged template or a function. **Always use the function**, even when the classes are static and the parameter is unused.

Every `twx` component in the app then has the same shape. Adding a prop-dependent class later is an edit inside the function body, not a change of call form. A reader also never has to work out which of two spellings a component uses before editing it. The cost is one `() =>`.

### Bad → Good

```tsx
// ❌ a second spelling for the same thing — and once it needs a prop, the call form itself
//    has to change, so a one-class diff looks like a rewrite
const TextInput = twx("input").attrs({ type: "text" })<TextInputProps>`${inputBoxClassName}`;

// ✅ one form, whether or not the parameter is used
const TextInput = twx("input").attrs({ type: "text" })<TextInputProps>(() => inputBoxClassName);

// ✅ same form once a prop is read
const StyledButton = twx("button").transientProps(["variant", "size"])<ButtonProps>((props) =>
  buttonVariants(props),
);
```

---

## 3. `tv()` and `twx` are layers, not a choice

`tv()` computes a class string. `twx` turns a class string into a component. Use both: `tv()` owns the variant logic and `twx` owns the element. `src/ui/Button.tsx` is the reference implementation.

### Bad → Good

```tsx
// ❌ className passed by hand at every usage — nothing owns the appearance, and any
//    call site can leave part of it out
const numericArrow = tv({ base: "h-6 w-6 rounded border" });
<NumberField.Increment className={numericArrow()} />;

// ✅ one component owns the appearance; call sites pass only what differs
const StyledIncrement = twx(NumberField.Increment)(() => numericArrow());
<StyledIncrement aria-label="Increase" />;
```

Any element that carries classes should be a `twx` component. Do not leave one element in a file building `className` by hand while the elements around it are `twx` components. That element silently loses the `compose` behaviour the others have.

### `cn` is a type import, not a runtime one

**Feature and UI code contains no runtime `cn()` calls.** Every import of `cn` is in **type** position. It is the `TCompose` argument that tells `TwcComponentProps` what `className` accepts:

```ts
type StyledButtonProps = Omit<TwcComponentProps<"button", typeof cn>, "type"> & ButtonVariants;
```

This follows from the rule above. If every element that carries classes is a `twx` component, `twx` has already composed the classes, and a hand-written `cn()` has nothing left to do.

A `cn` call means something should have been a `twx` component:

### Bad → Good

```tsx
// ❌ a plain component that merges its class into a forwarded className by hand. It also
//    has to pull `className` out of props and order the spread correctly so its own
//    class is not overwritten.
export function ChevronRightIcon({ className, ...props }: IconProps) {
  return <ChevronUp className={cn("rotate-90", className)} {...props} />;
}

// ✅ compose handles the merge, the spread order and the forwarding
export const ChevronRightIcon = twx(ChevronUp)(() => "rotate-90");
```

A runtime `cn()` is justified only where a `twx` component is impossible and an incoming `className` still has to be merged. Add a comment explaining why at that call site.

---

## 4. Derive variant prop types with `VariantProps`

Never hand-write the union of a variant's options. `VariantProps<typeof x>` reads them from the `tv()` config, so the config stays the only place they are defined:

```ts
const buttonVariants = tv({
  base: "...",
  variants: {
    variant: { primary: "...", secondary: "...", ghost: "..." },
    size: { sm: "...", md: "...", lg: "..." },
  },
});

type ButtonVariants = VariantProps<typeof buttonVariants>;
// variant?: 'primary' | 'secondary' | 'ghost'
// size?: 'sm' | 'md' | 'lg'

type StyledButtonProps = Omit<TwcComponentProps<"button", typeof cn>, "type"> & ButtonVariants;
```

**The list passed to `.transientProps` is not derived from anything, and nothing checks it against the `tv()` config.** It is a hand-maintained array of strings. A variant added to `tv()` but not added here still type-checks, and it renders silently as a DOM attribute. Reviewers check this list on every change to a `tv()` config.

### Bad → Good

```ts
// ❌ options written twice — the union and the tv() config drift apart as soon as one is edited
type ButtonVariants = { variant?: 'primary' | 'secondary' | 'ghost' };

// ✅ one definition; the type follows the config
type ButtonVariants = VariantProps<typeof buttonVariants>;

// ❌ a new `tone` variant in tv() that was not added here — it type-checks, and ships
//    as tone="danger" on the <button>
twx('button').transientProps(['variant', 'size'])<StyledButtonProps>(...)

// ✅ every key of the tv() variants object is listed
twx('button').transientProps(['variant', 'size', 'tone'])<StyledButtonProps>(...)
```

---

## 5. `twx` wraps third-party components

`twx` accepts any `React.ElementType`, so Base UI parts wrap in exactly the same way as a DOM tag.

Some components accept a **state callback** as `className`, for example Base UI (`className?: string | ((state: State) => string | undefined)`). To style such a component based on its state, return the callback from the `twx` function:

```tsx
const StyledItem = twx(Select.Item)(
  () => (state) => (state.highlighted ? itemHighlighted() : item()),
);
```

Use this only when CSS cannot already express the state. Prefer data-attribute and pseudo-class variants (`data-[highlighted]:bg-accent-soft`, `disabled:opacity-40`). Routing them through JavaScript duplicates what CSS already does.

---

## 6. `.transientProps` for styling props

A prop that exists only to choose an appearance must not reach the DOM. If it does, React warns about an unknown attribute and the value leaks into the markup.

### Bad → Good

```tsx
// ❌ `primary` is forwarded to the <button>, producing `primary="true"` in the DOM
const Button = twx("button")<ButtonProps>((props) => (props.primary ? "bg-accent" : "bg-panel"));

// ✅ declared transient, so it reaches the class function and nothing else
const Button = twx("button").transientProps(["primary"])<ButtonProps>((props) =>
  props.primary ? "bg-accent" : "bg-panel",
);
```

---

## 7. `.attrs` for fixed attributes — after checking the target

`.attrs` sets an attribute that every instance needs. For example, `src/ui/Button.tsx` uses `.attrs({ type: 'button' })` so that an icon button inside a form cannot submit it.

Before adding `.attrs` to a wrapped third-party component, read that component's source and confirm it does not already set the attribute. Base UI's `useButton`, for example, already emits `type: 'button'`. Setting it again adds noise and suggests a problem that does not exist.

---

## 8. Icons

Icons are compiled at build time by `unplugin-icons` from `@iconify-json/*` data and imported as React components:

```tsx
import Copy from "~icons/lucide/copy";
```

Each import becomes inline SVG in the bundle. This means no network fetch, no flash during SSR, tree-shaking per icon, and type-checked import paths through `unplugin-icons/types/react` in `tsconfig.json`. A misspelled icon fails the build instead of rendering blank.

### Allowed sets

| Set            | Use                                                | Licence |
| -------------- | -------------------------------------------------- | ------- |
| `lucide`       | All UI icons (default)                             | ISC     |
| `simple-icons` | Monochrome brand marks (e.g. `simple-icons/slack`) | CC0-1.0 |
| `line-md`      | Animated icons (see §9)                            | MIT     |
| `svg-spinners` | Animated loading indicators (see §9)               | MIT     |

Every set used must also be listed as a `@iconify-json/<set>` devDependency. Using a set that is not in this table requires updating the table in the same change. This keeps stroke weight and visual style consistent.

A CC0 licence covers the artwork, not the trademark. Brand marks are used only to identify the integration they name, following that brand's usage guidelines.

### Do not use

- **`@iconify/react`.** It does not render SVG on the server ("only after it is mounted"), and by default it fetches icons from the public Iconify API at runtime.
- **`@iconify/tailwind4` / `icon-[set--name]` classes.** A misspelled icon name produces no CSS and fails silently.
- **`lucide-react` or `react-icons`.** They are a second source for the same icons.
- **Hand-written SVG components**, unless the icon exists in none of the allowed sets. Put any such component in `src/ui/icons/` with a comment saying which sets were checked.

### Rules

- **Prefer the canonical name over an alias.** For example, use `lucide/trash` rather than its alias `trash-2`.
- **Derived icons** are `twx` components, never wrapper functions:

  ```tsx
  import ChevronUp from "~icons/lucide/chevron-up";

  export const ChevronRightIcon = twx(ChevronUp)(() => "rotate-90");
  ```

- **Sizing** uses Tailwind (`size-4`). CSS overrides the `em`-based `width`/`height` attributes the compiler emits, so icons follow the same compose rules as everything else.
- **Color** comes from `currentColor`, so set it with `text-*` on the icon or its parent. Multi-color brand marks (the `logos` set) are not in the allowed list for this reason.
- **Decorative vs meaningful.** Decorative icons get `aria-hidden`. An icon that is the only content of a button requires an `aria-label` on the button.

---

## 9. Motion

There are two sources of motion, and no JavaScript animation library (`motion`, `framer-motion`, Lottie, ...) is a dependency. Add one only when neither source below can express the effect, and record the reason here.

### Tailwind animations on static elements

Use Tailwind animations (`animate-spin`, `animate-pulse`, or keyframes defined in `@theme`) on static icons and elements. **Every such animation is prefixed `motion-safe:`**, which respects `prefers-reduced-motion`:

```tsx
import RefreshCw from "~icons/lucide/refresh-cw";

const RefreshIcon = twx(RefreshCw).transientProps(["spinning"])<{ spinning?: boolean }>((props) =>
  props.spinning ? "size-4 motion-safe:animate-spin" : "size-4",
);
```

### Animated icons (`line-md`, `svg-spinners`)

These sets animate with SVG SMIL (`<animate>`, `<animateTransform>`) inside the icon itself. **SMIL ignores `prefers-reduced-motion`, so `motion-safe:` cannot reach it.** Every animated icon is therefore paired with a static counterpart, and CSS shows exactly one of the two:

```tsx
import LoadingLoop from "~icons/line-md/loading-loop";
import LoaderCircle from "~icons/lucide/loader-circle";

const SpinnerAnimated = twx(LoadingLoop).attrs({ "aria-hidden": true })(
  () => "size-4 motion-reduce:hidden",
);
const SpinnerStatic = twx(LoaderCircle).attrs({ "aria-hidden": true })(
  () => "size-4 motion-safe:hidden",
);

export function Spinner() {
  return (
    <>
      <SpinnerAnimated />
      <SpinnerStatic />
    </>
  );
}
```

- **Pairing is required.** An animated icon rendered without a static counterpart is a review blocker.
- **The static counterpart** is the set's own `*-static` variant where one exists, otherwise the closest `lucide` icon.
- **Animated icons live in `src/ui/`**, as paired components like `Spinner`. Feature code never imports `~icons/line-md/*` or `~icons/svg-spinners/*` directly, which keeps the pairing in one place.
- **Animated icons are always rendered inline.** SMIL inside an SVG used as an `<img>`, `background-image` or CSS `mask` does not reliably play.

### Ownership

**Loading state belongs to the component that owns it.** For example, `Button` takes a `loading` variant that swaps in `Spinner` and sets `aria-busy`. Do not scatter ad-hoc spinner markup across call sites.
