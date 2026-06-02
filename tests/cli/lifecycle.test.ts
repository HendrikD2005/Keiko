import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLifecycleCli } from "../../src/cli/lifecycle.js";
import type { CliIo } from "../../src/cli/runner.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-lifecycle-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runLifecycleCli", () => {
  it("reports not running when no pid file exists", async () => {
    const root = makeRoot();
    const c = makeIo();

    const code = await runLifecycleCli("status", [], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(c.out()).toContain("not running");
    expect(c.err()).toBe("");
  });

  it("stops cleanly when no process is running", async () => {
    const root = makeRoot();
    const c = makeIo();

    const code = await runLifecycleCli("stop", [], c.io, {}, { cwd: root });

    expect(code).toBe(0);
    expect(c.out()).toContain("not running");
    expect(c.err()).toBe("");
  });

  it("starts the packaged UI through the compiled CLI entry and records runtime state", async () => {
    const root = makeRoot();
    const c = makeIo();
    const spawned: { command: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const child = { pid: 12345, unref: vi.fn() } as unknown as ChildProcess;

    const code = await runLifecycleCli(
      "start",
      ["--port", "4321", "--state-dir", ".keiko-test"],
      c.io,
      {},
      {
        cwd: root,
        spawnFn: (command, args, opts) => {
          spawned.push({ command, args, opts });
          return child;
        },
        fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
        isProcessAlive: () => true,
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining(["ui", "--port", "4321", "--host", "127.0.0.1"]),
    );
    expect(readFileSync(join(root, ".keiko-test", "ui.pid"), "utf8")).toBe("12345\n");
    expect(existsSync(join(root, ".keiko-test", "ui.log"))).toBe(true);
    expect(c.out()).toContain("Keiko UI running");
  });

  it("returns a usage error for invalid ports", async () => {
    const root = makeRoot();
    const c = makeIo();

    const code = await runLifecycleCli("start", ["--port", "99999"], c.io, {}, { cwd: root });

    expect(code).toBe(2);
    expect(c.err().toLowerCase()).toContain("usage");
  });
});
