import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { LoadingOverlay } from "./LoadingOverlay";

it("shows a status overlay with the tip while loading", () => {
  render(
    <LoadingOverlay loading tip="Loading data">
      <p>content</p>
    </LoadingOverlay>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading data");
  expect(screen.getByText("content")).toBeInTheDocument();
});

it("renders only the children when not loading", () => {
  render(
    <LoadingOverlay loading={false} tip="Loading data">
      <p>content</p>
    </LoadingOverlay>,
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText("content")).toBeInTheDocument();
});
