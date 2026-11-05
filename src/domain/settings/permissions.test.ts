import { describe, expect, it } from "vitest";
import {
  ALL_UNVERIFIED,
  missingPermissions,
  permissionCells,
  repoHealth,
  type RepoPermissions,
} from "./permissions";

const granted: RepoPermissions = {
  pullRequests: { read: "granted", write: "granted" },
  contents: { read: "granted", write: "granted" },
  checks: { read: "granted" },
  statuses: { read: "granted" },
};

describe("missingPermissions", () => {
  it("lists nothing when all are granted", () => {
    expect(missingPermissions(granted)).toEqual([]);
  });

  it("names each missing permission as area:level, in table order", () => {
    expect(
      missingPermissions({
        ...granted,
        contents: { read: "granted", write: "missing" },
        statuses: { read: "missing" },
      }),
    ).toEqual(["contents:write", "statuses:read"]);
  });

  it("does not count unverified as missing", () => {
    expect(missingPermissions(ALL_UNVERIFIED)).toEqual([]);
  });
});

describe("repoHealth", () => {
  it("no access is an error regardless of permissions", () => {
    expect(repoHealth({ access: "no_access", permissions: granted })).toBe("error");
  });

  it("all granted is ok", () => {
    expect(repoHealth({ access: "ok", permissions: granted })).toBe("ok");
  });

  it("any missing permission is a warning", () => {
    expect(
      repoHealth({
        access: "ok",
        permissions: { ...granted, pullRequests: { read: "granted", write: "missing" } },
      }),
    ).toBe("warning");
  });

  it("unverified without missing is partial, never ok", () => {
    expect(
      repoHealth({
        access: "ok",
        permissions: { ...granted, pullRequests: { read: "granted", write: "unverified" } },
      }),
    ).toBe("partial");
  });

  it("a repo whose check could not run is unknown", () => {
    expect(repoHealth({ access: "unknown", permissions: null })).toBe("unknown");
  });
});

describe("permissionCells", () => {
  it("lists all six cells by name in table order", () => {
    expect(
      permissionCells({ ...ALL_UNVERIFIED, contents: { read: "granted", write: "missing" } }),
    ).toEqual([
      ["pull_requests:read", "unverified"],
      ["pull_requests:write", "unverified"],
      ["contents:read", "granted"],
      ["contents:write", "missing"],
      ["checks:read", "unverified"],
      ["statuses:read", "unverified"],
    ]);
  });
});
