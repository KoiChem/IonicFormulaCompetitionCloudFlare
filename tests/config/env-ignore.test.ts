import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

let probeDirectory: string;

beforeAll(() => {
  probeDirectory = mkdtempSync(join(tmpdir(), "ionic-formula-ignore-"));
  copyFileSync(join(process.cwd(), ".gitignore"), join(probeDirectory, ".gitignore"));
  const initialized = spawnSync("git", ["init", "-q"], { cwd: probeDirectory });
  if (initialized.status !== 0) throw new Error(initialized.stderr.toString() || "git init failed");
});

afterAll(() => {
  if (probeDirectory) rmSync(probeDirectory, { recursive: true, force: true });
});

function isIgnored(path: string): boolean {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", path],
    { cwd: probeDirectory },
  );

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.toString() || "git check-ignore failed");
  }

  return result.status === 0;
}

describe("environment file ignore rules", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.production.local",
  ])("keeps %s out of version control", (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it("keeps the safe example file trackable", () => {
    expect(isIgnored(".env.example")).toBe(false);
  });
});
