import { afterAll, describe, expect, it } from "vitest";
import { startAppServer, type AppServer } from "../../src/testing/integration/app-server";

// Self-test of the harness against a trivial node HTTP server (no build, no DB).
const script = `
const http = require("node:http");
const s = http.createServer((q, r) => {
  if (q.url === "/api/auth/ok") {
    r.setHeader("set-cookie", ["a=b; HttpOnly", "c=d"]);
    r.end(JSON.stringify({ ok: true }));
  } else { r.statusCode = 404; r.end(); }
}).listen(+process.env.PORT, process.env.HOST);
process.on("SIGTERM", () => s.close(() => process.exit(0)));
`;

let app: AppServer | undefined;
afterAll(async () => app?.dispose());

describe("app-server harness", () => {
  it("starts, serves, stores cookies and stops with exit 0 on SIGTERM", async () => {
    app = await startAppServer({ command: { file: process.execPath, args: ["-e", script] } });
    const res = await fetch(`${app.baseUrl}/api/auth/ok`);
    expect(await res.json()).toEqual({ ok: true });
    const jar = app.cookieJar();
    jar.store(res);
    expect(jar.header()).toBe("a=b; c=d");
    const stop = await app.stop();
    expect(stop.code).toBe(0);
    expect(stop.ms).toBeLessThan(5_000);
  });
});
