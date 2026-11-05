import { describe, expect, it } from "vitest";
import { isPublicServerFn, normalizePath, requiresAuth } from "./access-policy";

describe("requiresAuth: public paths", () => {
  it.each([
    ["/api/auth/sign-in/email", "POST"],
    ["/api/auth/get-session", "GET"],
    ["/api/auth/sign-up/email", "POST"],
    ["/api/auth/x/", "GET"],
    ["/api/slack/events", "POST"],
  ])("%s %s is public", (path, method) => {
    expect(requiresAuth(path, method)).toBe(false);
  });
});

describe("requiresAuth: protected paths", () => {
  it.each([
    ["/api/execute", "POST"],
    ["/api/review", "GET"],
    ["/api/slack/review-drain", "POST"],
    ["/api/slack/digest", "POST"],
    ["/api/slack/events", "GET"],
    ["/api/slack/events", "PUT"],
    ["/api/slack/events", "post"],
    ["/_serverFn/abc123", "POST"],
    ["/api", "GET"],
    ["/api/", "GET"],
    ["/", "GET"],
  ])("%s %s requires auth", (path, method) => {
    expect(requiresAuth(path, method)).toBe(true);
  });

  it("/api/auth itself has no endpoint and is not public", () => {
    expect(requiresAuth("/api/auth", "GET")).toBe(true);
    expect(requiresAuth("/api/auth/", "GET")).toBe(true);
  });

  it("a lookalike prefix is not public", () => {
    expect(requiresAuth("/api/authx/sign-in", "POST")).toBe(true);
    expect(requiresAuth("/api/slack/events-evil", "POST")).toBe(true);
    expect(requiresAuth("/api/slack/events/extra", "POST")).toBe(true);
  });
});

describe("requiresAuth: /api/public (removed)", () => {
  it.each([
    ["/api/public/auth-status", "GET"],
    ["/api/public/auth-status", "POST"],
    ["/api/public/auth-status", "HEAD"],
    ["/api/public/auth-status", "get"],
    ["/api/public/auth-status/", "GET"],
    ["/api/public/auth-status/x", "GET"],
    ["/api/public/auth-status-evil", "GET"],
    ["/api/public", "GET"],
    ["/api/public/", "GET"],
    ["/api/public/other", "GET"],
    ["/api//public/auth-status", "GET"],
    ["/API/public/auth-status", "GET"],
    ["/api/public/../me", "GET"],
  ])("%s %s requires auth", (path, method) => {
    expect(requiresAuth(path, method)).toBe(true);
  });
});

describe("requiresAuth: bypass attempts", () => {
  it.each([
    "/api/auth/../execute",
    "/api/auth/%2e%2e/execute",
    "/api/auth/%2E%2E/execute",
    "/api/auth/..%2fexecute",
    "/api/auth/./../execute",
    "/api/auth/..",
    "/api/auth/x/../../execute",
    "/api/auth/..\\execute",
    "/api\\auth/x",
  ])("%s requires auth", (path) => {
    expect(requiresAuth(path, "POST")).toBe(true);
  });

  it("case is significant: /API/auth/x is not public", () => {
    expect(requiresAuth("/API/auth/x", "POST")).toBe(true);
    expect(requiresAuth("/api/Auth/x", "POST")).toBe(true);
    expect(requiresAuth("/API/slack/events", "POST")).toBe(true);
    expect(requiresAuth("/api/slack/Events", "POST")).toBe(true);
  });

  it("a doubled slash does not become public", () => {
    expect(requiresAuth("/api//slack/events", "POST")).toBe(true);
    expect(requiresAuth("//api/slack/events", "POST")).toBe(true);
    expect(requiresAuth("/api//auth/x", "POST")).toBe(true);
    expect(requiresAuth("/api//execute", "POST")).toBe(true);
  });

  it("a trailing slash on the exact public route is not public (strict)", () => {
    expect(requiresAuth("/api/slack/events/", "POST")).toBe(true);
  });

  it("an encoded public path is decoded once, then judged", () => {
    expect(requiresAuth("/api/slack/%65vents", "POST")).toBe(false);
    expect(requiresAuth("/api/auth/sign%2Din/email", "POST")).toBe(false);
    // double encoding stays encoded after one decode, so it is not the public path
    expect(requiresAuth("/api/slack/%2565vents", "POST")).toBe(true);
  });

  it("malformed encoding, NUL and control characters fail closed", () => {
    expect(requiresAuth("/api/auth/%E0%A4%A", "GET")).toBe(true);
    expect(requiresAuth("/api/auth/x%00", "GET")).toBe(true);
    expect(requiresAuth("/api/auth/x%0a", "GET")).toBe(true);
  });

  it("a query or fragment smuggled through encoding is not public-by-prefix of another route", () => {
    expect(requiresAuth("/api/slack/events%3F", "POST")).toBe(true);
    expect(requiresAuth("/api/slack/events%23", "POST")).toBe(true);
  });

  it("a path that is not absolute requires auth", () => {
    expect(requiresAuth("api/slack/events", "POST")).toBe(true);
    expect(requiresAuth("", "POST")).toBe(true);
  });
});

describe("normalizePath", () => {
  it("decodes once and collapses duplicate slashes", () => {
    expect(normalizePath("/api//slack///events")).toBe("/api/slack/events");
    expect(normalizePath("/a/%2561")).toBe("/a/%61");
  });
  it("rejects dot segments, backslashes, controls and bad encoding", () => {
    for (const p of ["/a/../b", "/a/./b", "/a/%2e%2e/b", "/a\\b", "/a%00", "/a/%zz", "/a/.."]) {
      expect(normalizePath(p)).toBeNull();
    }
  });
});

describe("isPublicServerFn", () => {
  const FILE = "src/functions/login-token.ts";

  it.each(["getSetupStatus", "loginWithToken"])("%s is public", (name) => {
    expect(isPublicServerFn({ filename: FILE, name })).toBe(true);
  });

  it.each([
    "finishSetup",
    "getSetupSections",
    "testSetupAnthropic",
    "listSetupGithubRepos",
    "testSetupSlack",
  ])("setup %s is public", (name) => {
    expect(isPublicServerFn({ filename: "src/functions/setup.ts", name })).toBe(true);
  });

  it.each([
    [FILE, "rotateLoginToken"],
    [FILE, "initializeLoginToken"],
    [FILE, "finishSetup"],
    ["src/functions/setup.ts", "loginWithToken"],
    ["src/functions/settings-llm.ts", "testSetupAnthropic"],
    [FILE, "getsetupstatus"],
    [FILE, "constructor"],
    [FILE, "__proto__"],
    ["src/functions/viewer.ts", "loginWithToken"],
    ["./src/functions/login-token.ts", "loginWithToken"],
    ["/src/functions/login-token.ts", "loginWithToken"],
    ["src/functions/login-token.tsx", "loginWithToken"],
  ])("%s %s is not public", (filename, name) => {
    expect(isPublicServerFn({ filename, name })).toBe(false);
  });

  it("is false without metadata", () => {
    expect(isPublicServerFn(undefined)).toBe(false);
  });
});
