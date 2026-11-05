import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The user scopes the Slack PR review needs: read messages, reply, react, list channels. */
const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "mpim:history",
  "reactions:write",
];

type Manifest = {
  display_information: { name: string };
  oauth_config: { scopes: { user?: string[]; bot?: string[] } };
  settings: { socket_mode_enabled?: boolean };
};

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Manifest;

describe.each(["slack-app-manifest.json"])("%s", (file) => {
  const manifest = read(file);

  it("requests exactly the user scopes the review flow uses", () => {
    expect(manifest.oauth_config.scopes.user?.toSorted()).toEqual(USER_SCOPES);
    expect(manifest.oauth_config.scopes.bot ?? []).toEqual([]);
  });

  it("is named after the product", () => {
    expect(manifest.display_information.name).toBe("Review platform");
  });

  it("keeps Socket Mode off", () => {
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });
});
