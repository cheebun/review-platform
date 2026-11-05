import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Checks src/styles/app.css against the normative token set in DESIGN.md.
 *
 * Dark mode selector (chosen): each `<name>-dark` token overrides `--color-<name>` under
 *   1. `:root.dark`
 *   2. `@media (prefers-color-scheme: dark) { :root:not(.light) }`
 * Both blocks must carry the identical override set.
 */

const root = resolve(import.meta.dirname, "../..");
const designSrc = readFileSync(resolve(root, "DESIGN.md"), "utf8");
const css = readFileSync(resolve(root, "src/styles/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

// ---- minimal YAML front matter parser (indent-based maps only; no yaml dependency) ----
type Tree = { [key: string]: string | Tree };

function parseFrontMatter(src: string): Tree {
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  if (!m) throw new Error("DESIGN.md has no front matter");
  const rootNode: Tree = {};
  const stack: { indent: number; node: Tree }[] = [{ indent: -1, node: rootNode }];
  for (const raw of m[1]!.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const kv = /^([\w-]+):\s*(.*)$/.exec(raw.trim());
    if (!kv) throw new Error(`Unparseable front matter line: ${raw}`);
    while (stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    const [, key, rawValue] = kv;
    if (rawValue === "") {
      const child: Tree = {};
      parent[key!] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key!] = rawValue!.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return rootNode;
}

const design = parseFrontMatter(designSrc);
const colors = design.colors as Record<string, string>;
const typography = design.typography as Record<string, Record<string, string>>;
const rounded = design.rounded as Record<string, string>;
const spacing = design.spacing as Record<string, string>;
const components = design.components as Record<string, Record<string, string>>;

// ---- CSS helpers ----
function blockAt(src: string, headerRe: RegExp): string {
  const m = headerRe.exec(src);
  if (!m) return ""; // missing block: tests then fail on their assertions
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

function decls(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim().replace(/\s+/g, " "));
  }
  return out;
}

const theme = decls(blockAt(css, /@theme\s*\{/));
const darkClass = decls(blockAt(css, /:root\.dark\s*\{/));
const darkMedia = decls(
  blockAt(
    blockAt(css, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{(?=\s*:root:not\(\.light\))/),
    /:root:not\(\.light\)\s*\{/,
  ),
);

const norm = (v: string) => v.replace(/\s+/g, " ").replaceAll("'", '"');

// ---- contrast ----
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
function ref(value: string): string {
  const m = /^\{colors\.([\w-]+)\}$/.exec(value);
  if (!m) throw new Error(`Not a colour ref: ${value}`);
  const c = colors[m[1]!];
  if (!c) throw new Error(`Unknown colour ref: ${value}`);
  return c;
}

const lightNames = Object.keys(colors).filter((k) => !k.endsWith("-dark"));
const darkNames = Object.keys(colors)
  .filter((k) => k.endsWith("-dark"))
  .map((k) => k.slice(0, -5));

describe("DESIGN.md -> app.css tokens", () => {
  it("a. light colours are in @theme with identical values", () => {
    for (const name of lightNames) {
      expect(theme.get(`--color-${name}`)?.toLowerCase(), `--color-${name}`).toBe(
        colors[name]!.toLowerCase(),
      );
    }
  });

  it("b. dark colours override under :root.dark and prefers-color-scheme (not .light)", () => {
    for (const [label, block] of [
      [":root.dark", darkClass],
      ["@media dark :root:not(.light)", darkMedia],
    ] as const) {
      for (const name of darkNames) {
        expect(colors[name], `${name} has a light sibling`).toBeDefined();
        expect(block.get(`--color-${name}`)?.toLowerCase(), `${label} --color-${name}`).toBe(
          colors[`${name}-dark`]!.toLowerCase(),
        );
      }
      const expectedKeys = darkNames.map((n) => `--color-${n}`).toSorted();
      const colourKeys = [...block.keys()].filter((k) => k.startsWith("--color-")).toSorted();
      expect(colourKeys, `${label} overrides only tokens with a -dark sibling`).toEqual(
        expectedKeys,
      );
    }
  });

  it("c. rounded.* maps to --radius-<name>", () => {
    for (const [name, value] of Object.entries(rounded)) {
      expect(theme.get(`--radius-${name}`), `--radius-${name}`).toBe(value);
    }
  });

  it("d. semantic spacing maps to --spacing-<name>, with no generic xs..2xl", () => {
    for (const [name, value] of Object.entries(spacing)) {
      if (name === "unit") continue;
      expect(theme.get(`--spacing-${name}`), `--spacing-${name}`).toBe(value);
    }
    for (const g of ["xs", "sm", "md", "lg", "xl", "2xl"]) {
      expect(theme.has(`--spacing-${g}`), `--spacing-${g} must be absent`).toBe(false);
    }
  });

  it("e. typography tokens become --text-<name> with sub-variables", () => {
    for (const [name, t] of Object.entries(typography)) {
      expect(theme.get(`--text-${name}`), `--text-${name}`).toBe(t.fontSize);
      expect(theme.get(`--text-${name}--line-height`), `${name} line-height`).toBe(t.lineHeight);
      expect(theme.get(`--text-${name}--font-weight`), `${name} font-weight`).toBe(t.fontWeight);
      if (t.letterSpacing) {
        expect(theme.get(`--text-${name}--letter-spacing`), `${name} letter-spacing`).toBe(
          t.letterSpacing,
        );
      } else {
        expect(theme.has(`--text-${name}--letter-spacing`)).toBe(false);
      }
    }
    expect(theme.get("--font-sans")).toMatch(/^"Inter Variable"/);
    expect(theme.get("--font-mono")).toMatch(/^"JetBrains Mono Variable"/);
  });

  it("e. fontFeature is applied exactly once, on html", () => {
    const features = new Set(
      Object.values(typography)
        .map((t) => t.fontFeature)
        .filter(Boolean),
    );
    expect(features.size).toBe(1);
    const [feature] = [...features];
    expect(css.match(/font-feature-settings/g)).toHaveLength(1);
    const htmlBlock = blockAt(css, /(^|[\s}])html\s*\{/m);
    // The formatter may switch quote style, so compare with quotes normalised.
    expect(norm(htmlBlock)).toContain(`font-feature-settings: ${norm(feature!)}`);
  });

  it("body uses the background / on-surface / sans tokens", () => {
    const body = blockAt(css, /(^|[\s}])body\s*\{/m);
    expect(body).toMatch(/bg-background/);
    expect(body).toMatch(/text-on-surface/);
    expect(body).toMatch(/font-sans/);
  });
});

describe("DESIGN.md contrast (WCAG 2.x)", () => {
  const pairs = Object.entries(components).filter(([, c]) => c.backgroundColor && c.textColor);

  it("has component pairs to check", () => {
    expect(pairs.length).toBeGreaterThan(10);
  });

  it.each(pairs)("component %s >= 4.5:1", (name, c) => {
    const ratio = contrast(ref(c.backgroundColor!), ref(c.textColor!));
    expect(ratio, `${name}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["primary-ink", "background"],
    ["primary-ink", "primary-soft"],
    ["muted-text", "surface"],
    ["secondary-text", "background"],
  ] as const)("prose pair %s on %s >= 4.5:1", (fg, bg) => {
    expect(contrast(colors[bg]!, colors[fg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("muted-text on background stays below 4.5 (documented guard: revisit rule if canvas changes)", () => {
    expect(contrast(colors.background!, colors["muted-text"]!)).toBeLessThan(4.5);
  });
});
