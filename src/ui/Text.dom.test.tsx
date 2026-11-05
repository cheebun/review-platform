import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Code, Heading, Text, TextLink } from "./Text";

it("Text applies tone and weight and hides them from the DOM", () => {
  render(
    <Text tone="muted" weight="semibold">
      hello
    </Text>,
  );
  const el = screen.getByText("hello");
  expect(el).toHaveClass("text-secondary-text", "font-semibold");
  expect(el.outerHTML).not.toMatch(/tone=|weight=/);
});

it("Text can render as a paragraph via asChild", () => {
  render(
    <Text asChild>
      <p>para</p>
    </Text>,
  );
  expect(screen.getByText("para").tagName).toBe("P");
});

it("Heading maps level to the element and does not leak level", () => {
  render(<Heading level={5}>Title</Heading>);
  const h = screen.getByRole("heading", { level: 5, name: "Title" });
  expect(h.outerHTML).not.toMatch(/level=/);
});

it("Heading defaults to level 2", () => {
  render(<Heading>Default</Heading>);
  expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
});

it("Code renders a code element", () => {
  render(<Code>npm i</Code>);
  expect(screen.getByText("npm i").tagName).toBe("CODE");
  expect(screen.getByText("npm i")).toHaveClass("font-mono", "text-heading");
  expect(screen.getByText("npm i").className).not.toMatch(/\bbg-/);
});

it("TextLink adds target and rel only when external", () => {
  render(
    <>
      <TextLink href="https://a.test" external>
        out
      </TextLink>
      <TextLink href="/in">in</TextLink>
    </>,
  );
  const out = screen.getByRole("link", { name: "out" });
  expect(out).toHaveAttribute("target", "_blank");
  expect(out).toHaveAttribute("rel", "noopener noreferrer");
  expect(out.outerHTML).not.toMatch(/external=/);
  const inn = screen.getByRole("link", { name: "in" });
  expect(inn).not.toHaveAttribute("target");
  expect(inn).not.toHaveAttribute("rel");
});

it("tones use token text colours; no muted-text for content", () => {
  render(
    <>
      <Text>a</Text>
      <Text tone="danger">b</Text>
    </>,
  );
  expect(screen.getByText("a")).toHaveClass("text-on-surface");
  expect(screen.getByText("b")).toHaveClass("text-on-danger-soft");
});

it("Heading uses the heading colour", () => {
  render(<Heading>H</Heading>);
  expect(screen.getByRole("heading")).toHaveClass("text-heading");
});
