import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("migrates populated rooms and rankings without changing prior results", () => {
  const directory = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const migrations = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrations.filter(name => name < "0008")) database.exec(readFileSync(`${directory}/${name}`, "utf8"));
    database.prepare(`INSERT INTO rooms
      (id, public_id, join_code, kind, owner_teacher_id, settings_json, game_id, game_version, dataset_version, state, max_score, created_at_ms, expires_at_ms)
      VALUES ('room', 'public', 'ABC123', 'class', 'teacher', '{}', 'ionic', '1', '1', 'FINISHED', 5, 1, 10000)`).run();
    database.prepare(`INSERT INTO participants
      (room_id, id, token_hash, nickname, nickname_key, joined_at_ms, joined_order)
      VALUES ('room', 'person', 'token', 'person', 'person', 1, 1)`).run();
    database.prepare(`INSERT INTO final_results
      (room_id, participant_id, correct_count, elapsed_cs, rank, finish_reason)
      VALUES ('room', 'person', 2, 1234, 1, 'completed')`).run();
    database.exec(readFileSync(`${directory}/${migrations.find(name => name.startsWith("0008"))}`, "utf8"));
    expect(database.prepare("SELECT correct_count, elapsed_cs, rank, finish_reason FROM final_results").get()).toMatchObject({ correct_count: 2, elapsed_cs: 1234, rank: 1, finish_reason: "completed" });
    expect(database.prepare("SELECT end_reason FROM rooms").get()).toMatchObject({ end_reason: "normal" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.prepare("UPDATE final_results SET finish_reason = 'interrupted'").run();
  } finally { database.close(); }
});

it("adds the submitted result reason without losing existing rows", () => {
  const directory = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const migrations = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrations.filter(name => name < "0011")) database.exec(readFileSync(`${directory}/${name}`, "utf8"));
    database.prepare(`INSERT INTO rooms
      (id, public_id, join_code, kind, owner_teacher_id, settings_json, game_id, game_version, dataset_version, state, max_score, created_at_ms, expires_at_ms)
      VALUES ('room', 'public', 'ABC123', 'class', 'teacher', '{}', 'ionic', '1', '1', 'FINISHED', 5, 1, 10000)`).run();
    database.prepare(`INSERT INTO participants
      (room_id, id, token_hash, nickname, nickname_key, joined_at_ms, joined_order)
      VALUES ('room', 'person', 'token', 'person', 'person', 1, 1)`).run();
    database.prepare(`INSERT INTO final_results
      (room_id, participant_id, correct_count, elapsed_cs, rank, finish_reason)
      VALUES ('room', 'person', 2, 1234, 1, 'completed')`).run();
    database.exec(readFileSync(`${directory}/${migrations.find(name => name.startsWith("0011"))}`, "utf8"));
    expect(database.prepare("SELECT correct_count, elapsed_cs, rank, finish_reason FROM final_results").get()).toMatchObject({ correct_count: 2, elapsed_cs: 1234, rank: 1, finish_reason: "completed" });
    database.prepare("UPDATE final_results SET finish_reason = 'submitted'").run();
    expect(database.prepare("SELECT finish_reason FROM final_results").get()).toMatchObject({ finish_reason: "submitted" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { database.close(); }
});
