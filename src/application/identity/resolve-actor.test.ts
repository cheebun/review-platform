import { describe, expect, it } from "vitest";
import type { Actor } from "../../domain/shared/actor";
import { FakeAuth } from "../../testing/fakes/fake-auth";
import { resolveActor } from "./resolve-actor";

const TOKEN = "t".repeat(40);
const USER: Actor = { kind: "user", userId: "u1", email: "a@example.com" };

type Row = {
  name: string;
  authorization?: string;
  withSession?: boolean;
  expected: Actor | "unauthenticated";
};

/** Bearer-shaped, malformed and other schemes: every one is rejected, cookie or not. */
const AUTHORIZATIONS: Array<[string, string]> = [
  ["bearer", `Bearer ${TOKEN}`],
  ["short bearer", "Bearer abc"],
  ["lowercase scheme", `bearer ${TOKEN}`],
  ["Basic scheme", `Basic ${TOKEN}`],
  ["no scheme", TOKEN],
  ["double space", `Bearer  ${TOKEN}`],
  ["extra parts", `Bearer ${TOKEN} more`],
  ["empty token", "Bearer "],
  ["scheme only", "Bearer"],
  ["empty header", ""],
];

const rows: Row[] = [
  ...AUTHORIZATIONS.flatMap(([name, authorization]): Row[] => [
    { name, authorization, expected: "unauthenticated" },
    {
      name: `${name} with a valid cookie`,
      authorization,
      withSession: true,
      expected: "unauthenticated",
    },
  ]),
  { name: "valid session", withSession: true, expected: USER },
  { name: "no session", expected: "unauthenticated" },
];

describe("resolveActor", () => {
  it.each(rows)("$name", async (row) => {
    const auth = new FakeAuth();
    const headers = row.withSession ? auth.addSession("s1", USER) : new Headers();
    if (row.authorization !== undefined) headers.set("authorization", row.authorization);

    const res = await resolveActor({ headers, auth });

    if (row.expected === "unauthenticated") {
      expect(res).toEqual({ ok: false, error: { kind: "unauthenticated" } });
    } else {
      expect(res).toEqual({ ok: true, value: row.expected });
    }
  });

  it("does not consult the session when an Authorization header is present", async () => {
    const auth = new FakeAuth();
    let calls = 0;
    const spy = { ...auth, getSessionActor: async () => (calls++, USER) } as unknown as FakeAuth;
    const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
    await resolveActor({ headers, auth: spy });
    expect(calls).toBe(0);
  });
});
