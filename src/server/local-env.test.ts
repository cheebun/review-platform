import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLocalEnv } from "./local-env";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-env-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

describe("loadLocalEnv", () => {
  it("returns nothing and changes nothing when no file exists", () => {
    const target = { A: "1" };
    expect(loadLocalEnv({ cwd: dir, target })).toEqual([]);
    expect(target).toEqual({ A: "1" });
  });

  it("loads .env.local into the target", () => {
    write(".env.local", "FOO=from-local\n");
    const target: Record<string, string | undefined> = {};
    expect(loadLocalEnv({ cwd: dir, target })).toEqual([".env.local"]);
    expect(target.FOO).toBe("from-local");
  });

  it("uses the dev server's precedence: .env < .env.local < .env.development < .env.development.local", () => {
    write(".env", "A=env\nB=env\nC=env\nD=env\n");
    write(".env.local", "B=local\nC=local\nD=local\n");
    write(".env.development", "C=dev\nD=dev\n");
    write(".env.development.local", "D=devlocal\n");
    const target: Record<string, string | undefined> = {};
    loadLocalEnv({ cwd: dir, target });
    expect(target).toEqual({ A: "env", B: "local", C: "dev", D: "devlocal" });
  });

  it("never overrides a real environment variable", () => {
    write(".env.local", "FOO=file\nBAR=file\n");
    const target: Record<string, string | undefined> = { FOO: "real" };
    loadLocalEnv({ cwd: dir, target });
    expect(target).toEqual({ FOO: "real", BAR: "file" });
  });

  it("treats an empty real variable as set", () => {
    write(".env.local", "FOO=file\n");
    const target: Record<string, string | undefined> = { FOO: "" };
    loadLocalEnv({ cwd: dir, target });
    expect(target.FOO).toBe("");
  });

  it("honours a custom mode", () => {
    write(".env.development", "X=dev\n");
    write(".env.staging", "X=staging\n");
    const target: Record<string, string | undefined> = {};
    loadLocalEnv({ cwd: dir, mode: "staging", target });
    expect(target.X).toBe("staging");
  });
});
