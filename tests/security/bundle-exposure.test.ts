import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const CLIENT_ROOT = join(process.cwd(), "dist");

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

describe("production client disclosure boundary", () => {
  it("keeps answer snapshots, datasets, source maps, and server configuration out of public assets", () => {
    if (!existsSync(CLIENT_ROOT)) {
      if (process.env.REQUIRE_BUNDLE === "1") throw new Error("dist is missing; run the production build first");
      return;
    }
    const files = filesBelow(CLIENT_ROOT);
    const paths = files.map((path) => relative(CLIENT_ROOT, path));
    expect(paths.filter((path) => extname(path) === ".map")).toEqual([]);
    expect(paths.filter((path) => /(?:ions|compounds|difficulty)\.json$/u.test(path))).toEqual([]);

    const textExtensions = new Set([".css", ".html", ".js", ".json", ".svg", ".txt", ".xml"]);
    const text = files
      .filter((path) => textExtensions.has(extname(path)))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const forbidden of [
      "answer_snapshot_json",
      "TEACHER_ALLOWED_EMAILS", "COMPETITION_DATABASE_URL", "MASTER_TEACHER_EMAIL", "SUPABASE_SERVICE_ROLE_KEY",
      "過マンガン酸イオン",
      "テトラヒドロキソ亜鉛(II)酸イオン",
      "iron3_hydroxide",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});
