import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import * as icons from "./index";

it("re-exports the icon set as inline svg components", () => {
  const names = Object.keys(icons);
  expect(names).toEqual(
    expect.arrayContaining([
      "ArrowRightIcon",
      "RefreshIcon",
      "CircleCheckIcon",
      "CheckIcon",
      "CopyIcon",
      "RocketIcon",
      "TrashIcon",
      "FileTextIcon",
      "LinkIcon",
      "GitMergeIcon",
      "ZapIcon",
      "UserIcon",
      "SlackIcon",
    ]),
  );
  for (const name of names) {
    const Icon = (icons as Record<string, React.ComponentType>)[name]!;
    const { container, unmount } = render(<Icon />);
    expect(container.querySelector("svg"), name).not.toBeNull();
    unmount();
  }
});
