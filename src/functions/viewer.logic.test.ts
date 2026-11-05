import { describe, expect, it } from "vitest";
import { FakeAuth } from "../testing/fakes/fake-auth";
import { loadViewer } from "./viewer.logic";

describe("loadViewer", () => {
  it("returns only the email of a signed-in user", async () => {
    const auth = new FakeAuth();
    const headers = auth.addSession("t1", { kind: "user", userId: "u1", email: "a@b.c" });
    expect(await loadViewer(headers, auth)).toEqual({ email: "a@b.c" });
  });

  it("returns null without a session", async () => {
    expect(await loadViewer(new Headers(), new FakeAuth())).toBeNull();
  });

  it("a machine session is not a viewer", async () => {
    const auth = new FakeAuth();
    const headers = auth.addSession("m", { kind: "machine", name: "machine" });
    expect(await loadViewer(headers, auth)).toBeNull();
  });

  it("a Bearer header never makes a viewer (only the session cookie counts)", async () => {
    const headers = new Headers({ authorization: "Bearer whatever" });
    expect(await loadViewer(headers, new FakeAuth())).toBeNull();
  });
});
