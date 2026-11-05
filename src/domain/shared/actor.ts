/** Who is making a request. Types only. */
export type Actor =
  | { kind: "user"; userId: string; email: string }
  | { kind: "machine"; name: "machine" };
