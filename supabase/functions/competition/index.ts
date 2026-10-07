// src/platform/database-url.ts
function transactionPoolerUrl(directUrl, projectRef, poolerHost) {
  const url2 = new URL(directUrl);
  if (url2.hostname !== `db.${projectRef}.supabase.co` || url2.username !== "postgres") {
    throw new Error("Unexpected built-in database topology");
  }
  url2.hostname = poolerHost;
  url2.port = "6543";
  url2.username = `postgres.${projectRef}`;
  return url2.toString();
}

// src/platform/postgres-runtime.ts
import postgres from "npm:postgres@3.4.9";

// src/platform/postgres-database.ts
function postgresQuery(input, values = []) {
  let sql = input.replaceAll("`", '"').replace(/CAST\(unixepoch\('subsec'\) \* 1000 AS INTEGER\)/g, "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint").replace(/CAST\(([^()]+) AS INTEGER\)/gi, "CAST($1 AS bigint)").replace(/json_object\(/g, "json_build_object(").replace(/(?<!CROSS )\bJOIN\s+json_each\(/g, "CROSS JOIN LATERAL json_each(").replace(/json_each\(([^()]+)\)/g, "jsonb_array_elements(($1)::text::jsonb)").replace(/json_extract\(([^,()]+),\s*'\$((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+)'\)/g, (_match, expression, path) => {
    const keys2 = Array.from(path.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g), (m) => m[1] ?? m[2]);
    const extract = `((${expression})::text::jsonb #>> '{${keys2.join(",")}}')`;
    return ["correctCount", "elapsedCs", "rank", "ordinal", "maxScore"].includes(keys2.at(-1)) ? `${extract}::bigint` : extract;
  }).replace(/MAX\((expires_at_ms|0),/g, "GREATEST($1,");
  const ignore = /\bINSERT OR IGNORE\b/i.test(sql);
  sql = sql.replace(/\bINSERT OR IGNORE\b/gi, "INSERT");
  if (ignore) sql = sql.trim().replace(/;$/, "") + " ON CONFLICT DO NOTHING";
  sql = sql.replace(/CASE WHEN \? THEN/g, "CASE WHEN ?::bigint <> 0 THEN");
  sql = sql.replace(/json_build_object\(([^]*?)\)(?=\s*,\s*(?:\?|CAST|r\.|revision|ended_at_ms))/g, "json_build_object($1)::text");
  let quoted = false;
  let index = 0;
  let result = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (quoted && sql[i + 1] === "'") {
        result += "''";
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (c === "?" && !quoted) {
      const numeric = typeof values[index] === "number";
      result += `$${++index}${numeric ? "::bigint" : ""}`;
    } else result += c;
  }
  return result;
}
function normalize(row) {
  return Object.fromEntries(Object.entries(row).map(([key2, value]) => [
    key2,
    typeof value === "bigint" ? Number(value) : typeof value === "string" && /^(?:-?\d+)$/.test(value) && /(?:_ms|_cs|count|revision|ordinal|generation|epoch|seq|rank|enabled|score|joined_order)$/.test(key2) ? Number(value) : value
  ]));
}
var PostgresStatement = class _PostgresStatement {
  constructor(execute, query, values = []) {
    this.execute = execute;
    this.query = query;
    this.values = values;
  }
  bind(...values) {
    return new _PostgresStatement(this.execute, this.query, values);
  }
  async all() {
    const result = await this.execute(postgresQuery(this.query, this.values), this.values);
    return { results: result.rows.map(normalize) };
  }
  async first() {
    return (await this.all()).results[0] ?? null;
  }
  async run() {
    const result = await this.execute(postgresQuery(this.query, this.values), this.values);
    return { success: true, meta: { changes: result.affectedRows ?? result.rows.length } };
  }
};
var PostgresDatabase = class {
  constructor(execute) {
    this.execute = execute;
  }
  transactional = true;
  prepare(query) {
    return new PostgresStatement(this.execute, query);
  }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
};

// src/platform/postgres-runtime.ts
function transactionIsolation(scope) {
  if (scope.startsWith("snapshot:")) return "repeatable read read only";
  return scope.startsWith("room:") || scope.startsWith("broadcast:") ? "read committed" : "serializable";
}
function postgresTransactions(connectionString, options = {}) {
  const sql = postgres(connectionString, { prepare: false, max: 1, ssl: options.ssl ?? "require", idle_timeout: options.idleTimeoutSeconds ?? 1, connect_timeout: 10 });
  return async (scope, run, metrics) => {
    for (let attempt = 0; ; attempt++) {
      const queuedAt = Date.now();
      let began = false;
      const control = () => {
        if (metrics) metrics.controlQueryCount = (metrics.controlQueryCount ?? 0) + 1;
      };
      const controlDelay = async () => {
        if (options.controlDelayMs) await new Promise((resolve) => setTimeout(resolve, options.controlDelayMs));
      };
      try {
        const value = await sql.begin(`isolation level ${transactionIsolation(scope)}`, async (tx) => {
          began = true;
          control();
          await controlDelay();
          if (metrics) metrics.poolWaitMs += Date.now() - queuedAt;
          control();
          await controlDelay();
          await tx.unsafe("SET LOCAL statement_timeout = 9000");
          control();
          await controlDelay();
          await tx.unsafe("SET LOCAL lock_timeout = 7000");
          const lockStarted = Date.now();
          if (!scope.startsWith("snapshot:") && !scope.startsWith("quota:")) {
            control();
            await controlDelay();
            await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [scope]);
          }
          if (metrics) metrics.roomLockWaitMs += Date.now() - lockStarted;
          const workStarted = Date.now();
          const execute = async (query, values) => {
            try {
              if (metrics) metrics.queryCount++;
              if (options.queryDelayMs) await new Promise((resolve) => setTimeout(resolve, options.queryDelayMs));
              const rows = await tx.unsafe(query, values);
              return { rows: Array.from(rows), affectedRows: rows.count };
            } catch (error) {
              console.error(JSON.stringify({ event: "database_query_failed", code: error.code, operation: query.trim().split(/\s/)[0] }));
              throw error;
            }
          };
          let result;
          try {
            result = await run(new PostgresDatabase(execute));
          } finally {
            if (metrics) metrics.dbWorkMs += Date.now() - workStarted;
          }
          if (result instanceof Response && result.status >= 500) throw result;
          await controlDelay();
          return result;
        });
        control();
        return value;
      } catch (error) {
        if (began) control();
        if (error instanceof Response) return error;
        if (attempt < 4 && ["40001", "40P01"].includes(error.code ?? "")) {
          if (metrics) metrics.retryCount = (metrics.retryCount ?? 0) + 1;
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt + Math.floor(Math.random() * 50)));
          continue;
        }
        throw error;
      }
    }
  };
}

// src/persistence/db.ts
var PersistenceConflictError = class extends Error {
  constructor(code, message, status = 409, retryAfterSeconds) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "PersistenceConflictError";
    this.status = status;
  }
  status;
};
async function loadCommandReceipt(database, roomId, actorId, requestId2, bodyHash2) {
  const receipt2 = await database.prepare(
    `SELECT c.body_hash, c.result_json
     FROM command_receipts c JOIN rooms r ON r.id = c.room_id
     WHERE c.room_id = ? AND c.actor_id = ? AND c.request_id = ?
       AND c.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
       AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)`
  ).bind(roomId, actorId, requestId2).first();
  if (!receipt2) return null;
  if (receipt2.body_hash !== bodyHash2) {
    throw new PersistenceConflictError("request_id_reused", "requestId was already used with another payload");
  }
  return JSON.parse(receipt2.result_json);
}
function json(value) {
  return JSON.stringify(value);
}
function commandMarker(actorId, requestId2) {
  return `${actorId}:${requestId2}:${crypto.randomUUID()}`;
}
function changed(result) {
  return Number(result?.meta.changes ?? 0) > 0;
}
function isRetryableDatabaseConflict(error) {
  if (typeof error !== "object" || error === null) return false;
  const value = error;
  if (value.code === "SQLITE_BUSY" || value.code === "SQLITE_LOCKED") return true;
  return typeof value.message === "string" && /(?:database.*(?:busy|locked)|D1_ERROR.*conflict)/i.test(value.message);
}

// src/games/ionic-formula/data/ions.json
var ions_default = [
  {
    id: "lithium",
    formula: "Li",
    charge: 1,
    name: "\u30EA\u30C1\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "sodium",
    formula: "Na",
    charge: 1,
    name: "\u30CA\u30C8\u30EA\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "potassium",
    formula: "K",
    charge: 1,
    name: "\u30AB\u30EA\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "silver",
    formula: "Ag",
    charge: 1,
    name: "\u9280\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "magnesium",
    formula: "Mg",
    charge: 2,
    name: "\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "calcium",
    formula: "Ca",
    charge: 2,
    name: "\u30AB\u30EB\u30B7\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "barium",
    formula: "Ba",
    charge: 2,
    name: "\u30D0\u30EA\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "zinc",
    formula: "Zn",
    charge: 2,
    name: "\u4E9C\u925B\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "aluminum",
    formula: "Al",
    charge: 3,
    name: "\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "ammonium",
    formula: "NH4",
    charge: 1,
    name: "\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "hydronium",
    formula: "H3O",
    charge: 1,
    name: "\u30AA\u30AD\u30BD\u30CB\u30A6\u30E0\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    ionQuestionEnabled: true,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "iron2",
    formula: "Fe",
    charge: 2,
    name: "\u9244(\u2161)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    enabled: true
  },
  {
    id: "iron3",
    formula: "Fe",
    charge: 3,
    name: "\u9244(\u2162)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    enabled: true
  },
  {
    id: "copper1",
    formula: "Cu",
    charge: 1,
    name: "\u9285(\u2160)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    enabled: true
  },
  {
    id: "copper2",
    formula: "Cu",
    charge: 2,
    name: "\u9285(\u2161)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    enabled: true
  },
  {
    id: "chromium3",
    formula: "Cr",
    charge: 3,
    name: "\u30AF\u30ED\u30E0(\u2162)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "manganese2",
    formula: "Mn",
    charge: 2,
    name: "\u30DE\u30F3\u30AC\u30F3(\u2161)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "tin2",
    formula: "Sn",
    charge: 2,
    name: "\u30B9\u30BA(\u2161)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "tin4",
    formula: "Sn",
    charge: 4,
    name: "\u30B9\u30BA(\u2163)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "gold3",
    formula: "Au",
    charge: 3,
    name: "\u91D1(\u2162)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "lead2",
    formula: "Pb",
    charge: 2,
    name: "\u925B(\u2161)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "lead4",
    formula: "Pb",
    charge: 4,
    name: "\u925B(\u2163)\u30A4\u30AA\u30F3",
    type: "cation",
    atomicity: "monatomic",
    requiresOxidationNumeral: true,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "nitride",
    formula: "N",
    charge: -3,
    name: "\u7A92\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "fluoride",
    formula: "F",
    charge: -1,
    name: "\u30D5\u30C3\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "chloride",
    formula: "Cl",
    charge: -1,
    name: "\u5869\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "bromide",
    formula: "Br",
    charge: -1,
    name: "\u81ED\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "iodide",
    formula: "I",
    charge: -1,
    name: "\u30E8\u30A6\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "oxide",
    formula: "O",
    charge: -2,
    name: "\u9178\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "sulfide",
    formula: "S",
    charge: -2,
    name: "\u786B\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "monatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "hydroxide",
    formula: "OH",
    charge: -1,
    name: "\u6C34\u9178\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "nitrate",
    formula: "NO3",
    charge: -1,
    name: "\u785D\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "sulfate",
    formula: "SO4",
    charge: -2,
    name: "\u786B\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "carbonate",
    formula: "CO3",
    charge: -2,
    name: "\u70AD\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "bicarbonate",
    formula: "HCO3",
    charge: -1,
    name: "\u70AD\u9178\u6C34\u7D20\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "phosphate",
    formula: "PO4",
    charge: -3,
    name: "\u30EA\u30F3\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "acetate",
    formula: "CH3COO",
    charge: -1,
    name: "\u9162\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    enabled: true
  },
  {
    id: "sulfite",
    formula: "SO3",
    charge: -2,
    name: "\u4E9C\u786B\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "nitrite",
    formula: "NO2",
    charge: -1,
    name: "\u4E9C\u785D\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "hypochlorite",
    formula: "ClO",
    charge: -1,
    name: "\u6B21\u4E9C\u5869\u7D20\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "chlorate",
    formula: "ClO3",
    charge: -1,
    name: "\u5869\u7D20\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "thiosulfate",
    formula: "S2O3",
    charge: -2,
    name: "\u30C1\u30AA\u786B\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "thiocyanate",
    formula: "SCN",
    charge: -1,
    name: "\u30C1\u30AA\u30B7\u30A2\u30F3\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "cyanide",
    formula: "CN",
    charge: -1,
    name: "\u30B7\u30A2\u30F3\u5316\u7269\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "iodate",
    formula: "IO3",
    charge: -1,
    name: "\u30E8\u30A6\u7D20\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "permanganate",
    formula: "MnO4",
    charge: -1,
    name: "\u904E\u30DE\u30F3\u30AC\u30F3\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "chromate",
    formula: "CrO4",
    charge: -2,
    name: "\u30AF\u30ED\u30E0\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  },
  {
    id: "dichromate",
    formula: "Cr2O7",
    charge: -2,
    name: "\u4E8C\u30AF\u30ED\u30E0\u9178\u30A4\u30AA\u30F3",
    type: "anion",
    atomicity: "polyatomic",
    requiresOxidationNumeral: false,
    compoundPromptDisplay: "formulaAndName",
    ionQuestionEnabled: false,
    difficulty: "hard",
    enabled: true
  }
];

// src/games/ionic-formula/data/compounds.json
var compounds_default = [
  {
    id: "sodium_chloride",
    cation: "sodium",
    anion: "chloride",
    formula: "NaCl",
    name: "\u5869\u5316\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_chloride",
    cation: "potassium",
    anion: "chloride",
    formula: "KCl",
    name: "\u5869\u5316\u30AB\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "silver_chloride",
    cation: "silver",
    anion: "chloride",
    formula: "AgCl",
    name: "\u5869\u5316\u9280",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "silver_bromide",
    cation: "silver",
    anion: "bromide",
    formula: "AgBr",
    name: "\u81ED\u5316\u9280",
    solidColor: "\u6DE1\u9EC4\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "silver_iodide",
    cation: "silver",
    anion: "iodide",
    formula: "AgI",
    name: "\u30E8\u30A6\u5316\u9280",
    solidColor: "\u9EC4\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_fluoride",
    cation: "sodium",
    anion: "fluoride",
    formula: "NaF",
    name: "\u30D5\u30C3\u5316\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_bromide",
    cation: "sodium",
    anion: "bromide",
    formula: "NaBr",
    name: "\u81ED\u5316\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_iodide",
    cation: "sodium",
    anion: "iodide",
    formula: "NaI",
    name: "\u30E8\u30A6\u5316\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_bromide",
    cation: "potassium",
    anion: "bromide",
    formula: "KBr",
    name: "\u81ED\u5316\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_iodide",
    cation: "potassium",
    anion: "iodide",
    formula: "KI",
    name: "\u30E8\u30A6\u5316\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "magnesium_oxide",
    cation: "magnesium",
    anion: "oxide",
    formula: "MgO",
    name: "\u9178\u5316\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "calcium_oxide",
    cation: "calcium",
    anion: "oxide",
    formula: "CaO",
    name: "\u9178\u5316\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "barium_oxide",
    cation: "barium",
    anion: "oxide",
    formula: "BaO",
    name: "\u9178\u5316\u30D0\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "zinc_oxide",
    cation: "zinc",
    anion: "oxide",
    formula: "ZnO",
    name: "\u9178\u5316\u4E9C\u925B",
    solidColor: "\u767D\u8272",
    solidColorNote: "\u52A0\u71B1\u6642\u306F\u9EC4\u8272",
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "magnesium_sulfide",
    cation: "magnesium",
    anion: "sulfide",
    formula: "MgS",
    name: "\u786B\u5316\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "calcium_sulfide",
    cation: "calcium",
    anion: "sulfide",
    formula: "CaS",
    name: "\u786B\u5316\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "zinc_sulfide",
    cation: "zinc",
    anion: "sulfide",
    formula: "ZnS",
    name: "\u786B\u5316\u4E9C\u925B",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_oxide",
    cation: "sodium",
    anion: "oxide",
    formula: "Na2O",
    name: "\u9178\u5316\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_oxide",
    cation: "potassium",
    anion: "oxide",
    formula: "K2O",
    name: "\u9178\u5316\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_sulfide",
    cation: "sodium",
    anion: "sulfide",
    formula: "Na2S",
    name: "\u786B\u5316\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_sulfide",
    cation: "potassium",
    anion: "sulfide",
    formula: "K2S",
    name: "\u786B\u5316\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "magnesium_chloride",
    cation: "magnesium",
    anion: "chloride",
    formula: "MgCl2",
    name: "\u5869\u5316\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "calcium_chloride",
    cation: "calcium",
    anion: "chloride",
    formula: "CaCl2",
    name: "\u5869\u5316\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "barium_chloride",
    cation: "barium",
    anion: "chloride",
    formula: "BaCl2",
    name: "\u5869\u5316\u30D0\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "zinc_chloride",
    cation: "zinc",
    anion: "chloride",
    formula: "ZnCl2",
    name: "\u5869\u5316\u4E9C\u925B",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "aluminum_chloride",
    cation: "aluminum",
    anion: "chloride",
    formula: "AlCl3",
    name: "\u5869\u5316\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "aluminum_oxide",
    cation: "aluminum",
    anion: "oxide",
    formula: "Al2O3",
    name: "\u9178\u5316\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "aluminum_sulfide",
    cation: "aluminum",
    anion: "sulfide",
    formula: "Al2S3",
    name: "\u786B\u5316\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "silver_oxide",
    cation: "silver",
    anion: "oxide",
    formula: "Ag2O",
    name: "\u9178\u5316\u9280",
    solidColor: "\u8910\u8272\u301C\u9ED2\u8910\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_hydroxide",
    cation: "sodium",
    anion: "hydroxide",
    formula: "NaOH",
    name: "\u6C34\u9178\u5316\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_hydroxide",
    cation: "potassium",
    anion: "hydroxide",
    formula: "KOH",
    name: "\u6C34\u9178\u5316\u30AB\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "magnesium_hydroxide",
    cation: "magnesium",
    anion: "hydroxide",
    formula: "Mg(OH)2",
    name: "\u6C34\u9178\u5316\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "calcium_hydroxide",
    cation: "calcium",
    anion: "hydroxide",
    formula: "Ca(OH)2",
    name: "\u6C34\u9178\u5316\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "barium_hydroxide",
    cation: "barium",
    anion: "hydroxide",
    formula: "Ba(OH)2",
    name: "\u6C34\u9178\u5316\u30D0\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "aluminum_hydroxide",
    cation: "aluminum",
    anion: "hydroxide",
    formula: "Al(OH)3",
    name: "\u6C34\u9178\u5316\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "zinc_hydroxide",
    cation: "zinc",
    anion: "hydroxide",
    formula: "Zn(OH)2",
    name: "\u6C34\u9178\u5316\u4E9C\u925B",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_nitrate",
    cation: "sodium",
    anion: "nitrate",
    formula: "NaNO3",
    name: "\u785D\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_nitrate",
    cation: "potassium",
    anion: "nitrate",
    formula: "KNO3",
    name: "\u785D\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "silver_nitrate",
    cation: "silver",
    anion: "nitrate",
    formula: "AgNO3",
    name: "\u785D\u9178\u9280",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "magnesium_nitrate",
    cation: "magnesium",
    anion: "nitrate",
    formula: "Mg(NO3)2",
    name: "\u785D\u9178\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "calcium_nitrate",
    cation: "calcium",
    anion: "nitrate",
    formula: "Ca(NO3)2",
    name: "\u785D\u9178\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "barium_nitrate",
    cation: "barium",
    anion: "nitrate",
    formula: "Ba(NO3)2",
    name: "\u785D\u9178\u30D0\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "zinc_nitrate",
    cation: "zinc",
    anion: "nitrate",
    formula: "Zn(NO3)2",
    name: "\u785D\u9178\u4E9C\u925B",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "aluminum_nitrate",
    cation: "aluminum",
    anion: "nitrate",
    formula: "Al(NO3)3",
    name: "\u785D\u9178\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "ammonium_nitrate",
    cation: "ammonium",
    anion: "nitrate",
    formula: "NH4NO3",
    name: "\u785D\u9178\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_sulfate",
    cation: "sodium",
    anion: "sulfate",
    formula: "Na2SO4",
    name: "\u786B\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_sulfate",
    cation: "potassium",
    anion: "sulfate",
    formula: "K2SO4",
    name: "\u786B\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "magnesium_sulfate",
    cation: "magnesium",
    anion: "sulfate",
    formula: "MgSO4",
    name: "\u786B\u9178\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "calcium_sulfate",
    cation: "calcium",
    anion: "sulfate",
    formula: "CaSO4",
    name: "\u786B\u9178\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "barium_sulfate",
    cation: "barium",
    anion: "sulfate",
    formula: "BaSO4",
    name: "\u786B\u9178\u30D0\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "zinc_sulfate",
    cation: "zinc",
    anion: "sulfate",
    formula: "ZnSO4",
    name: "\u786B\u9178\u4E9C\u925B",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "aluminum_sulfate",
    cation: "aluminum",
    anion: "sulfate",
    formula: "Al2(SO4)3",
    name: "\u786B\u9178\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "ammonium_sulfate",
    cation: "ammonium",
    anion: "sulfate",
    formula: "(NH4)2SO4",
    name: "\u786B\u9178\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_carbonate",
    cation: "sodium",
    anion: "carbonate",
    formula: "Na2CO3",
    name: "\u70AD\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_carbonate",
    cation: "potassium",
    anion: "carbonate",
    formula: "K2CO3",
    name: "\u70AD\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "magnesium_carbonate",
    cation: "magnesium",
    anion: "carbonate",
    formula: "MgCO3",
    name: "\u70AD\u9178\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "calcium_carbonate",
    cation: "calcium",
    anion: "carbonate",
    formula: "CaCO3",
    name: "\u70AD\u9178\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "barium_carbonate",
    cation: "barium",
    anion: "carbonate",
    formula: "BaCO3",
    name: "\u70AD\u9178\u30D0\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "zinc_carbonate",
    cation: "zinc",
    anion: "carbonate",
    formula: "ZnCO3",
    name: "\u70AD\u9178\u4E9C\u925B",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_bicarbonate",
    cation: "sodium",
    anion: "bicarbonate",
    formula: "NaHCO3",
    name: "\u70AD\u9178\u6C34\u7D20\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_bicarbonate",
    cation: "potassium",
    anion: "bicarbonate",
    formula: "KHCO3",
    name: "\u70AD\u9178\u6C34\u7D20\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "ammonium_chloride",
    cation: "ammonium",
    anion: "chloride",
    formula: "NH4Cl",
    name: "\u5869\u5316\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "ammonium_bromide",
    cation: "ammonium",
    anion: "bromide",
    formula: "NH4Br",
    name: "\u81ED\u5316\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "ammonium_iodide",
    cation: "ammonium",
    anion: "iodide",
    formula: "NH4I",
    name: "\u30E8\u30A6\u5316\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_phosphate",
    cation: "sodium",
    anion: "phosphate",
    formula: "Na3PO4",
    name: "\u30EA\u30F3\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "potassium_phosphate",
    cation: "potassium",
    anion: "phosphate",
    formula: "K3PO4",
    name: "\u30EA\u30F3\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "calcium_phosphate",
    cation: "calcium",
    anion: "phosphate",
    formula: "Ca3(PO4)2",
    name: "\u30EA\u30F3\u9178\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "aluminum_phosphate",
    cation: "aluminum",
    anion: "phosphate",
    formula: "AlPO4",
    name: "\u30EA\u30F3\u9178\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "sodium_acetate",
    cation: "sodium",
    anion: "acetate",
    formula: "CH3COONa",
    name: "\u9162\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    },
    acceptedFormulaVariants: [
      {
        formula: "NaCH3COO",
        note: "\u3053\u306E\u30A2\u30D7\u30EA\u3067\u306F CH\u2083COONa \u3092\u63A8\u5968\u8868\u8A18\u3068\u3057\u307E\u3059\u3002"
      }
    ]
  },
  {
    id: "potassium_acetate",
    cation: "potassium",
    anion: "acetate",
    formula: "CH3COOK",
    name: "\u9162\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    },
    acceptedFormulaVariants: [
      {
        formula: "KCH3COO",
        note: "\u3053\u306E\u30A2\u30D7\u30EA\u3067\u306F CH\u2083COOK \u3092\u63A8\u5968\u8868\u8A18\u3068\u3057\u307E\u3059\u3002"
      }
    ]
  },
  {
    id: "lead2_acetate",
    cation: "lead2",
    anion: "acetate",
    formula: "(CH3COO)2Pb",
    name: "\u9162\u9178\u925B(\u2161)",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true },
    acceptedFormulaVariants: [{ formula: "Pb(CH3COO)2", note: "\u3053\u306E\u30A2\u30D7\u30EA\u3067\u306F (CH\u2083COO)\u2082Pb \u3092\u63A8\u5968\u8868\u8A18\u3068\u3057\u307E\u3059\u3002" }]
  },
  {
    id: "calcium_acetate",
    cation: "calcium",
    anion: "acetate",
    formula: "(CH3COO)2Ca",
    name: "\u9162\u9178\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true },
    acceptedFormulaVariants: [{ formula: "Ca(CH3COO)2", note: "\u3053\u306E\u30A2\u30D7\u30EA\u3067\u306F (CH\u2083COO)\u2082Ca \u3092\u63A8\u5968\u8868\u8A18\u3068\u3057\u307E\u3059\u3002" }]
  },
  {
    id: "lithium_fluoride",
    cation: "lithium",
    anion: "fluoride",
    formula: "LiF",
    name: "\u30D5\u30C3\u5316\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_chloride",
    cation: "lithium",
    anion: "chloride",
    formula: "LiCl",
    name: "\u5869\u5316\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_bromide",
    cation: "lithium",
    anion: "bromide",
    formula: "LiBr",
    name: "\u81ED\u5316\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_iodide",
    cation: "lithium",
    anion: "iodide",
    formula: "LiI",
    name: "\u30E8\u30A6\u5316\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_oxide",
    cation: "lithium",
    anion: "oxide",
    formula: "Li2O",
    name: "\u9178\u5316\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_sulfide",
    cation: "lithium",
    anion: "sulfide",
    formula: "Li2S",
    name: "\u786B\u5316\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_hydroxide",
    cation: "lithium",
    anion: "hydroxide",
    formula: "LiOH",
    name: "\u6C34\u9178\u5316\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_nitrate",
    cation: "lithium",
    anion: "nitrate",
    formula: "LiNO3",
    name: "\u785D\u9178\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_sulfate",
    cation: "lithium",
    anion: "sulfate",
    formula: "Li2SO4",
    name: "\u786B\u9178\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_carbonate",
    cation: "lithium",
    anion: "carbonate",
    formula: "Li2CO3",
    name: "\u70AD\u9178\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_phosphate",
    cation: "lithium",
    anion: "phosphate",
    formula: "Li3PO4",
    name: "\u30EA\u30F3\u9178\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_acetate",
    cation: "lithium",
    anion: "acetate",
    formula: "CH3COOLi",
    name: "\u9162\u9178\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    acceptedFormulaVariants: [{ formula: "LiCH3COO", note: "\u9162\u9178\u5869\u306F\u793A\u6027\u5F0FCH\u2083COOLi\u3067\u306E\u8868\u8A18\u3092\u63A8\u5968\u3057\u307E\u3059\u3002" }],
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "lithium_nitride",
    cation: "lithium",
    anion: "nitride",
    formula: "Li3N",
    name: "\u7A92\u5316\u30EA\u30C1\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "magnesium_nitride",
    cation: "magnesium",
    anion: "nitride",
    formula: "Mg3N2",
    name: "\u7A92\u5316\u30DE\u30B0\u30CD\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "calcium_nitride",
    cation: "calcium",
    anion: "nitride",
    formula: "Ca3N2",
    name: "\u7A92\u5316\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "barium_nitride",
    cation: "barium",
    anion: "nitride",
    formula: "Ba3N2",
    name: "\u7A92\u5316\u30D0\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "zinc_nitride",
    cation: "zinc",
    anion: "nitride",
    formula: "Zn3N2",
    name: "\u7A92\u5316\u4E9C\u925B",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "aluminum_nitride",
    cation: "aluminum",
    anion: "nitride",
    formula: "AlN",
    name: "\u7A92\u5316\u30A2\u30EB\u30DF\u30CB\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: { nameToFormula: true, formulaToName: true, ionsToFormula: true, ionsToName: true }
  },
  {
    id: "chromium3_chloride",
    cation: "chromium3",
    anion: "chloride",
    formula: "CrCl3",
    name: "\u5869\u5316\u30AF\u30ED\u30E0(\u2162)",
    solidColor: null,
    solidColorNote: "\u7121\u6C34\u7269\u3068\u6C34\u548C\u7269\u3067\u8272\u304C\u7570\u306A\u308B",
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24808",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "manganese2_chloride",
    cation: "manganese2",
    anion: "chloride",
    formula: "MnCl2",
    name: "\u5869\u5316\u30DE\u30F3\u30AC\u30F3(\u2161)",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24480",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "tin2_chloride",
    cation: "tin2",
    anion: "chloride",
    formula: "SnCl2",
    name: "\u5869\u5316\u30B9\u30BA(\u2161)",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24479",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "tin4_chloride",
    cation: "tin4",
    anion: "chloride",
    formula: "SnCl4",
    name: "\u5869\u5316\u30B9\u30BA(\u2163)",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24287",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "gold3_chloride",
    cation: "gold3",
    anion: "chloride",
    formula: "AuCl3",
    name: "\u5869\u5316\u91D1(\u2162)",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/26030",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "sodium_sulfite",
    cation: "sodium",
    anion: "sulfite",
    formula: "Na2SO3",
    name: "\u4E9C\u786B\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24437",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "sodium_nitrite",
    cation: "sodium",
    anion: "nitrite",
    formula: "NaNO2",
    name: "\u4E9C\u785D\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/23668193",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "sodium_hypochlorite",
    cation: "sodium",
    anion: "hypochlorite",
    formula: "NaClO",
    name: "\u6B21\u4E9C\u5869\u7D20\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: "\u901A\u5E38\u306F\u6C34\u6EB6\u6DB2\u3068\u3057\u3066\u6271\u308F\u308C\u308B",
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/23665760",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "potassium_chlorate",
    cation: "potassium",
    anion: "chlorate",
    formula: "KClO3",
    name: "\u5869\u7D20\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/6426889",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "sodium_thiosulfate",
    cation: "sodium",
    anion: "thiosulfate",
    formula: "Na2S2O3",
    name: "\u30C1\u30AA\u786B\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: "\u7121\u6C34\u5869\u3002\u4E00\u822C\u7684\u306A\u7D50\u6676\u306F\u4E94\u6C34\u548C\u7269",
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24477",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "potassium_thiocyanate",
    cation: "potassium",
    anion: "thiocyanate",
    formula: "KSCN",
    name: "\u30C1\u30AA\u30B7\u30A2\u30F3\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/516872",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "potassium_cyanide",
    cation: "potassium",
    anion: "cyanide",
    formula: "KCN",
    name: "\u30B7\u30A2\u30F3\u5316\u30AB\u30EA\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/9032",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "potassium_iodate",
    cation: "potassium",
    anion: "iodate",
    formula: "KIO3",
    name: "\u30E8\u30A6\u7D20\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/23665710",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "potassium_permanganate",
    cation: "potassium",
    anion: "permanganate",
    formula: "KMnO4",
    name: "\u904E\u30DE\u30F3\u30AC\u30F3\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: "\u6697\u7D2B\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/516875",
    enabled: true,
    questionModes: {
      ionsToFormula: true,
      ionsToName: true,
      ionNamesToFormula: true,
      ionNamesToName: true
    }
  },
  {
    id: "potassium_chromate",
    cation: "potassium",
    anion: "chromate",
    formula: "K2CrO4",
    name: "\u30AF\u30ED\u30E0\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: "\u9EC4\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24597",
    enabled: true,
    questionModes: {
      ionsToFormula: true,
      ionsToName: true,
      ionNamesToFormula: true,
      ionNamesToName: true
    }
  },
  {
    id: "potassium_dichromate",
    cation: "potassium",
    anion: "dichromate",
    formula: "K2Cr2O7",
    name: "\u4E8C\u30AF\u30ED\u30E0\u9178\u30AB\u30EA\u30A6\u30E0",
    solidColor: "\u6A59\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24502",
    enabled: true,
    questionModes: {
      ionsToFormula: true,
      ionsToName: true,
      ionNamesToFormula: true,
      ionNamesToName: true
    }
  },
  {
    id: "iron2_chloride",
    cation: "iron2",
    anion: "chloride",
    formula: "FeCl2",
    name: "\u5869\u5316\u9244(\u2161)",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron3_chloride",
    cation: "iron3",
    anion: "chloride",
    formula: "FeCl3",
    name: "\u5869\u5316\u9244(\u2162)",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron2_oxide",
    cation: "iron2",
    anion: "oxide",
    formula: "FeO",
    name: "\u9178\u5316\u9244(\u2161)",
    solidColor: "\u9ED2\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron3_oxide",
    cation: "iron3",
    anion: "oxide",
    formula: "Fe2O3",
    name: "\u9178\u5316\u9244(\u2162)",
    solidColor: "\u8D64\u8910\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron2_sulfide",
    cation: "iron2",
    anion: "sulfide",
    formula: "FeS",
    name: "\u786B\u5316\u9244(\u2161)",
    solidColor: "\u9ED2\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron2_sulfate",
    cation: "iron2",
    anion: "sulfate",
    formula: "FeSO4",
    name: "\u786B\u9178\u9244(\u2161)",
    solidColor: null,
    solidColorNote: "\u6C34\u548C\u72B6\u614B\u306B\u3088\u308A\u7570\u306A\u308B",
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron3_sulfate",
    cation: "iron3",
    anion: "sulfate",
    formula: "Fe2(SO4)3",
    name: "\u786B\u9178\u9244(\u2162)",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron2_nitrate",
    cation: "iron2",
    anion: "nitrate",
    formula: "Fe(NO3)2",
    name: "\u785D\u9178\u9244(\u2161)",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron3_nitrate",
    cation: "iron3",
    anion: "nitrate",
    formula: "Fe(NO3)3",
    name: "\u785D\u9178\u9244(\u2162)",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron2_hydroxide",
    cation: "iron2",
    anion: "hydroxide",
    formula: "Fe(OH)2",
    name: "\u6C34\u9178\u5316\u9244(\u2161)",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "iron3_hydroxide",
    cation: "iron3",
    anion: "hydroxide",
    formula: null,
    name: "\u6C34\u9178\u5316\u9244(\u2162)",
    solidColor: "\u8D64\u8910\u8272",
    solidColorNote: "\u6C88\u6BBF",
    enabled: true,
    questionModes: {
      nameToFormula: false,
      formulaToName: false,
      ionsToFormula: false,
      ionsToName: true
    }
  },
  {
    id: "copper1_chloride",
    cation: "copper1",
    anion: "chloride",
    formula: "CuCl",
    name: "\u5869\u5316\u9285(\u2160)",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "copper2_chloride",
    cation: "copper2",
    anion: "chloride",
    formula: "CuCl2",
    name: "\u5869\u5316\u9285(\u2161)",
    solidColor: null,
    solidColorNote: "\u6C34\u548C\u72B6\u614B\u306B\u3088\u308A\u7570\u306A\u308B",
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "copper1_oxide",
    cation: "copper1",
    anion: "oxide",
    formula: "Cu2O",
    name: "\u9178\u5316\u9285(\u2160)",
    solidColor: "\u8D64\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "copper2_oxide",
    cation: "copper2",
    anion: "oxide",
    formula: "CuO",
    name: "\u9178\u5316\u9285(\u2161)",
    solidColor: "\u9ED2\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "copper1_sulfide",
    cation: "copper1",
    anion: "sulfide",
    formula: "Cu2S",
    name: "\u786B\u5316\u9285(\u2160)",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "copper2_sulfide",
    cation: "copper2",
    anion: "sulfide",
    formula: "CuS",
    name: "\u786B\u5316\u9285(\u2161)",
    solidColor: "\u9ED2\u8272",
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "copper2_sulfate",
    cation: "copper2",
    anion: "sulfate",
    formula: "CuSO4",
    name: "\u786B\u9178\u9285(\u2161)",
    solidColor: null,
    solidColorNote: "\u7121\u6C34\u5869\u3068\u6C34\u548C\u7269\u3067\u8272\u304C\u7570\u306A\u308B",
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "copper2_nitrate",
    cation: "copper2",
    anion: "nitrate",
    formula: "Cu(NO3)2",
    name: "\u785D\u9178\u9285(\u2161)",
    solidColor: null,
    solidColorNote: null,
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "copper2_hydroxide",
    cation: "copper2",
    anion: "hydroxide",
    formula: "Cu(OH)2",
    name: "\u6C34\u9178\u5316\u9285(\u2161)",
    solidColor: "\u9752\u8272",
    solidColorNote: "\u6C88\u6BBF",
    enabled: true,
    questionModes: {
      nameToFormula: true,
      formulaToName: true,
      ionsToFormula: true,
      ionsToName: true
    }
  },
  {
    id: "silver_chromate",
    cation: "silver",
    anion: "chromate",
    formula: "Ag2CrO4",
    name: "\u30AF\u30ED\u30E0\u9178\u9280",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/62666",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "chromium3_oxide",
    cation: "chromium3",
    anion: "oxide",
    formula: "Cr2O3",
    name: "\u9178\u5316\u30AF\u30ED\u30E0(\u2162)",
    solidColor: "\u7DD1\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Chromium_III_-oxide-_Cr2O3",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "manganese2_oxide",
    cation: "manganese2",
    anion: "oxide",
    formula: "MnO",
    name: "\u9178\u5316\u30DE\u30F3\u30AC\u30F3(\u2161)",
    solidColor: "\u7DD1\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/1344-43-0",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "tin2_sulfide",
    cation: "tin2",
    anion: "sulfide",
    formula: "SnS",
    name: "\u786B\u5316\u30B9\u30BA(\u2161)",
    solidColor: "\u8910\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Tin_II_-sulfide",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "manganese2_sulfide",
    cation: "manganese2",
    anion: "sulfide",
    formula: "MnS",
    name: "\u786B\u5316\u30DE\u30F3\u30AC\u30F3(\u2161)",
    solidColor: "\u6DE1\u8D64\u8272",
    solidColorNote: "\u6C88\u6BBF",
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Manganese-sulfide-_MNS",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_fluoride",
    cation: "lead2",
    anion: "fluoride",
    formula: "PbF2",
    name: "\u30D5\u30C3\u5316\u925B(\u2161)",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-fluoride",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead4_fluoride",
    cation: "lead4",
    anion: "fluoride",
    formula: "PbF4",
    name: "\u30D5\u30C3\u5316\u925B(\u2163)",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/lead_IV_-fluoride",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_oxide",
    cation: "lead2",
    anion: "oxide",
    formula: "PbO",
    name: "\u9178\u5316\u925B(\u2161)",
    solidColor: "\u9EC4\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-monoxide",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_sulfide",
    cation: "lead2",
    anion: "sulfide",
    formula: "PbS",
    name: "\u786B\u5316\u925B(\u2161)",
    solidColor: "\u9ED2\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-sulfide-_PbS",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_chloride",
    cation: "lead2",
    anion: "chloride",
    formula: "PbCl2",
    name: "\u5869\u5316\u925B(\u2161)",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/7758-95-4",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_bromide",
    cation: "lead2",
    anion: "bromide",
    formula: "PbBr2",
    name: "\u81ED\u5316\u925B(\u2161)",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-bromide-_PbBr2",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_iodide",
    cation: "lead2",
    anion: "iodide",
    formula: "PbI2",
    name: "\u30E8\u30A6\u5316\u925B(\u2161)",
    solidColor: "\u9EC4\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-iodide",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_nitrate",
    cation: "lead2",
    anion: "nitrate",
    formula: "Pb(NO3)2",
    name: "\u785D\u9178\u925B(\u2161)",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-nitrate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_sulfate",
    cation: "lead2",
    anion: "sulfate",
    formula: "PbSO4",
    name: "\u786B\u9178\u925B(\u2161)",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-sulfate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_carbonate",
    cation: "lead2",
    anion: "carbonate",
    formula: "PbCO3",
    name: "\u70AD\u9178\u925B(\u2161)",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-carbonate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead2_chromate",
    cation: "lead2",
    anion: "chromate",
    formula: "PbCrO4",
    name: "\u30AF\u30ED\u30E0\u9178\u925B(\u2161)",
    solidColor: "\u9EC4\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/lead_chromate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "chromium3_sulfide",
    cation: "chromium3",
    anion: "sulfide",
    formula: "Cr2S3",
    name: "\u786B\u5316\u30AF\u30ED\u30E0(\u2162)",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/159397",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "chromium3_sulfate",
    cation: "chromium3",
    anion: "sulfate",
    formula: "Cr2(SO4)3",
    name: "\u786B\u9178\u30AF\u30ED\u30E0(\u2162)",
    solidColor: null,
    solidColorNote: "\u7121\u6C34\u7269\u3068\u6C34\u548C\u7269\u3067\u8272\u304C\u7570\u306A\u308B",
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/24930",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "manganese2_sulfate",
    cation: "manganese2",
    anion: "sulfate",
    formula: "MnSO4",
    name: "\u786B\u9178\u30DE\u30F3\u30AC\u30F3(\u2161)",
    solidColor: null,
    solidColorNote: "\u7121\u6C34\u7269\u3068\u6C34\u548C\u7269\u3067\u8272\u304C\u7570\u306A\u308B",
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Manganese-sulfate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "manganese2_carbonate",
    cation: "manganese2",
    anion: "carbonate",
    formula: "MnCO3",
    name: "\u70AD\u9178\u30DE\u30F3\u30AC\u30F3(\u2161)",
    solidColor: "\u6DE1\u8D64\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/598-62-9",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "tin2_oxide",
    cation: "tin2",
    anion: "oxide",
    formula: "SnO",
    name: "\u9178\u5316\u30B9\u30BA(\u2161)",
    solidColor: "\u9ED2\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Tin%28II%29%20oxide",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "tin4_sulfide",
    cation: "tin4",
    anion: "sulfide",
    formula: "SnS2",
    name: "\u786B\u5316\u30B9\u30BA(\u2163)",
    solidColor: "\u9EC4\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Tin-sulfide-_SnS2",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "tin2_sulfate",
    cation: "tin2",
    anion: "sulfate",
    formula: "SnSO4",
    name: "\u786B\u9178\u30B9\u30BA(\u2161)",
    solidColor: null,
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Stannous-sulfate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "sodium_permanganate",
    cation: "sodium",
    anion: "permanganate",
    formula: "NaMnO4",
    name: "\u904E\u30DE\u30F3\u30AC\u30F3\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u7D2B\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Sodium-Permanganate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "sodium_chromate",
    cation: "sodium",
    anion: "chromate",
    formula: "Na2CrO4",
    name: "\u30AF\u30ED\u30E0\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u9EC4\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Sodium-chromate-solution",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "sodium_dichromate",
    cation: "sodium",
    anion: "dichromate",
    formula: "Na2Cr2O7",
    name: "\u4E8C\u30AF\u30ED\u30E0\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
    solidColor: "\u6A59\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/25408",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "barium_chromate",
    cation: "barium",
    anion: "chromate",
    formula: "BaCrO4",
    name: "\u30AF\u30ED\u30E0\u9178\u30D0\u30EA\u30A6\u30E0",
    solidColor: "\u9EC4\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/barium%20chromate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "calcium_hypochlorite",
    cation: "calcium",
    anion: "hypochlorite",
    formula: "Ca(ClO)2",
    name: "\u6B21\u4E9C\u5869\u7D20\u9178\u30AB\u30EB\u30B7\u30A6\u30E0",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Calcium-hypochlorite",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "silver_cyanide",
    cation: "silver",
    anion: "cyanide",
    formula: "AgCN",
    name: "\u30B7\u30A2\u30F3\u5316\u9280",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/10475",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "silver_thiocyanate",
    cation: "silver",
    anion: "thiocyanate",
    formula: "AgSCN",
    name: "\u30C1\u30AA\u30B7\u30A2\u30F3\u9178\u9280",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Silver-thiocyanate",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "lead4_oxide",
    cation: "lead4",
    anion: "oxide",
    formula: "PbO2",
    name: "\u9178\u5316\u925B(\u2163)",
    solidColor: "\u8910\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/Lead-dioxide",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  },
  {
    id: "tin4_oxide",
    cation: "tin4",
    anion: "oxide",
    formula: "SnO2",
    name: "\u9178\u5316\u30B9\u30BA(\u2163)",
    solidColor: "\u767D\u8272",
    solidColorNote: null,
    difficulty: "hard",
    referenceUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/tin%28IV%29%20oxide",
    enabled: true,
    questionModes: { ionsToFormula: true, ionsToName: true, ionNamesToFormula: true, ionNamesToName: true }
  }
];

// src/games/ionic-formula/data/complex-chemistry.json
var complex_chemistry_default = {
  schemaVersion: 3,
  contentVersion: "complex-ions-2026-10-02",
  migrationVersion: 2,
  supportIons: [
    {
      id: "hydrogen",
      formula: "H",
      charge: 1,
      name: "\u6C34\u7D20\u30A4\u30AA\u30F3",
      type: "cation",
      atomicity: "monatomic",
      requiresOxidationNumeral: false,
      enabled: true,
      ionQuestionEnabled: false,
      chemistryClass: "support",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Counterion support for the two catalogued acids; disabled as an independent ion question."
      }
    }
  ],
  ions: [
    {
      id: "complex_ag_nh3_2",
      formula: "[Ag(NH3)2]",
      charge: 1,
      name: "\u30B8\u30A2\u30F3\u30DF\u30F3\u9280(I)\u30A4\u30AA\u30F3",
      type: "cation",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Ag",
        oxidationState: 1,
        ligands: [
          {
            formula: "NH3",
            charge: 0,
            count: 2,
            denticity: 1
          }
        ],
        coordinationNumber: 2
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_cu_nh3_4",
      formula: "[Cu(NH3)4]",
      charge: 2,
      name: "\u30C6\u30C8\u30E9\u30A2\u30F3\u30DF\u30F3\u9285(II)\u30A4\u30AA\u30F3",
      type: "cation",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Cu",
        oxidationState: 2,
        ligands: [
          {
            formula: "NH3",
            charge: 0,
            count: 4,
            denticity: 1
          }
        ],
        coordinationNumber: 4
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_zn_nh3_4",
      formula: "[Zn(NH3)4]",
      charge: 2,
      name: "\u30C6\u30C8\u30E9\u30A2\u30F3\u30DF\u30F3\u4E9C\u925B(II)\u30A4\u30AA\u30F3",
      type: "cation",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Zn",
        oxidationState: 2,
        ligands: [
          {
            formula: "NH3",
            charge: 0,
            count: 4,
            denticity: 1
          }
        ],
        coordinationNumber: 4
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_al_oh_4",
      formula: "[Al(OH)4]",
      charge: -1,
      name: "\u30C6\u30C8\u30E9\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u30A2\u30EB\u30DF\u30F3\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: false,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Al",
        oxidationState: 3,
        ligands: [
          {
            formula: "OH",
            charge: -1,
            count: 4,
            denticity: 1
          }
        ],
        coordinationNumber: 4
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_zn_oh_4",
      formula: "[Zn(OH)4]",
      charge: -2,
      name: "\u30C6\u30C8\u30E9\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u4E9C\u925B(II)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Zn",
        oxidationState: 2,
        ligands: [
          {
            formula: "OH",
            charge: -1,
            count: 4,
            denticity: 1
          }
        ],
        coordinationNumber: 4
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_fe_cn_6_ii",
      formula: "[Fe(CN)6]",
      charge: -4,
      name: "\u30D8\u30AD\u30B5\u30B7\u30A2\u30CB\u30C9\u9244(II)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Fe",
        oxidationState: 2,
        ligands: [
          {
            formula: "CN",
            charge: -1,
            count: 6,
            denticity: 1
          }
        ],
        coordinationNumber: 6
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_fe_cn_6_iii",
      formula: "[Fe(CN)6]",
      charge: -3,
      name: "\u30D8\u30AD\u30B5\u30B7\u30A2\u30CB\u30C9\u9244(III)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Fe",
        oxidationState: 3,
        ligands: [
          {
            formula: "CN",
            charge: -1,
            count: 6,
            denticity: 1
          }
        ],
        coordinationNumber: 6
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_cu_cl_4",
      formula: "[CuCl4]",
      charge: -2,
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u9285(II)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Cu",
        oxidationState: 2,
        ligands: [
          {
            formula: "Cl",
            charge: -1,
            count: 4,
            denticity: 1
          }
        ],
        coordinationNumber: 4
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_au_cl_4",
      formula: "[AuCl4]",
      charge: -1,
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u91D1(III)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Au",
        oxidationState: 3,
        ligands: [
          {
            formula: "Cl",
            charge: -1,
            count: 4,
            denticity: 1
          }
        ],
        coordinationNumber: 4
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_pt_cl_6",
      formula: "[PtCl6]",
      charge: -2,
      name: "\u30D8\u30AD\u30B5\u30AF\u30ED\u30EA\u30C9\u767D\u91D1(IV)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: true,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "standard",
      complex: {
        centralElement: "Pt",
        oxidationState: 4,
        ligands: [
          {
            formula: "Cl",
            charge: -1,
            count: 6,
            denticity: 1
          }
        ],
        coordinationNumber: 6
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_ag_cn_2",
      formula: "[Ag(CN)2]",
      charge: -1,
      name: "\u30B8\u30B7\u30A2\u30CB\u30C9\u9280(I)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: false,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      complex: {
        centralElement: "Ag",
        oxidationState: 1,
        ligands: [
          {
            formula: "CN",
            charge: -1,
            count: 2,
            denticity: 1
          }
        ],
        coordinationNumber: 2
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_ni_nh3_6",
      formula: "[Ni(NH3)6]",
      charge: 2,
      name: "\u30D8\u30AD\u30B5\u30A2\u30F3\u30DF\u30F3\u30CB\u30C3\u30B1\u30EB(II)\u30A4\u30AA\u30F3",
      type: "cation",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: false,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      complex: {
        centralElement: "Ni",
        oxidationState: 2,
        ligands: [
          {
            formula: "NH3",
            charge: 0,
            count: 6,
            denticity: 1
          }
        ],
        coordinationNumber: 6
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_co_nh3_6",
      formula: "[Co(NH3)6]",
      charge: 3,
      name: "\u30D8\u30AD\u30B5\u30A2\u30F3\u30DF\u30F3\u30B3\u30D0\u30EB\u30C8(III)\u30A4\u30AA\u30F3",
      type: "cation",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: false,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      complex: {
        centralElement: "Co",
        oxidationState: 3,
        ligands: [
          {
            formula: "NH3",
            charge: 0,
            count: 6,
            denticity: 1
          }
        ],
        coordinationNumber: 6
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_au_cl_2",
      formula: "[AuCl2]",
      charge: -1,
      name: "\u30B8\u30AF\u30ED\u30EA\u30C9\u91D1(I)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: false,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      complex: {
        centralElement: "Au",
        oxidationState: 1,
        ligands: [
          {
            formula: "Cl",
            charge: -1,
            count: 2,
            denticity: 1
          }
        ],
        coordinationNumber: 2
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_pt_cl_4",
      formula: "[PtCl4]",
      charge: -2,
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u767D\u91D1(II)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: false,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      complex: {
        centralElement: "Pt",
        oxidationState: 2,
        ligands: [
          {
            formula: "Cl",
            charge: -1,
            count: 4,
            denticity: 1
          }
        ],
        coordinationNumber: 4
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_sn_oh_3",
      formula: "[Sn(OH)3]",
      charge: -1,
      name: "\u30C8\u30EA\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u30B9\u30BA(II)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: false,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      complex: {
        centralElement: "Sn",
        oxidationState: 2,
        ligands: [
          {
            formula: "OH",
            charge: -1,
            count: 3,
            denticity: 1
          }
        ],
        coordinationNumber: 3
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    },
    {
      id: "complex_sn_oh_6",
      formula: "[Sn(OH)6]",
      charge: -2,
      name: "\u30D8\u30AD\u30B5\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u30B9\u30BA(IV)\u9178\u30A4\u30AA\u30F3",
      type: "anion",
      atomicity: "polyatomic",
      requiresOxidationNumeral: true,
      enabled: false,
      ionQuestionEnabled: true,
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      complex: {
        centralElement: "Sn",
        oxidationState: 4,
        ligands: [
          {
            formula: "OH",
            charge: -1,
            count: 6,
            denticity: 1
          }
        ],
        coordinationNumber: 6
      },
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Charge and oxidation state reviewed; isolation and hydration not individually established."
      }
    }
  ],
  compounds: [
    {
      id: "salt_na_al_oh_4",
      formula: "Na[Al(OH)4]",
      name: "\u30C6\u30C8\u30E9\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u30A2\u30EB\u30DF\u30F3\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_al_oh_4",
      solidColor: null,
      solidColorNote: null,
      enabled: true,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "standard",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_na2_zn_oh_4",
      formula: "Na2[Zn(OH)4]",
      name: "\u30C6\u30C8\u30E9\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u4E9C\u925B(II)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_zn_oh_4",
      solidColor: null,
      solidColorNote: null,
      enabled: true,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "standard",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k4_fe_cn_6",
      formula: "K4[Fe(CN)6]",
      name: "\u30D8\u30AD\u30B5\u30B7\u30A2\u30CB\u30C9\u9244(II)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_fe_cn_6_ii",
      solidColor: null,
      solidColorNote: null,
      enabled: true,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "standard",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k3_fe_cn_6",
      formula: "K3[Fe(CN)6]",
      name: "\u30D8\u30AD\u30B5\u30B7\u30A2\u30CB\u30C9\u9244(III)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_fe_cn_6_iii",
      solidColor: null,
      solidColorNote: null,
      enabled: true,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "standard",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_ag_nh3_2_no3",
      formula: "[Ag(NH3)2]NO3",
      name: "\u785D\u9178\u30B8\u30A2\u30F3\u30DF\u30F3\u9280(I)",
      cation: "complex_ag_nh3_2",
      anion: "nitrate",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_ag_nh3_2_cl",
      formula: "[Ag(NH3)2]Cl",
      name: "\u5869\u5316\u30B8\u30A2\u30F3\u30DF\u30F3\u9280(I)",
      cation: "complex_ag_nh3_2",
      anion: "chloride",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_cu_nh3_4_so4",
      formula: "[Cu(NH3)4]SO4",
      name: "\u786B\u9178\u30C6\u30C8\u30E9\u30A2\u30F3\u30DF\u30F3\u9285(II)",
      cation: "complex_cu_nh3_4",
      anion: "sulfate",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_cu_nh3_4_no3",
      formula: "[Cu(NH3)4](NO3)2",
      name: "\u785D\u9178\u30C6\u30C8\u30E9\u30A2\u30F3\u30DF\u30F3\u9285(II)",
      cation: "complex_cu_nh3_4",
      anion: "nitrate",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_zn_nh3_4_cl",
      formula: "[Zn(NH3)4]Cl2",
      name: "\u5869\u5316\u30C6\u30C8\u30E9\u30A2\u30F3\u30DF\u30F3\u4E9C\u925B(II)",
      cation: "complex_zn_nh3_4",
      anion: "chloride",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k2_zn_oh_4",
      formula: "K2[Zn(OH)4]",
      name: "\u30C6\u30C8\u30E9\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u4E9C\u925B(II)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_zn_oh_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_na4_fe_cn_6",
      formula: "Na4[Fe(CN)6]",
      name: "\u30D8\u30AD\u30B5\u30B7\u30A2\u30CB\u30C9\u9244(II)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_fe_cn_6_ii",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_nh4_4_fe_cn_6",
      formula: "(NH4)4[Fe(CN)6]",
      name: "\u30D8\u30AD\u30B5\u30B7\u30A2\u30CB\u30C9\u9244(II)\u9178\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
      cation: "ammonium",
      anion: "complex_fe_cn_6_ii",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_na3_fe_cn_6",
      formula: "Na3[Fe(CN)6]",
      name: "\u30D8\u30AD\u30B5\u30B7\u30A2\u30CB\u30C9\u9244(III)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_fe_cn_6_iii",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_nh4_3_fe_cn_6",
      formula: "(NH4)3[Fe(CN)6]",
      name: "\u30D8\u30AD\u30B5\u30B7\u30A2\u30CB\u30C9\u9244(III)\u9178\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
      cation: "ammonium",
      anion: "complex_fe_cn_6_iii",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k_ag_cn_2",
      formula: "K[Ag(CN)2]",
      name: "\u30B8\u30B7\u30A2\u30CB\u30C9\u9280(I)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_ag_cn_2",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_na_ag_cn_2",
      formula: "Na[Ag(CN)2]",
      name: "\u30B8\u30B7\u30A2\u30CB\u30C9\u9280(I)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_ag_cn_2",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_ni_nh3_6_cl",
      formula: "[Ni(NH3)6]Cl2",
      name: "\u5869\u5316\u30D8\u30AD\u30B5\u30A2\u30F3\u30DF\u30F3\u30CB\u30C3\u30B1\u30EB(II)",
      cation: "complex_ni_nh3_6",
      anion: "chloride",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_ni_nh3_6_no3",
      formula: "[Ni(NH3)6](NO3)2",
      name: "\u785D\u9178\u30D8\u30AD\u30B5\u30A2\u30F3\u30DF\u30F3\u30CB\u30C3\u30B1\u30EB(II)",
      cation: "complex_ni_nh3_6",
      anion: "nitrate",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_co_nh3_6_cl",
      formula: "[Co(NH3)6]Cl3",
      name: "\u5869\u5316\u30D8\u30AD\u30B5\u30A2\u30F3\u30DF\u30F3\u30B3\u30D0\u30EB\u30C8(III)",
      cation: "complex_co_nh3_6",
      anion: "chloride",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_co_nh3_6_no3",
      formula: "[Co(NH3)6](NO3)3",
      name: "\u785D\u9178\u30D8\u30AD\u30B5\u30A2\u30F3\u30DF\u30F3\u30B3\u30D0\u30EB\u30C8(III)",
      cation: "complex_co_nh3_6",
      anion: "nitrate",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_co_nh3_6_br",
      formula: "[Co(NH3)6]Br3",
      name: "\u81ED\u5316\u30D8\u30AD\u30B5\u30A2\u30F3\u30DF\u30F3\u30B3\u30D0\u30EB\u30C8(III)",
      cation: "complex_co_nh3_6",
      anion: "bromide",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k2_cu_cl_4",
      formula: "K2[CuCl4]",
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u9285(II)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_cu_cl_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_nh4_2_cu_cl_4",
      formula: "(NH4)2[CuCl4]",
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u9285(II)\u9178\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
      cation: "ammonium",
      anion: "complex_cu_cl_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k_au_cl_2",
      formula: "K[AuCl2]",
      name: "\u30B8\u30AF\u30ED\u30EA\u30C9\u91D1(I)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_au_cl_2",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "unverified",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Included by user request; individual evidence for simple K/Na gold(I) salts was not verified."
      }
    },
    {
      id: "salt_na_au_cl_2",
      formula: "Na[AuCl2]",
      name: "\u30B8\u30AF\u30ED\u30EA\u30C9\u91D1(I)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_au_cl_2",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "unverified",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Included by user request; individual evidence for simple K/Na gold(I) salts was not verified."
      }
    },
    {
      id: "salt_k_au_cl_4",
      formula: "K[AuCl4]",
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u91D1(III)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_au_cl_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_na_au_cl_4",
      formula: "Na[AuCl4]",
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u91D1(III)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_au_cl_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_nh4_au_cl_4",
      formula: "NH4[AuCl4]",
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u91D1(III)\u9178\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
      cation: "ammonium",
      anion: "complex_au_cl_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k2_pt_cl_4",
      formula: "K2[PtCl4]",
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u767D\u91D1(II)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_pt_cl_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_na2_pt_cl_4",
      formula: "Na2[PtCl4]",
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u767D\u91D1(II)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_pt_cl_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_nh4_2_pt_cl_4",
      formula: "(NH4)2[PtCl4]",
      name: "\u30C6\u30C8\u30E9\u30AF\u30ED\u30EA\u30C9\u767D\u91D1(II)\u9178\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
      cation: "ammonium",
      anion: "complex_pt_cl_4",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k2_pt_cl_6",
      formula: "K2[PtCl6]",
      name: "\u30D8\u30AD\u30B5\u30AF\u30ED\u30EA\u30C9\u767D\u91D1(IV)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_pt_cl_6",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_na2_pt_cl_6",
      formula: "Na2[PtCl6]",
      name: "\u30D8\u30AD\u30B5\u30AF\u30ED\u30EA\u30C9\u767D\u91D1(IV)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_pt_cl_6",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_nh4_2_pt_cl_6",
      formula: "(NH4)2[PtCl6]",
      name: "\u30D8\u30AD\u30B5\u30AF\u30ED\u30EA\u30C9\u767D\u91D1(IV)\u9178\u30A2\u30F3\u30E2\u30CB\u30A6\u30E0",
      cation: "ammonium",
      anion: "complex_pt_cl_6",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_na2_sn_oh_6",
      formula: "Na2[Sn(OH)6]",
      name: "\u30D8\u30AD\u30B5\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u30B9\u30BA(IV)\u9178\u30CA\u30C8\u30EA\u30A6\u30E0",
      cation: "sodium",
      anion: "complex_sn_oh_6",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    },
    {
      id: "salt_k2_sn_oh_6",
      formula: "K2[Sn(OH)6]",
      name: "\u30D8\u30AD\u30B5\u30D2\u30C9\u30ED\u30AD\u30B7\u30C9\u30B9\u30BA(IV)\u9178\u30AB\u30EA\u30A6\u30E0",
      cation: "potassium",
      anion: "complex_sn_oh_6",
      solidColor: null,
      solidColorNote: null,
      enabled: false,
      questionModes: {
        nameToFormula: true,
        formulaToName: true,
        ionsToFormula: true,
        ionsToName: true,
        ionNamesToFormula: true,
        ionNamesToName: true
      },
      chemistryClass: "complex",
      curriculumLevel: "advanced",
      evidence: {
        status: "composition_reviewed",
        sourceDocument: "docs/COMPLEX_IONS_USER_CATALOG.md",
        note: "Composition formula for learning; hydration and isolation form not individually established."
      }
    }
  ],
  retiredCompoundIds: [
    "acid_h_au_cl_4",
    "acid_h2_pt_cl_6"
  ]
};

// src/games/ionic-formula/shared/complex-policy.ts
var CHEMISTRY_CONTENT_VERSION = "complex-ions-2026-10-02";
function isComplexItem(item, ionById2 = /* @__PURE__ */ new Map()) {
  return item.chemistryClass === "complex" || !!item.formula?.includes("[") || [item.cation, item.anion].some((id) => !!id && ionById2.get(id)?.chemistryClass === "complex");
}
function complexItemAllowed(item, enabled, ionById2) {
  return !isComplexItem(item, ionById2) || enabled === true;
}

// src/games/ionic-formula/shared/question-profile.ts
var ions = [...ions_default, ...complex_chemistry_default.supportIons, ...complex_chemistry_default.ions];
var ionMap = new Map(ions.map((i) => [i.id, i]));
function defaultDifficulty(i) {
  return !i.enabled ? "off" : i.difficulty === "normal" || i.difficulty === "hard" ? i.difficulty : "both";
}
function gcd(a, b) {
  return b ? gcd(b, a % b) : Math.abs(a);
}
function questionProfileCatalog() {
  return {
    ions: ions.filter((i) => !("ionQuestionEnabled" in i) || i.ionQuestionEnabled !== false).map((i) => ({ id: i.id, formula: `${i.formula}${Math.abs(i.charge) === 1 ? "" : Math.abs(i.charge)}${i.charge > 0 ? "+" : "-"}`, name: i.name, complex: isComplexItem(i, ionMap), category: i.requiresOxidationNumeral ? "ionVariableOx" : i.atomicity === "polyatomic" ? "ionPolyatomic" : "ionSimple", defaultDifficulty: defaultDifficulty(i) })),
    compounds: [...compounds_default, ...complex_chemistry_default.compounds].map((i) => {
      const c = ionMap.get(i.cation);
      const a = ionMap.get(i.anion);
      return { id: i.id, formula: i.formula ?? "", name: i.name, complex: isComplexItem(i, ionMap), category: c.requiresOxidationNumeral || a.requiresOxidationNumeral ? "variableOx" : c.atomicity === "polyatomic" || a.atomicity === "polyatomic" ? "polyatomic" : Math.abs(a.charge) / gcd(c.charge, a.charge) === 1 && c.charge / gcd(c.charge, a.charge) === 1 ? "simple11" : "simpleRatio", defaultDifficulty: defaultDifficulty(i) };
    })
  };
}
function freeze(x) {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
}
var DEFAULT_QUESTION_PROFILE = freeze({ version: 1, rules: { ion: { normal: { complexPercent: 10, categoryWeights: null }, hard: { complexPercent: 20, categoryWeights: null } }, compound: { normal: { complexPercent: 10, categoryWeights: null }, hard: { complexPercent: 20, categoryWeights: null } } }, ionDifficulties: {}, compoundDifficulties: {} });
function object(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new TypeError("\u51FA\u984C\u8A2D\u5B9A\u304C\u4E0D\u6B63\u3067\u3059");
  return x;
}
function keys(x, allowed, required2 = allowed) {
  if (Object.keys(x).some((k) => !allowed.includes(k)) || required2.some((k) => !Object.hasOwn(x, k))) throw new TypeError("\u51FA\u984C\u8A2D\u5B9A\u306E\u9805\u76EE\u304C\u4E0D\u6B63\u3067\u3059");
}
function validateQuestionProfileShape(raw) {
  const p = object(raw);
  keys(p, ["version", "rules", "ionDifficulties", "compoundDifficulties"]);
  if (p.version !== 1) throw new TypeError("\u51FA\u984C\u8A2D\u5B9A\u306E\u7248\u304C\u4E0D\u6B63\u3067\u3059");
  const rules = object(p.rules);
  keys(rules, ["ion", "compound"]);
  const catalog = questionProfileCatalog();
  for (const mode of ["ion", "compound"]) {
    const levels = object(rules[mode]);
    keys(levels, ["normal", "hard"]);
    for (const level of ["normal", "hard"]) {
      const r = object(levels[level]);
      keys(r, ["complexPercent", "categoryWeights"]);
      if (!Number.isInteger(r.complexPercent) || Number(r.complexPercent) < (level === "hard" ? 20 : 0) || Number(r.complexPercent) > 100) throw new TypeError("\u932F\u30A4\u30AA\u30F3\u306E\u5272\u5408\u304C\u4E0D\u6B63\u3067\u3059");
      if (r.categoryWeights !== null) {
        const w = object(r.categoryWeights);
        const categories = mode === "ion" ? ["ionSimple", "ionPolyatomic", "ionVariableOx"] : ["simple11", "simpleRatio", "polyatomic", "variableOx"];
        keys(w, categories, []);
        if (Object.values(w).some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e4) || Object.values(w).reduce((s, v) => s + Number(v), 0) <= 0) throw new TypeError("\u30AB\u30C6\u30B4\u30EA\u306E\u91CD\u307F\u304C\u4E0D\u6B63\u3067\u3059");
      }
    }
    const overrides = object(p[mode === "ion" ? "ionDifficulties" : "compoundDifficulties"]);
    const ids = new Set((mode === "ion" ? catalog.ions : catalog.compounds).map((i) => i.id));
    if (Object.entries(overrides).some(([id, v]) => !ids.has(id) || (typeof v !== "string" || !["normal", "hard", "both", "off"].includes(v)))) throw new TypeError("\u6559\u6750\u306E\u96E3\u6613\u5EA6\u304C\u4E0D\u6B63\u3067\u3059");
  }
  return structuredClone(p);
}

// src/persistence/question-profiles.ts
async function readQuestionProfile(database) {
  const row = await database.prepare("SELECT profile_json, revision FROM question_profiles WHERE id = 1").first();
  return row ? { profile: validateQuestionProfileShape(JSON.parse(row.profile_json)), revision: row.revision } : { profile: structuredClone(DEFAULT_QUESTION_PROFILE), revision: 0 };
}
async function readRoomQuestionProfile(database, roomId) {
  const row = await database.prepare("SELECT profile_json FROM room_question_profiles WHERE room_id = ?").bind(roomId).first();
  return row ? validateQuestionProfileShape(JSON.parse(row.profile_json)) : null;
}
async function updateQuestionProfile(database, input) {
  const receipt2 = async () => {
    const row = await database.prepare("SELECT body_hash, result_json FROM question_profile_receipts WHERE teacher_id = ? AND request_id = ?").bind(input.teacherId, input.requestId).first();
    if (!row) return null;
    if (row.body_hash !== input.bodyHash) throw new PersistenceConflictError("request_id_reused", "\u64CD\u4F5CID\u304C\u5225\u306E\u5909\u66F4\u306B\u4F7F\u308F\u308C\u3066\u3044\u307E\u3059");
    return JSON.parse(row.result_json);
  };
  const previous = await receipt2();
  if (previous) return previous;
  const result = { profile: input.profile, revision: input.expectedRevision + 1 };
  const marker = commandMarker(`question-profile:${input.teacherId}`, input.requestId);
  const statements = [
    database.prepare("INSERT INTO question_profiles (id, profile_json, revision, updated_at_ms) VALUES (1, ?, 0, 0) ON CONFLICT(id) DO NOTHING").bind(json(DEFAULT_QUESTION_PROFILE)),
    database.prepare(`UPDATE question_profiles SET profile_json = ?, revision = revision + 1, updated_at_ms = ?, last_command_id = ? WHERE id = 1 AND revision = ? AND NOT EXISTS (SELECT 1 FROM question_profile_receipts WHERE teacher_id = ? AND request_id = ?)`).bind(json(input.profile), input.nowMs, marker, input.expectedRevision, input.teacherId, input.requestId),
    database.prepare(`INSERT INTO question_profile_receipts (teacher_id, request_id, body_hash, result_json) SELECT ?, ?, ?, ? FROM question_profiles WHERE id = 1 AND last_command_id = ?`).bind(input.teacherId, input.requestId, input.bodyHash, json(result), marker)
  ];
  try {
    const batch = await database.batch(statements);
    if (changed(batch[1])) return result;
  } catch (error) {
    const committed = await receipt2();
    if (committed) return committed;
    throw error;
  }
  const raced = await receipt2();
  if (raced) return raced;
  throw new PersistenceConflictError("stale_question_profile", "\u8A2D\u5B9A\u304C\u66F4\u65B0\u3055\u308C\u307E\u3057\u305F\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u3066\u304F\u3060\u3055\u3044");
}

// src/platform/server-only.ts
if (typeof document !== "undefined") {
  throw new Error("This module is server-only");
}

// src/competition-core/state-machine.ts
function effectiveRoomState(room, nowMs) {
  if (room.storedState === "CANCELLED" || room.storedState === "EXPIRED") {
    return room.storedState;
  }
  if (room.storedState === "FINISHED") return "FINISHED";
  if ((room.storedState === "COUNTDOWN" || room.storedState === "RUNNING") && room.deadlineAtMs != null && nowMs >= room.deadlineAtMs) {
    return "FINISHED";
  }
  if (room.storedState === "COUNTDOWN" && room.startAtMs != null && nowMs >= room.startAtMs) {
    return "RUNNING";
  }
  return room.storedState;
}

// src/config/public.ts
var PUBLIC_CONFIG = {
  questionCounts: [5, 10, 15],
  defaultQuestionCount: 10,
  timeLimitMinutes: [3, 4, 5, 6, 7, 8, 9, 10],
  defaultTimeLimitMinutes: 5,
  participantLimits: {
    classCompetition: 42,
    mateMatch: 4
  },
  retentionMs: {
    classCompetition: 7 * 24 * 60 * 60 * 1e3,
    mateMatch: 24 * 60 * 60 * 1e3,
    cancelledRoom: 24 * 60 * 60 * 1e3
  },
  waitingRoomLifetimeMs: 2 * 60 * 60 * 1e3,
  pollingMs: {
    lobby: 2e3,
    runningParticipant: 5e3,
    progress: 2e3,
    participantFinished: 3e3
  },
  countdownSeconds: 5,
  timingToleranceMs: {
    aheadOfServer: 250,
    behindServer: 2e3
  }
};

// src/games/ionic-formula/data/difficulty.json
var difficulty_default = {
  version: 4,
  categoryWeights: {
    ion: {
      normal: { ionSimple: 6, ionPolyatomic: 3, ionVariableOx: 1 },
      hard: { ionSimple: 2, ionPolyatomic: 6, ionVariableOx: 2 }
    },
    compound: {
      normal: { simple11: 3, simpleRatio: 4, polyatomic: 2, variableOx: 1 },
      hard: { simple11: 0, simpleRatio: 1, polyatomic: 5, variableOx: 4 }
    }
  },
  variantWeights: {
    ion: { ionNameToFormula: 1, ionFormulaToName: 1 },
    ionFormula: { ionsToFormula: 1, ionsToName: 1 },
    ionName: { ionNamesToFormula: 1, ionNamesToName: 1 },
    random: { ionsToFormula: 1, ionsToName: 1, ionNamesToFormula: 1, ionNamesToName: 1, mixedIonsToFormula: 1, mixedIonsToName: 1 }
  },
  weakQuestionTarget: {
    ten: 2,
    endlessPerTen: 2
  }
};

// src/games/ionic-formula/server/question-generator.ts
var ions2 = [...ions_default, ...complex_chemistry_default.supportIons, ...complex_chemistry_default.ions];
var compounds = [...compounds_default, ...complex_chemistry_default.compounds];
var difficulty = difficulty_default;
var ionById = new Map(ions2.map((ion) => [ion.id, ion]));
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}
function ionCategory(ion) {
  if (ion.requiresOxidationNumeral) return "ionVariableOx";
  return ion.atomicity === "polyatomic" ? "ionPolyatomic" : "ionSimple";
}
function compoundCategory(compound) {
  const cation = ionById.get(compound.cation);
  const anion = ionById.get(compound.anion);
  if (!cation || !anion) return null;
  if (cation.requiresOxidationNumeral || anion.requiresOxidationNumeral) return "variableOx";
  if (cation.atomicity === "polyatomic" || anion.atomicity === "polyatomic") return "polyatomic";
  const divisor = gcd2(cation.charge, anion.charge);
  return Math.abs(anion.charge) / divisor === 1 && cation.charge / divisor === 1 ? "simple11" : "simpleRatio";
}
function gcd2(a, b) {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right) [left, right] = [right, left % right];
  return left;
}
function availableAtDifficulty(item, level) {
  return !item.difficulty || item.difficulty === level;
}
function ionVariants(settings) {
  if (settings.ionAnswer === "formula") return ["ionNameToFormula"];
  if (settings.ionAnswer === "name") return ["ionFormulaToName"];
  return ["ionNameToFormula", "ionFormulaToName"];
}
function compoundVariants(settings) {
  const answers = settings.compoundAnswer === "random" ? ["Formula", "Name"] : settings.compoundAnswer === "both" ? ["Both"] : [settings.compoundAnswer === "formula" ? "Formula" : "Name"];
  const prefixes = [];
  if (settings.compoundPrompts.formula) prefixes.push("ions");
  if (settings.compoundPrompts.name) prefixes.push("ionNames");
  if (settings.compoundPrompts.formula && settings.compoundPrompts.name) prefixes.push("mixedIons");
  return prefixes.flatMap((prefix) => answers.map((answer) => `${prefix}To${answer}`));
}
function compoundSupports(compound, variant) {
  const modes = compound.questionModes ?? {};
  const formulaPrompt = variant.startsWith("ions") || variant.startsWith("mixedIons");
  const namePrompt = variant.startsWith("ionNames") || variant.startsWith("mixedIons");
  const formulaAnswer = variant.endsWith("ToFormula") || variant.endsWith("ToBoth");
  const nameAnswer = variant.endsWith("ToName") || variant.endsWith("ToBoth");
  if (formulaAnswer && !compound.formula) return false;
  const formulaMode = Boolean(modes.ionsToFormula);
  const nameMode = Boolean(modes.ionsToName);
  const namedFormulaMode = Boolean(modes.ionNamesToFormula ?? modes.ionsToFormula);
  const namedNameMode = Boolean(modes.ionNamesToName ?? modes.ionsToName);
  return (!formulaPrompt || (!formulaAnswer || formulaMode) && (!nameAnswer || nameMode)) && (!namePrompt || (!formulaAnswer || namedFormulaMode) && (!nameAnswer || namedNameMode));
}
function legacyCandidates(settings) {
  const weights = difficulty.categoryWeights[settings.mode][settings.difficulty];
  if (settings.mode === "ion") {
    return ions2.filter((ion) => ion.enabled && ion.ionQuestionEnabled !== false && availableAtDifficulty(ion, settings.difficulty) && complexItemAllowed(ion, settings.complexEnabled, ionById)).map((item) => ({ item, category: ionCategory(item), variants: ionVariants(settings) })).filter((candidate) => weights[candidate.category] > 0);
  }
  const variants = compoundVariants(settings);
  return compounds.filter((compound) => compound.enabled && availableAtDifficulty(compound, settings.difficulty) && complexItemAllowed(compound, settings.complexEnabled, ionById)).map((item) => ({ item, category: compoundCategory(item), variants: variants.filter((variant) => compoundSupports(item, variant)) })).filter((candidate) => candidate.category && weights[candidate.category] > 0 && candidate.variants.length);
}
function candidates(settings, profile) {
  if (profile === null) return legacyCandidates(settings);
  const rule = profile.rules[settings.mode][settings.difficulty];
  const overrides = settings.mode === "ion" ? profile.ionDifficulties : profile.compoundDifficulties;
  const source = settings.mode === "ion" ? ions2.filter((i) => i.ionQuestionEnabled !== false) : compounds;
  return source.filter((item) => {
    const membership = overrides[item.id] ?? (!item.enabled ? "off" : item.difficulty ?? "both");
    return (membership === "both" || membership === settings.difficulty) && complexItemAllowed(item, settings.complexEnabled, ionById);
  }).map((item) => ({ item, category: "charge" in item ? ionCategory(item) : compoundCategory(item), variants: "charge" in item ? ionVariants(settings) : compoundVariants(settings).filter((v) => compoundSupports(item, v)) })).filter((c) => c.category && c.variants.length && (isComplexItem(c.item, ionById) || (rule.categoryWeights !== null ? (rule.categoryWeights[c.category] ?? 0) > 0 : Object.hasOwn(overrides, c.item.id) || difficulty.categoryWeights[settings.mode][settings.difficulty][c.category] > 0)));
}
function allocations(pool, count, weights) {
  if (pool.length < count) throw new RangeError("\u51FA\u984C\u8A2D\u5B9A\u306E\u6559\u6750\u6570\u304C\u4E0D\u8DB3\u3057\u3066\u3044\u307E\u3059");
  if (weights === null) return null;
  const categories = Object.keys(weights).filter((k) => weights[k] > 0);
  const total = categories.reduce((sum, k) => sum + weights[k], 0);
  const parts = categories.map((category) => ({ category, exact: count * weights[category] / total, count: Math.floor(count * weights[category] / total) }));
  let remaining = count - parts.reduce((sum, p) => sum + p.count, 0);
  for (const p of [...parts].sort((a, b) => b.exact - b.count - (a.exact - a.count) || a.category.localeCompare(b.category))) {
    if (remaining-- > 0) p.count++;
  }
  for (const p of parts) if (pool.filter((c) => c.category === p.category).length < p.count) throw new RangeError(`\u30AB\u30C6\u30B4\u30EA\u300C${{ ionSimple: "\u5358\u539F\u5B50\u30A4\u30AA\u30F3", ionPolyatomic: "\u591A\u539F\u5B50\u30A4\u30AA\u30F3", ionVariableOx: "\u4FA1\u6570\u304C\u5909\u308F\u308B\u30A4\u30AA\u30F3", simple11: "1\u5BFE1\u306E\u5316\u5408\u7269", simpleRatio: "\u7D44\u6210\u6BD4\u304C\u3042\u308B\u5316\u5408\u7269", polyatomic: "\u591A\u539F\u5B50\u30A4\u30AA\u30F3\u3092\u542B\u3080\u5316\u5408\u7269", variableOx: "\u4FA1\u6570\u304C\u5909\u308F\u308B\u5316\u5408\u7269" }[p.category]}\u300D\u306E\u6559\u6750\u6570\u304C\u4E0D\u8DB3\u3057\u3066\u3044\u307E\u3059`);
  return new Map(parts.map((p) => [p.category, p.count]));
}
function selectCandidates(settings, profile, random) {
  const eligible = candidates(settings, profile);
  if (profile === null) return shuffled(eligible, random).slice(0, settings.questionCount);
  const quota = settings.complexEnabled ? Math.ceil(settings.questionCount * profile.rules[settings.mode][settings.difficulty].complexPercent / 100) : 0;
  const complex = eligible.filter((c) => isComplexItem(c.item, ionById));
  const ordinary = eligible.filter((c) => !isComplexItem(c.item, ionById));
  if (complex.length < quota) throw new RangeError("\u932F\u30A4\u30AA\u30F3\u306E\u6307\u5B9A\u5272\u5408\u3092\u6E80\u305F\u3059\u6559\u6750\u6570\u304C\u4E0D\u8DB3\u3057\u3066\u3044\u307E\u3059");
  const count = settings.questionCount - quota;
  const quotas = allocations(ordinary, count, profile.rules[settings.mode][settings.difficulty].categoryWeights);
  const selected = quotas ? [...quotas].flatMap(([category, n]) => shuffled(ordinary.filter((c) => c.category === category), random).slice(0, n)) : shuffled(ordinary, random).slice(0, count);
  return shuffled([...shuffled(complex, random).slice(0, quota), ...selected], random);
}
function validateQuestionProfile(profile) {
  const valid = validateQuestionProfileShape(profile);
  for (const questionCount of [5, 10, 15]) for (const level of ["normal", "hard"]) for (const complexEnabled of [false, true]) {
    const base = { questionCount, timeLimitMinutes: 5, mode: "ion", difficulty: level, complexEnabled, ionAnswer: "random", compoundAnswer: "random", compoundPrompts: { formula: true, name: true } };
    const check = (settings) => {
      try {
        validateGameSettings(settings, valid);
      } catch (error) {
        throw new RangeError(`${settings.mode === "ion" ? "\u30A4\u30AA\u30F3" : "\u5316\u5408\u7269"}\u30FB${level === "normal" ? "\u3084\u3055\u3057\u3081" : "\u3084\u3084\u3080\u305A"}\u30FB${questionCount}\u554F\u30FB\u932F\u30A4\u30AA\u30F3${complexEnabled ? "\u3042\u308A" : "\u306A\u3057"}\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
    };
    for (const ionAnswer2 of ["formula", "name", "random"]) check({ ...base, ionAnswer: ionAnswer2 });
    for (const compoundAnswer of ["formula", "name", "random", "both"]) for (const compoundPrompts of [{ formula: true, name: false }, { formula: false, name: true }, { formula: true, name: true }]) check({ ...base, mode: "compound", compoundAnswer, compoundPrompts });
  }
}
function validateGameSettings(settings, profile = DEFAULT_QUESTION_PROFILE) {
  if (settings.complexEnabled !== void 0 && typeof settings.complexEnabled !== "boolean") throw new TypeError("\u932F\u30A4\u30AA\u30F3\u8A2D\u5B9A\u304C\u4E0D\u6B63\u3067\u3059");
  if (settings.chemistryContentVersion !== void 0 && settings.chemistryContentVersion !== CHEMISTRY_CONTENT_VERSION) throw new TypeError("\u6559\u6750\u306E\u7248\u304C\u4E0D\u6B63\u3067\u3059");
  if (settings.gradingMode !== void 0 && settings.gradingMode !== "immediate" && settings.gradingMode !== "deferred") throw new TypeError("\u5224\u5B9A\u65B9\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
  if (![5, 10, 15].includes(settings.questionCount)) throw new TypeError("\u554F\u984C\u6570\u306F5\u554F\u300110\u554F\u300115\u554F\u304B\u3089\u9078\u3093\u3067\u304F\u3060\u3055\u3044");
  if (![3, 4, 5, 6, 7, 8, 9, 10].includes(settings.timeLimitMinutes)) throw new TypeError("\u5236\u9650\u6642\u9593\u306F3\u5206\u304B\u308910\u5206\u3067\u3059");
  if (!["ion", "compound"].includes(settings.mode)) throw new TypeError("\u30E2\u30FC\u30C9\u304C\u4E0D\u6B63\u3067\u3059");
  if (!["normal", "hard"].includes(settings.difficulty)) throw new TypeError("\u96E3\u6613\u5EA6\u304C\u4E0D\u6B63\u3067\u3059");
  if (settings.mode === "ion" && !["formula", "name", "random"].includes(settings.ionAnswer)) throw new TypeError("\u30A4\u30AA\u30F3\u306E\u89E3\u7B54\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
  if (settings.mode === "compound" && !settings.compoundPrompts.formula && !settings.compoundPrompts.name) throw new TypeError("\u5316\u5408\u7269\u306E\u51FA\u984C\u5F62\u5F0F\u30921\u3064\u4EE5\u4E0A\u9078\u3093\u3067\u304F\u3060\u3055\u3044");
  if (settings.mode === "compound" && !["formula", "name", "random", "both"].includes(settings.compoundAnswer)) throw new TypeError("\u5316\u5408\u7269\u306E\u89E3\u7B54\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
  const availableCount = candidates(settings, profile).length;
  selectCandidates(settings, profile, () => 0.5);
  if (availableCount < settings.questionCount) throw new RangeError(`\u3053\u306E\u8A2D\u5B9A\u3067\u306F${settings.questionCount}\u554F\u3092\u7528\u610F\u3067\u304D\u307E\u305B\u3093`);
  return { availableCount, maxScore: settings.questionCount * (settings.mode === "compound" && settings.compoundAnswer === "both" ? 2 : 1) };
}
function ionAnswer(ion) {
  const magnitude = Math.abs(ion.charge);
  return `${ion.formula}${magnitude === 1 ? "" : magnitude}${ion.charge > 0 ? "+" : "-"}`;
}
function answerFor(item, variant) {
  if ("charge" in item) {
    return variant === "ionNameToFormula" ? { type: "formula", canonical: ionAnswer(item), accepted: [] } : { type: "name", canonical: item.name, accepted: [] };
  }
  const formula = {
    type: "formula",
    canonical: item.formula,
    accepted: (item.acceptedFormulaVariants ?? []).map((entry) => typeof entry === "string" ? entry : { ...entry })
  };
  const name = { type: "name", canonical: item.name, accepted: [] };
  if (variant.endsWith("ToBoth")) return { type: "both", formula, name };
  return variant.endsWith("ToFormula") ? formula : name;
}
function promptFor(item, variant, order) {
  if ("charge" in item) {
    return variant === "ionNameToFormula" ? { kind: "ionName", values: [{ type: "name", value: item.name }] } : { kind: "ionFormula", values: [{ type: "formula", value: item.formula, charge: item.charge }] };
  }
  const cation = ionById.get(item.cation);
  const anion = ionById.get(item.anion);
  const promptType = variant.startsWith("ionNames") ? ["name", "name"] : variant.startsWith("ions") ? ["formula", "formula"] : ["formula", "name"];
  const displayed = [cation, anion].map((ion, index) => {
    const type = promptType[index];
    return { type, value: type === "formula" ? ion.formula : ion.name, ...type === "formula" ? { charge: ion.charge } : {} };
  });
  return { kind: "compoundIons", values: order === "cationFirst" ? displayed : displayed.reverse(), order };
}
function idFromRandom(random) {
  return Array.from({ length: 4 }, () => Math.floor(random() * 65536).toString(16).padStart(4, "0")).join("");
}
function generateQuestionSet(settings, random = Math.random, profile = DEFAULT_QUESTION_PROFILE) {
  validateGameSettings(settings, profile);
  const selected = selectCandidates(settings, profile, random);
  const variantCounts = /* @__PURE__ */ new Map();
  const assignedVariants = /* @__PURE__ */ new Map();
  const assignmentOrder = shuffled(selected.map((_, index) => index), random).sort((left, right) => selected[left].variants.length - selected[right].variants.length);
  for (const index of assignmentOrder) {
    const available = selected[index].variants;
    const fewest = Math.min(...available.map((variant2) => variantCounts.get(variant2) ?? 0));
    const choices = available.filter((variant2) => (variantCounts.get(variant2) ?? 0) === fewest);
    const variant = choices[Math.floor(random() * choices.length)];
    assignedVariants.set(index, variant);
    variantCounts.set(variant, fewest + 1);
  }
  const cationCount = Math.floor(settings.questionCount / 2) + (settings.questionCount % 2 && random() < 0.5 ? 1 : 0);
  const orderSlots = shuffled([
    ...Array(cationCount).fill("cationFirst"),
    ...Array(settings.questionCount - cationCount).fill("anionFirst")
  ], random);
  const result = [];
  for (let ordinal = 0; ordinal < settings.questionCount; ordinal += 1) {
    const candidate = selected[ordinal];
    const variant = assignedVariants.get(ordinal);
    const answer = answerFor(candidate.item, variant);
    const fields = answer.type === "both" ? [{ id: "formula", type: "formula" }, { id: "name", type: "name" }] : [{ id: answer.type, type: answer.type }];
    result.push({
      id: idFromRandom(random),
      ordinal,
      itemId: candidate.item.id,
      category: candidate.category,
      variant,
      prompt: promptFor(candidate.item, variant, orderSlots[ordinal]),
      fields,
      maxScore: fields.length,
      answer,
      ..."charge" in candidate.item && answer.type === "formula" ? { ionCharge: candidate.item.charge, ionFormula: candidate.item.formula } : {}
    });
  }
  return deepFreeze(result);
}
function toPublicQuestion(question, progress) {
  return deepFreeze({
    id: question.id,
    ordinal: question.ordinal,
    prompt: {
      kind: question.prompt.kind,
      values: question.prompt.values.map((value) => ({ ...value })),
      ...question.prompt.order === void 0 ? {} : { order: question.prompt.order }
    },
    fields: question.fields.map((field) => ({ ...field })),
    progress: { resolvedFieldIds: [...progress.resolvedFieldIds] }
  });
}

// src/games/ionic-formula/shared/answer-evaluator.ts
var EVALUATOR_VERSION = "ionic-formula-evaluator-1";
var SUBSCRIPT_DIGITS = {
  "\u2080": "0",
  "\u2081": "1",
  "\u2082": "2",
  "\u2083": "3",
  "\u2084": "4",
  "\u2085": "5",
  "\u2086": "6",
  "\u2087": "7",
  "\u2088": "8",
  "\u2089": "9"
};
var SUPERSCRIPT_DIGITS = {
  "\u2070": "0",
  "\xB9": "1",
  "\xB2": "2",
  "\xB3": "3",
  "\u2074": "4",
  "\u2075": "5",
  "\u2076": "6",
  "\u2077": "7",
  "\u2078": "8",
  "\u2079": "9"
};
function normalizeFormula(value) {
  return String(value ?? "").normalize("NFKC").replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (digit) => SUBSCRIPT_DIGITS[digit]).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (digit) => SUPERSCRIPT_DIGITS[digit]).replace(/[＋﹢]/g, "+").replace(/[−ー―‐‑‒–—－﹣]/g, "-").replace(/[（）]/g, (character) => character === "\uFF08" ? "(" : ")").replace(/[\s\u3000]/g, "").replace("^", "");
}
function normalizeName(value) {
  return String(value ?? "").normalize("NFKC").replace(/[（）]/g, (character) => character === "\uFF08" ? "(" : ")").replace(/[\s\u3000]/g, "");
}
function evaluateAnswer(value, specification) {
  const normalize2 = specification.type === "formula" ? normalizeFormula : normalizeName;
  const actual = normalize2(value);
  if (!actual) return { correct: false, empty: true, matchedAnswerKind: null, note: null };
  if (actual === normalize2(specification.canonical)) {
    return { correct: true, empty: false, matchedAnswerKind: "canonical", note: null };
  }
  const alternative = specification.accepted.find((entry) => actual === normalize2(typeof entry === "string" ? entry : entry.formula));
  return alternative ? {
    correct: true,
    empty: false,
    matchedAnswerKind: "acceptedAlternative",
    note: typeof alternative === "string" ? null : alternative.note ?? null
  } : { correct: false, empty: false, matchedAnswerKind: null, note: null };
}
function isFormulaEntry(value) {
  return typeof value === "object" && value !== null && Array.isArray(value.tokens);
}
function evaluateField(question, fieldId, value) {
  if (!question.fields.some((field) => field.id === fieldId)) throw new TypeError("\u3053\u306E\u554F\u984C\u306B\u5B58\u5728\u3057\u306A\u3044\u89E3\u7B54\u6B04\u3067\u3059");
  const specification = question.answer.type === "both" ? question.answer[fieldId] : question.answer;
  if (question.ionCharge !== void 0 && fieldId === "formula") {
    if (!isFormulaEntry(value)) return { correct: false, empty: !normalizeFormula(value), matchedAnswerKind: null, note: null };
    const formula = normalizeFormula(value.tokens.join(""));
    const charge = value.charge;
    const expectedMagnitude = Math.abs(question.ionCharge);
    const expectedSign = question.ionCharge > 0 ? "+" : "-";
    const empty = !formula && !charge;
    const correct = charge?.source === "chargeButton" && formula === normalizeFormula(question.ionFormula) && charge.magnitude === expectedMagnitude && charge.sign === expectedSign;
    return { correct, empty, matchedAnswerKind: correct ? "canonical" : null, note: null };
  }
  if (fieldId === "formula" && isFormulaEntry(value)) {
    const formula = value.tokens.join("");
    if (value.charge) return { correct: false, empty: false, matchedAnswerKind: null, note: null };
    return evaluateAnswer(formula, specification);
  }
  return evaluateAnswer(value, specification);
}

// src/competition-core/scoring.ts
function withFields(score, fields) {
  const values = Object.values(fields);
  return {
    ...score,
    fields,
    correctCount: values.filter((field) => field?.state === "correct").length,
    resolved: values.length > 0 && values.every((field) => field?.state === "correct" || field?.state === "passed")
  };
}
function applyFieldResult(score, fieldId, correct, elapsedMs) {
  const field = score.fields[fieldId];
  if (!field) throw new TypeError(`Unknown answer field: ${fieldId}`);
  if (field.state !== "pending") return score;
  const updated = correct ? { state: "correct", attemptCount: field.attemptCount + 1, resolvedAtMs: elapsedMs } : { state: "pending", attemptCount: field.attemptCount + 1 };
  return withFields(score, { ...score.fields, [fieldId]: updated });
}
function applyPass(score, fieldId, elapsedMs) {
  if (!score.fields[fieldId]) throw new TypeError(`Unknown answer field: ${fieldId}`);
  const fields = Object.fromEntries(
    Object.entries(score.fields).map(([currentId, field]) => [
      currentId,
      currentId === fieldId && field?.state === "pending" ? { ...field, state: "passed", resolvedAtMs: elapsedMs } : field
    ])
  );
  return withFields(score, fields);
}

// src/competition-core/timing.ts
function toCentiseconds(elapsedMs) {
  return Math.floor(elapsedMs / 10);
}
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
function acceptElapsed(input) {
  if (input.serverNowMs < input.startAtMs) {
    return { accepted: false, reason: "not_started" };
  }
  if (input.serverNowMs >= input.deadlineAtMs) {
    return { accepted: false, reason: "deadline" };
  }
  const limitMs = input.deadlineAtMs - input.startAtMs;
  const authoritativeElapsedMs = clamp(
    input.serverNowMs - input.startAtMs,
    0,
    limitMs
  );
  const fallbackElapsedMs = clamp(
    authoritativeElapsedMs,
    input.previousAcceptedElapsedMs,
    limitMs
  );
  const aheadToleranceMs = input.aheadToleranceMs ?? PUBLIC_CONFIG.timingToleranceMs.aheadOfServer;
  const behindToleranceMs = input.behindToleranceMs ?? PUBLIC_CONFIG.timingToleranceMs.behindServer;
  const clientElapsedMs = input.clientElapsedMs;
  const validClientTime = input.previousTimingSource === "client" && typeof clientElapsedMs === "number" && Number.isFinite(clientElapsedMs) && clientElapsedMs >= input.previousAcceptedElapsedMs && clientElapsedMs >= 0 && clientElapsedMs <= limitMs && clientElapsedMs - authoritativeElapsedMs <= aheadToleranceMs && authoritativeElapsedMs - clientElapsedMs <= behindToleranceMs;
  const acceptedElapsedMs = validClientTime ? clientElapsedMs : fallbackElapsedMs;
  const timingSource = validClientTime ? "client" : "server_fallback";
  return {
    accepted: true,
    acceptedElapsedMs,
    elapsedCs: toCentiseconds(acceptedElapsedMs),
    timingSource
  };
}

// src/competition-core/wait-credit.ts
function validateWaitCredit(input) {
  const { waitMs, sourceActionAtMs, nextAcceptedAtMs, previousRawElapsedMs, nextRawElapsedMs } = input;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || !Number.isSafeInteger(sourceActionAtMs)) return 0;
  if (sourceActionAtMs >= nextAcceptedAtMs || waitMs > nextAcceptedAtMs - sourceActionAtMs) return 0;
  if (waitMs > nextRawElapsedMs - previousRawElapsedMs) return 0;
  return waitMs;
}

// src/persistence/actions.ts
var ACTION_RATE_LIMIT = 120;
var ACTION_RATE_WINDOW_MS = 6e4;
var ACTION_OPERATION = "player_action";
function replayAttemptFailure(attempt, bodyHash2) {
  if (attempt.body_hash !== bodyHash2) {
    throw new PersistenceConflictError("request_id_reused", "requestId was already used with another payload");
  }
  if (attempt.outcome_code) {
    throw new PersistenceConflictError(
      attempt.outcome_code,
      "the previous rejected action was replayed",
      attempt.outcome_status ?? 409,
      attempt.retry_after_seconds ?? void 0
    );
  }
}
async function loadOperationAttempt(database, input) {
  return await database.prepare(`
    SELECT a.body_hash, a.outcome_code, a.outcome_status, a.retry_after_seconds
    FROM operation_attempts a JOIN rooms r ON r.id = a.room_id
    WHERE a.room_id = ? AND a.actor_id = ? AND a.operation = ? AND a.request_id = ?
      AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  `).bind(input.roomId, input.participantId, ACTION_OPERATION, input.requestId).first();
}
async function claimOperationAttempt(database, input) {
  const existing = await loadOperationAttempt(database, input);
  if (existing) {
    replayAttemptFailure(existing, input.bodyHash);
    return;
  }
  const claimed = await database.prepare(`
    INSERT INTO operation_attempts (
      room_id, actor_id, operation, request_id, body_hash,
      processed_at_ms, expires_at_ms
    )
    SELECT p.room_id, p.id, ?, ?, ?,
      CAST(unixepoch('subsec') * 1000 AS INTEGER), r.expires_at_ms
    FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE p.room_id = ? AND p.id = ?
      AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NOT EXISTS (
        SELECT 1 FROM operation_attempts duplicate
        WHERE duplicate.room_id = p.room_id AND duplicate.actor_id = p.id
          AND duplicate.operation = ? AND duplicate.request_id = ?
      )
      AND (
        SELECT COUNT(*) FROM operation_attempts recent
        WHERE recent.room_id = p.room_id AND recent.actor_id = p.id
          AND recent.operation = ?
          AND recent.processed_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER) - ?
      ) < ?
  `).bind(
    ACTION_OPERATION,
    input.requestId,
    input.bodyHash,
    input.roomId,
    input.participantId,
    ACTION_OPERATION,
    input.requestId,
    ACTION_OPERATION,
    ACTION_RATE_WINDOW_MS,
    ACTION_RATE_LIMIT
  ).run();
  if (changed(claimed)) return;
  const raced = await loadOperationAttempt(database, input);
  if (raced) {
    replayAttemptFailure(raced, input.bodyHash);
    return;
  }
  const rate = await database.prepare(`
    SELECT COUNT(*) AS recent_count, MIN(processed_at_ms) AS oldest_recent,
      CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
    FROM operation_attempts
    WHERE room_id = ? AND actor_id = ? AND operation = ?
      AND processed_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER) - ?
  `).bind(input.roomId, input.participantId, ACTION_OPERATION, ACTION_RATE_WINDOW_MS).first();
  if (Number(rate?.recent_count ?? 0) >= ACTION_RATE_LIMIT) {
    const nowMs = rate?.database_now_ms ?? input.serverNowMs;
    const remainingMs = Math.max(1e3, (rate?.oldest_recent ?? nowMs) + ACTION_RATE_WINDOW_MS - nowMs);
    throw new PersistenceConflictError(
      "rate_limited",
      "participant action rate limit reached",
      429,
      Math.max(1, Math.ceil(remainingMs / 1e3))
    );
  }
  const room = await database.prepare(`
    SELECT expires_at_ms,
      CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
    FROM rooms WHERE id = ?
  `).bind(input.roomId).first();
  if (room && room.expires_at_ms <= room.database_now_ms) {
    throw new PersistenceConflictError("expired", "room expired", 410);
  }
  throw new PersistenceConflictError("not_found", "participant or room not found", 404);
}
async function recordAttemptFailure(database, input, error) {
  await database.prepare(`
    UPDATE operation_attempts
    SET outcome_code = ?, outcome_status = ?, retry_after_seconds = ?
    WHERE room_id = ? AND actor_id = ? AND operation = ? AND request_id = ?
      AND body_hash = ? AND outcome_code IS NULL
  `).bind(
    error.code,
    error.status,
    error.retryAfterSeconds ?? null,
    input.roomId,
    input.participantId,
    ACTION_OPERATION,
    input.requestId,
    input.bodyHash
  ).run();
}
function scoreFromRows(rows) {
  const fields = Object.fromEntries(rows.map((field) => [field.field_id, {
    state: field.state,
    attemptCount: field.attempt_count,
    ...field.resolved_at_ms == null ? {} : { resolvedAtMs: field.resolved_at_ms }
  }]));
  return {
    fields,
    correctCount: Object.values(fields).filter((field) => field?.state === "correct").length,
    resolved: Object.values(fields).every((field) => field?.state === "correct" || field?.state === "passed")
  };
}
async function applyPlayerActionOnce(database, input) {
  const existing = await loadCommandReceipt(
    database,
    input.roomId,
    input.participantId,
    input.requestId,
    input.bodyHash
  );
  if (existing) return existing;
  const room = await database.prepare(
    "SELECT state, start_at_ms, deadline_at_ms, expires_at_ms FROM rooms WHERE id = ?"
  ).bind(input.roomId).first();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.serverNowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.start_at_ms == null || room.deadline_at_ms == null || input.serverNowMs < room.start_at_ms) {
    throw new PersistenceConflictError("invalid_state", "competition has not started");
  }
  if (input.serverNowMs >= room.deadline_at_ms) throw new PersistenceConflictError("deadline", "competition deadline reached");
  if (room.state !== "RUNNING" && room.state !== "COUNTDOWN") {
    throw new PersistenceConflictError("invalid_state", `cannot act in ${room.state}`);
  }
  const participant = await database.prepare(`
    SELECT revision, status, current_ordinal, correct_count, resolved_question_count,
      accepted_elapsed_ms, wait_credit_ms, last_action_request_id, elapsed_cs, timing_source
    FROM participants WHERE room_id = ? AND id = ?
  `).bind(input.roomId, input.participantId).first();
  if (!participant) throw new PersistenceConflictError("not_found", "participant not found", 404);
  if (participant.revision !== input.expectedParticipantRevision) {
    throw new PersistenceConflictError("stale_participant_revision", "participant revision is stale");
  }
  const question = await database.prepare(`
    SELECT question_id, ordinal, answer_snapshot_json FROM room_questions
    WHERE room_id = ? AND question_id = ?
  `).bind(input.roomId, input.questionId).first();
  if (!question || question.ordinal !== participant.current_ordinal) {
    throw new PersistenceConflictError("stale_participant_revision", "question is no longer current");
  }
  const { results: fieldRows } = await database.prepare(`
    SELECT field_id, state, resolved_at_ms, attempt_count FROM participant_fields
    WHERE room_id = ? AND participant_id = ? AND question_id = ? ORDER BY field_id
  `).bind(input.roomId, input.participantId, input.questionId).all();
  const before = scoreFromRows(fieldRows);
  if (!before.fields[input.action.fieldId] || before.fields[input.action.fieldId]?.state !== "pending") {
    throw new PersistenceConflictError("invalid_state", "answer field is already resolved");
  }
  const internalQuestion = JSON.parse(question.answer_snapshot_json);
  const evaluation = input.action.type === "answer" ? evaluateField(internalQuestion, input.action.fieldId, input.action.value) : null;
  const elapsed = acceptElapsed({
    clientElapsedMs: input.clientElapsedMs,
    serverNowMs: input.serverNowMs,
    startAtMs: room.start_at_ms,
    deadlineAtMs: room.deadline_at_ms,
    previousAcceptedElapsedMs: participant.accepted_elapsed_ms,
    previousTimingSource: participant.timing_source
  });
  if (!elapsed.accepted) throw new PersistenceConflictError(elapsed.reason === "deadline" ? "deadline" : "invalid_state", elapsed.reason);
  let addedWaitCreditMs = 0;
  if (input.waitCredit && participant.last_action_request_id === input.waitCredit.sourceRequestId) {
    const source = await database.prepare(`
      SELECT processed_at_ms FROM command_receipts
      WHERE room_id = ? AND actor_id = ? AND request_id = ? AND result_code = 'accepted'
    `).bind(input.roomId, input.participantId, input.waitCredit.sourceRequestId).first();
    if (source) addedWaitCreditMs = validateWaitCredit({
      waitMs: input.waitCredit.waitMs,
      sourceActionAtMs: participant.timing_source === "client" ? Math.min(source.processed_at_ms, room.start_at_ms + participant.accepted_elapsed_ms) : source.processed_at_ms,
      nextAcceptedAtMs: input.serverNowMs,
      previousRawElapsedMs: participant.accepted_elapsed_ms,
      nextRawElapsedMs: elapsed.acceptedElapsedMs
    });
  }
  const waitCreditMs = participant.wait_credit_ms + addedWaitCreditMs;
  const recordedElapsedCs = Math.max(participant.elapsed_cs, Math.floor((elapsed.acceptedElapsedMs - waitCreditMs) / 10));
  const after = input.action.type === "answer" ? applyFieldResult(before, input.action.fieldId, evaluation.correct, elapsed.acceptedElapsedMs) : applyPass(before, input.action.fieldId, elapsed.acceptedElapsedMs);
  const newlyResolved = !before.resolved && after.resolved;
  const nextOrdinal = participant.current_ordinal + (newlyResolved ? 1 : 0);
  const questionCountRow = await database.prepare("SELECT COUNT(*) AS count FROM room_questions WHERE room_id = ?").bind(input.roomId).first();
  const finished = newlyResolved && nextOrdinal >= Number(questionCountRow?.count ?? 0);
  const result = {
    code: "accepted",
    correct: evaluation?.correct ?? null,
    participantRevision: participant.revision + 1,
    correctCount: participant.correct_count + (after.correctCount - before.correctCount),
    resolvedQuestionCount: participant.resolved_question_count + (newlyResolved ? 1 : 0),
    currentOrdinal: nextOrdinal,
    finished,
    elapsedCs: recordedElapsedCs,
    rawElapsedMs: elapsed.acceptedElapsedMs,
    waitCreditMs,
    timingSource: elapsed.timingSource
  };
  const marker = commandMarker(input.participantId, input.requestId);
  const statements = [database.prepare(`
    UPDATE participants
    SET revision = revision + 1, last_command_id = ?, correct_count = ?,
      resolved_question_count = ?, current_ordinal = ?, status = ?, finished_at_ms = ?,
      accepted_elapsed_ms = ?, wait_credit_ms = ?, last_action_request_id = ?, elapsed_cs = ?, timing_source = ?
    WHERE room_id = ? AND id = ? AND revision = ? AND status = 'ACTIVE' AND current_ordinal = ?
      AND EXISTS (
        SELECT 1 FROM room_questions q
        WHERE q.room_id = participants.room_id AND q.question_id = ? AND q.ordinal = participants.current_ordinal
      )
      AND EXISTS (
        SELECT 1 FROM rooms r WHERE r.id = participants.room_id
          AND r.state IN ('COUNTDOWN', 'RUNNING')
          AND r.start_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND r.deadline_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      )
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts c
        WHERE c.room_id = participants.room_id AND c.actor_id = participants.id AND c.request_id = ?
      )
  `).bind(
    marker,
    result.correctCount,
    result.resolvedQuestionCount,
    result.currentOrdinal,
    finished ? "FINISHED" : "ACTIVE",
    finished ? input.serverNowMs : null,
    elapsed.acceptedElapsedMs,
    waitCreditMs,
    input.requestId,
    recordedElapsedCs,
    elapsed.timingSource,
    input.roomId,
    input.participantId,
    input.expectedParticipantRevision,
    participant.current_ordinal,
    input.questionId,
    input.requestId
  )];
  for (const [fieldId, field] of Object.entries(after.fields)) {
    if (!field) continue;
    const submitted = input.action.type === "answer" && input.action.fieldId === fieldId;
    const answerJson = submitted ? json(input.action.value) : null;
    statements.push(database.prepare(`
      UPDATE participant_fields
      SET state = ?, attempt_count = ?, resolved_at_ms = ?, last_command_id = ?,
          last_answer_json = CASE WHEN ? = 1 THEN ? ELSE last_answer_json END,
          last_answer_correct = CASE WHEN ? = 1 THEN ? ELSE last_answer_correct END
      WHERE room_id = ? AND participant_id = ? AND question_id = ? AND field_id = ?
        AND EXISTS (
          SELECT 1 FROM participants p
          WHERE p.room_id = participant_fields.room_id AND p.id = participant_fields.participant_id
            AND p.last_command_id = ?
        )
    `).bind(
      field.state,
      field.attemptCount,
      field.resolvedAtMs ?? null,
      marker,
      submitted ? 1 : 0,
      answerJson,
      submitted ? 1 : 0,
      submitted ? evaluation.correct ? 1 : 0 : null,
      input.roomId,
      input.participantId,
      input.questionId,
      fieldId,
      marker
    ));
  }
  statements.push(database.prepare(`
    INSERT INTO command_receipts (
      room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
    )
    SELECT p.room_id, p.id, ?, ?, 'accepted', ?, ?, r.expires_at_ms
    FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE p.room_id = ? AND p.id = ? AND p.last_command_id = ?
  `).bind(
    input.requestId,
    input.bodyHash,
    json(result),
    input.serverNowMs,
    input.roomId,
    input.participantId,
    marker
  ));
  const batch = await database.batch(statements);
  if (changed(batch[0])) return result;
  const raced = await loadCommandReceipt(
    database,
    input.roomId,
    input.participantId,
    input.requestId,
    input.bodyHash
  );
  if (raced) return raced;
  const latestRoom = await database.prepare(`
    SELECT state, deadline_at_ms, expires_at_ms,
      CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
    FROM rooms WHERE id = ?
  `).bind(input.roomId).first();
  if (!latestRoom || latestRoom.expires_at_ms <= latestRoom.database_now_ms) throw new PersistenceConflictError("expired", "room expired", 410);
  if (latestRoom.database_now_ms >= latestRoom.deadline_at_ms) throw new PersistenceConflictError("deadline", "competition deadline reached");
  throw new PersistenceConflictError("stale_participant_revision", "participant changed while applying the action");
}
async function applyPlayerAction(database, input) {
  const existing = await loadCommandReceipt(
    database,
    input.roomId,
    input.participantId,
    input.requestId,
    input.bodyHash
  );
  if (existing) return existing;
  await claimOperationAttempt(database, input);
  const retryStartedAt = performance.now();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const serverNowMs = attempt === 1 ? input.serverNowMs : input.retryServerNowMs?.(attempt) ?? input.serverNowMs + Math.max(0, Math.ceil(performance.now() - retryStartedAt));
    try {
      return await applyPlayerActionOnce(database, { ...input, serverNowMs });
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        const committed = await loadCommandReceipt(
          database,
          input.roomId,
          input.participantId,
          input.requestId,
          input.bodyHash
        );
        if (committed) return committed;
        await recordAttemptFailure(database, input, error);
        throw error;
      }
      if (!isRetryableDatabaseConflict(error)) throw error;
      const stored = await loadCommandReceipt(
        database,
        input.roomId,
        input.participantId,
        input.requestId,
        input.bodyHash
      );
      if (stored) return stored;
      if (attempt === 3) {
        throw new PersistenceConflictError(
          "database_conflict",
          "database conflict; retry with the same requestId",
          503
        );
      }
    }
  }
  throw new PersistenceConflictError("database_conflict", "database conflict", 503);
}

// src/persistence/cleanup.ts
async function cleanupExpired(database, input) {
  if (!Number.isInteger(input.limit) || input.limit <= 0) throw new TypeError("cleanup limit must be a positive integer");
  const { results: expiredRooms } = await database.prepare(`
    SELECT id FROM rooms WHERE expires_at_ms <= ? ORDER BY expires_at_ms, id LIMIT ?
  `).bind(input.nowMs, input.limit).all();
  const { results: expiredSiteSettingReceipts } = await database.prepare(`
    SELECT teacher_id, request_id FROM site_setting_receipts
    WHERE expires_at_ms <= ? ORDER BY expires_at_ms, teacher_id, request_id LIMIT ?
  `).bind(input.nowMs, input.limit).all();
  if (!expiredRooms.length && !expiredSiteSettingReceipts.length) {
    return { deletedRooms: 0, deletedSiteSettingReceipts: 0 };
  }
  const roomStatements = expiredRooms.map(({ id }) => database.prepare(
    "DELETE FROM rooms WHERE id = ? AND expires_at_ms <= ?"
  ).bind(id, input.nowMs));
  const siteSettingReceiptStatements = expiredSiteSettingReceipts.map(({ teacher_id: teacherId, request_id: requestId2 }) => database.prepare(`
      DELETE FROM site_setting_receipts
      WHERE teacher_id = ? AND request_id = ? AND expires_at_ms <= ?
    `).bind(teacherId, requestId2, input.nowMs));
  const deleted = await database.batch([...roomStatements, ...siteSettingReceiptStatements]);
  return {
    deletedRooms: deleted.slice(0, roomStatements.length).reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0),
    deletedSiteSettingReceipts: deleted.slice(roomStatements.length).reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0)
  };
}

// src/persistence/participants.ts
async function renameParticipant(database, input) {
  const actorId = `rename:${input.participantId}`;
  const existing = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  const result = { nickname: input.nickname, revision: input.expectedParticipantRevision + 1 };
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE participants SET nickname = ?, nickname_key = ?, revision = revision + 1, last_command_id = ?
    WHERE room_id = ? AND id = ? AND revision = ? AND status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participants.room_id AND r.state = 'WAITING'
        AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND NOT EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = r.id AND m.state != 'WAITING'))
      AND NOT EXISTS (SELECT 1 FROM command_receipts c WHERE c.room_id = participants.room_id
        AND c.actor_id = ? AND c.request_id = ?)
  `).bind(
    input.nickname,
    input.nicknameKey,
    marker,
    input.roomId,
    input.participantId,
    input.expectedParticipantRevision,
    actorId,
    input.requestId
  ), database.prepare(`
    INSERT INTO command_receipts (room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms)
    SELECT p.room_id, ?, ?, ?, 'renamed', ?, ?, r.expires_at_ms
    FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE p.room_id = ? AND p.id = ? AND p.last_command_id = ?
  `).bind(
    actorId,
    input.requestId,
    input.bodyHash,
    json(result),
    input.nowMs,
    input.roomId,
    input.participantId,
    marker
  )];
  try {
    const batch = await database.batch(statements);
    if (changed(batch[0])) return result;
  } catch (error) {
    const committed = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  const raced = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  throw new PersistenceConflictError("invalid_state", "room started or participant state changed");
}
async function loadJoinReceipt(database, input) {
  const receipt2 = await loadCommandReceipt(
    database,
    input.roomId,
    `join:${input.tokenHash}`,
    input.requestId,
    input.bodyHash
  );
  if (!receipt2) return null;
  const participant = await database.prepare(
    "SELECT status FROM participants WHERE room_id = ? AND id = ? AND token_hash = ?"
  ).bind(input.roomId, receipt2.participantId, input.tokenHash).first();
  if (!participant || participant.status === "REMOVED") {
    throw new PersistenceConflictError("not_authorized", "removed participant credentials cannot rejoin", 403);
  }
  return receipt2;
}
async function joinRoom(database, input) {
  const actorId = `join:${input.tokenHash}`;
  const existing = await loadJoinReceipt(database, input);
  if (existing) return existing;
  const room = await database.prepare("SELECT kind FROM rooms WHERE id = ?").bind(input.roomId).first();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  const capacity = room.kind === "class" ? PUBLIC_CONFIG.participantLimits.classCompetition : PUBLIC_CONFIG.participantLimits.mateMatch;
  const marker = commandMarker(actorId, input.requestId);
  const statements = [
    database.prepare(`
      UPDATE rooms
      SET revision = revision + 1, last_command_id = ?
      WHERE id = ? AND state = 'WAITING' AND expires_at_ms > ?
        AND NOT EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state != 'WAITING')
        AND (SELECT COUNT(*) FROM participants WHERE room_id = rooms.id AND status != 'REMOVED') < ?
        AND NOT EXISTS (
          SELECT 1 FROM command_receipts
          WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?
        )
    `).bind(marker, input.roomId, input.nowMs, capacity, actorId, input.requestId),
    database.prepare(`
      INSERT INTO participants (
        room_id, id, token_hash, nickname, nickname_key, joined_at_ms, joined_order
      )
      SELECT r.id, ?, ?, ?, ?, ?,
        (SELECT COUNT(*) + 1 FROM participants WHERE room_id = r.id)
      FROM rooms r WHERE r.id = ? AND r.last_command_id = ?
    `).bind(
      input.participantId,
      input.tokenHash,
      input.nickname,
      input.nicknameKey,
      input.nowMs,
      input.roomId,
      marker
    ),
    database.prepare(`
      INSERT INTO command_receipts (
        room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
      )
      SELECT r.id, ?, ?, ?, 'joined',
        json_object(
          'roomId', r.id,
          'participantId', p.id,
          'joinedOrder', p.joined_order,
          'participantRevision', p.revision
        ), ?, r.expires_at_ms
      FROM rooms r JOIN participants p ON p.room_id = r.id AND p.id = ?
      WHERE r.id = ? AND r.last_command_id = ?
    `).bind(actorId, input.requestId, input.bodyHash, input.nowMs, input.participantId, input.roomId, marker)
  ];
  try {
    const batch = await database.batch(statements);
    if (changed(batch[0])) {
      const stored = await loadJoinReceipt(database, input);
      if (stored) return stored;
    }
  } catch (error) {
    const raced2 = await loadJoinReceipt(database, input);
    if (raced2) return raced2;
    throw error;
  }
  const raced = await loadJoinReceipt(database, input);
  if (raced) return raced;
  const latest = await database.prepare(`
    SELECT state, expires_at_ms,
      (SELECT COUNT(*) FROM participants WHERE room_id = rooms.id AND status != 'REMOVED') AS participant_count
    FROM rooms WHERE id = ?
  `).bind(input.roomId).first();
  if (!latest) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (latest.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (latest.state !== "WAITING") throw new PersistenceConflictError("invalid_state", "room is no longer accepting participants");
  if (latest.participant_count >= capacity) throw new PersistenceConflictError("capacity", "room capacity reached");
  throw new PersistenceConflictError("stale_room_revision", "room changed while joining");
}
async function removeParticipant(database, input) {
  const actorId = `remove:${input.actorId}`;
  const existing = await loadCommandReceipt(
    database,
    input.roomId,
    actorId,
    input.requestId,
    input.bodyHash
  );
  if (existing) return existing;
  const result = {
    participantId: input.targetParticipantId,
    participantStatus: "REMOVED",
    participantRevision: input.expectedParticipantRevision + 1,
    roomRevision: input.expectedRoomRevision + 1
  };
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms
    SET revision = revision + 1, last_command_id = ?
    WHERE id = ? AND revision = ? AND state = 'WAITING'
      AND NOT EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state != 'WAITING')
      AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND (mate_host_id IS NULL OR mate_host_id != ?)
      AND EXISTS (
        SELECT 1 FROM participants p
        WHERE p.room_id = rooms.id AND p.id = ? AND p.status != 'REMOVED' AND p.revision = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts
        WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?
      )
  `).bind(
    marker,
    input.roomId,
    input.expectedRoomRevision,
    input.targetParticipantId,
    input.targetParticipantId,
    input.expectedParticipantRevision,
    actorId,
    input.requestId
  ), database.prepare(`
    UPDATE participants
    SET status = 'REMOVED', revision = revision + 1, last_command_id = ?
    WHERE room_id = ? AND id = ? AND revision = ? AND status != 'REMOVED'
      AND EXISTS (
        SELECT 1 FROM rooms r WHERE r.id = participants.room_id AND r.last_command_id = ?
      )
  `).bind(
    marker,
    input.roomId,
    input.targetParticipantId,
    input.expectedParticipantRevision,
    marker
  ), database.prepare(`
    INSERT INTO command_receipts (
      room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
    )
    SELECT r.id, ?, ?, ?, 'participant_removed', ?, ?, r.expires_at_ms
    FROM rooms r JOIN participants p ON p.room_id = r.id AND p.id = ?
    WHERE r.id = ? AND r.last_command_id = ? AND p.last_command_id = ?
  `).bind(
    actorId,
    input.requestId,
    input.bodyHash,
    json(result),
    input.nowMs,
    input.targetParticipantId,
    input.roomId,
    marker,
    marker
  )];
  try {
    const batch = await database.batch(statements);
    if (changed(batch[0])) return result;
  } catch (error) {
    const committed = await loadCommandReceipt(
      database,
      input.roomId,
      actorId,
      input.requestId,
      input.bodyHash
    );
    if (committed) return committed;
    throw error;
  }
  const raced = await loadCommandReceipt(
    database,
    input.roomId,
    actorId,
    input.requestId,
    input.bodyHash
  );
  if (raced) return raced;
  const latest = await database.prepare(`
    SELECT r.state, r.revision, r.expires_at_ms, r.mate_host_id,
      CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms,
      p.status AS participant_status, p.revision AS participant_revision
    FROM rooms r LEFT JOIN participants p ON p.room_id = r.id AND p.id = ?
    WHERE r.id = ?
  `).bind(input.targetParticipantId, input.roomId).first();
  if (!latest) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (latest.expires_at_ms <= latest.database_now_ms) {
    throw new PersistenceConflictError("expired", "room expired", 410);
  }
  if (latest.state !== "WAITING") {
    throw new PersistenceConflictError("invalid_state", `cannot remove a participant in ${latest.state}`);
  }
  if (latest.mate_host_id === input.targetParticipantId) {
    throw new PersistenceConflictError("not_authorized", "the mate host cannot be removed", 403);
  }
  if (latest.participant_status === null || latest.participant_status === "REMOVED") {
    throw new PersistenceConflictError("participant_not_found", "participant not found", 404);
  }
  if (latest.revision !== input.expectedRoomRevision) {
    throw new PersistenceConflictError("stale_room_revision", "room revision is stale");
  }
  if (latest.participant_revision !== input.expectedParticipantRevision) {
    throw new PersistenceConflictError("stale_participant_revision", "participant revision is stale");
  }
  throw new PersistenceConflictError("database_conflict", "participant removal did not commit");
}

// src/persistence/results.ts
async function finalizeRoom(database, input) {
  const actorId = `finalize:${input.roomId}`;
  const existing = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  const room = await database.prepare(
    "SELECT state, revision, start_at_ms, deadline_at_ms, expires_at_ms FROM rooms WHERE id = ?"
  ).bind(input.roomId).first();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.state === "FINISHED") throw new PersistenceConflictError("invalid_state", "room was finalized by another command");
  if (room.state !== "COUNTDOWN" && room.state !== "RUNNING") {
    throw new PersistenceConflictError("invalid_state", `cannot finalize ${room.state}`);
  }
  if (room.start_at_ms == null || room.deadline_at_ms == null) throw new PersistenceConflictError("invalid_state", "room has no schedule");
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms SET
      state = 'FINISHED',
      revision = revision + 1,
      ended_at_ms = CASE
        WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE')
          THEN COALESCE((SELECT MAX(p.finished_at_ms) FROM participants p WHERE p.room_id = rooms.id AND p.status = 'FINISHED'), deadline_at_ms)
        ELSE deadline_at_ms
      END,
      expires_at_ms = (CASE
        WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE')
          THEN COALESCE((SELECT MAX(p.finished_at_ms) FROM participants p WHERE p.room_id = rooms.id AND p.status = 'FINISHED'), deadline_at_ms)
        ELSE deadline_at_ms
      END) + CASE kind WHEN 'class' THEN ? ELSE ? END,
      last_command_id = ?
    WHERE id = ? AND revision = ? AND state IN ('COUNTDOWN', 'RUNNING')
      AND (
        deadline_at_ms <= ?
        OR (
          EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status != 'REMOVED')
          AND NOT EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE')
        )
      )
      AND expires_at_ms > ?
  `).bind(
    PUBLIC_CONFIG.retentionMs.classCompetition,
    PUBLIC_CONFIG.retentionMs.mateMatch,
    marker,
    input.roomId,
    room.revision,
    input.nowMs,
    input.nowMs
  )];
  statements.push(database.prepare(`
    UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO final_results (
      room_id, participant_id, correct_count, elapsed_cs, rank, finish_reason
    )
    SELECT room_id, participant_id, correct_count, effective_elapsed_cs,
      RANK() OVER (ORDER BY correct_count DESC, effective_elapsed_cs ASC), finish_reason
    FROM (
      SELECT p.room_id, p.id AS participant_id, p.correct_count,
        CASE WHEN p.status = 'FINISHED' THEN p.elapsed_cs
          ELSE CAST((r.deadline_at_ms - r.start_at_ms) / 10 AS INTEGER) END AS effective_elapsed_cs,
        CASE WHEN p.status = 'FINISHED' THEN 'completed' ELSE 'timeout' END AS finish_reason,
        p.joined_order
      FROM participants p JOIN rooms r ON r.id = p.room_id
      WHERE p.room_id = ? AND p.status != 'REMOVED' AND r.last_command_id = ?
    ) frozen
    ORDER BY correct_count DESC, effective_elapsed_cs ASC, joined_order ASC
  `).bind(input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE participant_fields SET state = 'unanswered', last_command_id = ?
    WHERE room_id = ? AND state = 'pending'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participant_fields.room_id AND r.last_command_id = ?)
  `).bind(marker, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE participants
    SET status = 'FINISHED', finished_at_ms = COALESCE(finished_at_ms, (SELECT ended_at_ms FROM rooms WHERE id = ?)),
      accepted_elapsed_ms = CASE WHEN status = 'ACTIVE' THEN (SELECT deadline_at_ms - start_at_ms FROM rooms WHERE id = ?) ELSE accepted_elapsed_ms END,
      elapsed_cs = CASE WHEN status = 'ACTIVE' THEN (SELECT CAST((deadline_at_ms - start_at_ms) / 10 AS INTEGER) FROM rooms WHERE id = ?) ELSE elapsed_cs END,
      timing_source = CASE WHEN status = 'ACTIVE' THEN 'timeout' ELSE timing_source END
    WHERE room_id = ? AND status != 'REMOVED'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participants.room_id AND r.last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO command_receipts (
      room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
    )
    SELECT id, ?, ?, ?, 'finalized',
      json_object(
        'roomId', id,
        'state', 'FINISHED',
        'endedAtMs', ended_at_ms,
        'participantCount', (SELECT COUNT(*) FROM participants p WHERE p.room_id = rooms.id AND p.status != 'REMOVED')
      ), ?, expires_at_ms FROM rooms
    WHERE id = ? AND last_command_id = ?
  `).bind(actorId, input.requestId, input.bodyHash, input.nowMs, input.roomId, marker));
  let batch;
  try {
    batch = await database.batch(statements);
  } catch (error) {
    const committed = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  if (changed(batch[0])) {
    const stored = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (stored) return stored;
  }
  const raced = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  throw new PersistenceConflictError("stale_room_revision", "room changed while finalizing");
}
async function interruptRoom(database, input) {
  const actorId = `room:${input.roomId}`;
  const existing = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms SET state = 'FINISHED', revision = revision + 1, end_reason = 'interrupted',
      ended_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER),
      expires_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?, last_command_id = ?
    WHERE id = ? AND kind = 'class' AND revision = ? AND state IN ('COUNTDOWN', 'RUNNING')
      AND start_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND deadline_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE')
  `).bind(PUBLIC_CONFIG.retentionMs.classCompetition, marker, input.roomId, input.expectedRoomRevision)];
  statements.push(database.prepare(`
    UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO final_results (room_id, participant_id, correct_count, elapsed_cs, rank, finish_reason)
    SELECT room_id, participant_id, correct_count, effective_elapsed_cs,
      RANK() OVER (ORDER BY correct_count DESC, effective_elapsed_cs ASC), finish_reason
    FROM (
      SELECT p.room_id, p.id AS participant_id, p.correct_count,
        CASE WHEN p.status = 'FINISHED' THEN p.elapsed_cs
          ELSE CAST((r.ended_at_ms - r.start_at_ms) / 10 AS INTEGER) END AS effective_elapsed_cs,
        CASE WHEN p.status = 'FINISHED' THEN 'completed' ELSE 'interrupted' END AS finish_reason,
        p.joined_order
      FROM participants p JOIN rooms r ON r.id = p.room_id
      WHERE p.room_id = ? AND p.status != 'REMOVED' AND r.last_command_id = ?
    ) frozen ORDER BY correct_count DESC, effective_elapsed_cs ASC, joined_order ASC
  `).bind(input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE participant_fields SET state = 'unanswered', last_command_id = ?
    WHERE room_id = ? AND state = 'pending'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participant_fields.room_id AND r.last_command_id = ?)
  `).bind(marker, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE participants SET status = 'FINISHED', revision = revision + CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END,
      finished_at_ms = COALESCE(finished_at_ms, (SELECT ended_at_ms FROM rooms WHERE id = ?)),
      accepted_elapsed_ms = CASE WHEN status = 'ACTIVE' THEN (SELECT ended_at_ms - start_at_ms FROM rooms WHERE id = ?) ELSE accepted_elapsed_ms END,
      elapsed_cs = CASE WHEN status = 'ACTIVE' THEN (SELECT CAST((ended_at_ms - start_at_ms) / 10 AS INTEGER) FROM rooms WHERE id = ?) ELSE elapsed_cs END,
      timing_source = CASE WHEN status = 'ACTIVE' THEN 'timeout' ELSE timing_source END
    WHERE room_id = ? AND status != 'REMOVED'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participants.room_id AND r.last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO command_receipts (room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms)
    SELECT id, ?, ?, ?, 'interrupted',
      json_object('state', 'FINISHED', 'roomRevision', revision, 'endedAtMs', ended_at_ms),
      ended_at_ms, expires_at_ms FROM rooms WHERE id = ? AND last_command_id = ?
  `).bind(actorId, input.requestId, input.bodyHash, input.roomId, marker));
  let batch;
  try {
    batch = await database.batch(statements);
  } catch (error) {
    const committed = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  if (changed(batch[0])) {
    const stored = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (stored) return stored;
  }
  const raced = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  const room = await database.prepare("SELECT state, revision, expires_at_ms FROM rooms WHERE id = ?").bind(input.roomId).first();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.revision !== input.expectedRoomRevision) throw new PersistenceConflictError("stale_room_revision", "room revision is stale");
  throw new PersistenceConflictError("invalid_state", `cannot interrupt ${room.state}`);
}
async function loadAuthorizedResult(database, input) {
  const result = await database.prepare(`
    SELECT f.participant_id, f.correct_count, f.elapsed_cs, f.rank, f.finish_reason,
      CASE WHEN f.finish_reason = 'completed' THEN p.wait_credit_ms ELSE 0 END AS wait_credit_ms,
      p.timing_source
    FROM final_results f
    JOIN participants p ON p.room_id = f.room_id AND p.id = f.participant_id
    JOIN rooms r ON r.id = f.room_id
    WHERE f.room_id = ? AND f.participant_id = ? AND p.token_hash = ?
      AND r.state = 'FINISHED' AND r.expires_at_ms > ?
  `).bind(input.roomId, input.participantId, input.tokenHash, input.nowMs).first();
  if (!result) {
    const room = await database.prepare("SELECT expires_at_ms FROM rooms WHERE id = ?").bind(input.roomId).first();
    if (room && room.expires_at_ms <= input.nowMs) {
      throw new PersistenceConflictError("expired", "room expired", 410);
    }
    throw new PersistenceConflictError("not_authorized", "result is unavailable", 403);
  }
  return {
    participantId: result.participant_id,
    correctCount: result.correct_count,
    elapsedCs: result.elapsed_cs,
    waitCreditMs: result.wait_credit_ms,
    timingSource: result.timing_source,
    rank: result.rank,
    finishReason: result.finish_reason
  };
}

// src/persistence/question-insert.ts
function insertRoomQuestions(db, roomId, marker, questions) {
  const rows = questions.map((q) => ({ id: q.id, ordinal: q.ordinal, publicPayload: JSON.stringify(toPublicQuestion(q, { resolvedFieldIds: [] })), answer: JSON.stringify(q), fields: JSON.stringify(q.fields), maxScore: q.maxScore }));
  return db.prepare(`INSERT INTO room_questions(room_id,question_id,ordinal,public_payload_json,answer_snapshot_json,field_spec_json,max_score)
 SELECT r.id,json_extract(item.value,'$.id'),json_extract(item.value,'$.ordinal'),json_extract(item.value,'$.publicPayload'),
 json_extract(item.value,'$.answer'),json_extract(item.value,'$.fields'),json_extract(item.value,'$.maxScore')
 FROM rooms r CROSS JOIN json_each(?) AS item WHERE r.id=? AND r.last_command_id=?`).bind(JSON.stringify(rows), roomId, marker);
}

// src/persistence/rooms.ts
var MATE_CREATION_LIMIT = 3;
var MATE_CREATION_WINDOW_MS = 10 * 60 * 1e3;
async function loadCreationReceipt(database, input) {
  const receipt2 = await database.prepare(
    `SELECT c.body_hash, c.result_json, c.expires_at_ms,
       CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
     FROM creation_receipts c JOIN rooms r ON r.id = c.room_id
     WHERE c.actor_key_hash = ? AND c.request_id = ?`
  ).bind(input.actorKeyHash, input.requestId).first();
  if (!receipt2) return null;
  if (receipt2.expires_at_ms <= receipt2.database_now_ms) {
    throw new PersistenceConflictError("expired", "creation receipt expired", 410);
  }
  if (receipt2.body_hash !== input.bodyHash) {
    throw new PersistenceConflictError("request_id_reused", "requestId was already used with another payload");
  }
  return JSON.parse(receipt2.result_json);
}
async function createRoom(database, input) {
  const existing = await loadCreationReceipt(database, input);
  if (existing) return existing;
  if (input.kind === "mate" && !input.host) throw new TypeError("mate rooms require a host participant");
  if (input.kind === "class" && input.host) throw new TypeError("class rooms cannot have a mate host");
  const mateSettingBefore = input.kind === "mate" ? await database.prepare("SELECT mate_match_enabled, revision FROM site_settings WHERE id = 1").first() : null;
  const result = {
    roomId: input.roomId,
    publicId: input.publicId,
    joinCode: input.joinCode,
    kind: input.kind,
    state: "WAITING",
    revision: 0,
    ...input.host ? {
      hostParticipant: {
        id: input.host.participantId,
        nickname: input.host.nickname,
        revision: 0
      }
    } : {}
  };
  const marker = commandMarker(input.actorKeyHash, input.requestId);
  const statements = [
    database.prepare(`
      INSERT INTO rooms (
        id, public_id, join_code, kind, owner_teacher_id, mate_host_id, settings_json,
        game_id, game_version, dataset_version, state, revision, max_score,
        created_at_ms, expires_at_ms, last_command_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING', 0, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM creation_receipts WHERE actor_key_hash = ? AND request_id = ?
      )
        AND (
          ? != 'mate'
          OR (
            COALESCE((SELECT mate_match_enabled FROM site_settings WHERE id = 1), 1) = 1
            AND
            NOT EXISTS (
              SELECT 1 FROM creation_receipts active_receipt
              JOIN rooms active_room ON active_room.id = active_receipt.room_id
              WHERE active_receipt.actor_key_hash = ? AND active_room.kind = 'mate'
                AND active_room.state NOT IN ('FINISHED', 'CANCELLED', 'EXPIRED')
                AND active_room.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
            )
            AND (
              SELECT COUNT(*) FROM creation_receipts recent_receipt
              JOIN rooms recent_room ON recent_room.id = recent_receipt.room_id
              WHERE recent_receipt.actor_key_hash = ? AND recent_room.kind = 'mate'
                AND recent_receipt.processed_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER) - ?
            ) < ?
          )
        )
    `).bind(
      input.roomId,
      input.publicId,
      input.joinCode,
      input.kind,
      input.ownerTeacherId,
      input.host?.participantId ?? null,
      json(input.settings),
      input.gameId,
      input.gameVersion,
      input.datasetVersion,
      input.maxScore,
      input.nowMs,
      input.expiresAtMs,
      marker,
      input.actorKeyHash,
      input.requestId,
      input.kind,
      input.actorKeyHash,
      input.actorKeyHash,
      MATE_CREATION_WINDOW_MS,
      MATE_CREATION_LIMIT
    )
  ];
  if (input.questionProfile) {
    statements.push(database.prepare(`INSERT INTO room_question_profiles (room_id, profile_json, profile_revision)
      SELECT id, ?, ? FROM rooms WHERE id = ? AND last_command_id = ?`).bind(
      json(input.questionProfile.profile),
      input.questionProfile.revision,
      input.roomId,
      marker
    ));
  }
  if (input.host) {
    statements.push(database.prepare(`
      INSERT INTO participants (
        room_id, id, token_hash, nickname, nickname_key, joined_at_ms, joined_order
      )
      SELECT id, ?, ?, ?, ?, ?, 1 FROM rooms
      WHERE id = ? AND last_command_id = ?
    `).bind(
      input.host.participantId,
      input.host.tokenHash,
      input.host.nickname,
      input.host.nicknameKey,
      input.nowMs,
      input.roomId,
      marker
    ));
  }
  statements.push(database.prepare(`
    INSERT INTO creation_receipts (
      actor_key_hash, request_id, body_hash, room_id, result_json, processed_at_ms, expires_at_ms
    )
    SELECT ?, ?, ?, id, ?, ?, expires_at_ms FROM rooms
    WHERE id = ? AND last_command_id = ?
  `).bind(
    input.actorKeyHash,
    input.requestId,
    input.bodyHash,
    json(result),
    input.nowMs,
    input.roomId,
    marker
  ));
  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await loadCreationReceipt(database, input);
    if (raced) return raced;
    throw error;
  }
  const stored = await loadCreationReceipt(database, input);
  if (!stored && input.kind === "mate") {
    const siteSettings = await database.prepare(
      "SELECT mate_match_enabled, revision FROM site_settings WHERE id = 1"
    ).first();
    if (siteSettings?.mate_match_enabled === 0) {
      throw new PersistenceConflictError("mate_disabled", "mate match creation is disabled", 403);
    }
    const limits = await database.prepare(`
      SELECT
        EXISTS (
          SELECT 1 FROM creation_receipts active_receipt
          JOIN rooms active_room ON active_room.id = active_receipt.room_id
          WHERE active_receipt.actor_key_hash = ? AND active_room.kind = 'mate'
            AND active_room.state NOT IN ('FINISHED', 'CANCELLED', 'EXPIRED')
            AND active_room.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        ) AS has_active,
        COUNT(CASE WHEN recent_receipt.processed_at_ms >
          CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? THEN 1 END) AS recent_count,
        MIN(CASE WHEN recent_receipt.processed_at_ms >
          CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? THEN recent_receipt.processed_at_ms END) AS oldest_recent,
        CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
      FROM creation_receipts recent_receipt
      JOIN rooms recent_room ON recent_room.id = recent_receipt.room_id
      WHERE recent_receipt.actor_key_hash = ? AND recent_room.kind = 'mate'
    `).bind(
      input.actorKeyHash,
      MATE_CREATION_WINDOW_MS,
      MATE_CREATION_WINDOW_MS,
      input.actorKeyHash
    ).first();
    if (limits?.has_active) {
      throw new PersistenceConflictError("active_room_exists", "creation credential already has an unfinished room");
    }
    if (Number(limits?.recent_count ?? 0) >= MATE_CREATION_LIMIT) {
      const remainingMs = Math.max(
        1e3,
        (limits?.oldest_recent ?? limits?.database_now_ms ?? input.nowMs) + MATE_CREATION_WINDOW_MS - (limits?.database_now_ms ?? input.nowMs)
      );
      throw new PersistenceConflictError(
        "rate_limited",
        "mate room creation rate limit reached",
        429,
        Math.max(1, Math.ceil(remainingMs / 1e3))
      );
    }
    const settingRevisionBefore = mateSettingBefore?.revision ?? 0;
    const settingRevisionAfter = siteSettings?.revision ?? 0;
    if (settingRevisionAfter !== settingRevisionBefore) {
      throw new PersistenceConflictError("mate_disabled", "mate match creation was disabled during this request", 403);
    }
  }
  if (!stored) throw new PersistenceConflictError("invalid_state", "room creation did not commit");
  return stored;
}
async function cancelRoom(database, input) {
  const actorId = `room:${input.roomId}`;
  const existing = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  const result = { state: "CANCELLED", roomRevision: input.expectedRoomRevision + 1 };
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms SET state = 'CANCELLED', revision = revision + 1, ended_at_ms = ?,
      expires_at_ms = ? + ?, last_command_id = ?
    WHERE id = ? AND revision = ? AND state = 'WAITING' AND expires_at_ms > ?
      AND NOT EXISTS (SELECT 1 FROM command_receipts WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?)
  `).bind(
    input.nowMs,
    input.nowMs,
    PUBLIC_CONFIG.retentionMs.cancelledRoom,
    marker,
    input.roomId,
    input.expectedRoomRevision,
    input.nowMs,
    actorId,
    input.requestId
  )];
  statements.push(database.prepare(`
    UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO command_receipts (room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms)
    SELECT id, ?, ?, ?, 'cancelled', ?, ?, expires_at_ms FROM rooms WHERE id = ? AND last_command_id = ?
  `).bind(actorId, input.requestId, input.bodyHash, json(result), input.nowMs, input.roomId, marker));
  let batch;
  try {
    batch = await database.batch(statements);
  } catch (error) {
    const committed = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  if (changed(batch[0])) return result;
  const raced = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  const room = await database.prepare("SELECT state, revision, expires_at_ms FROM rooms WHERE id = ?").bind(input.roomId).first();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.revision !== input.expectedRoomRevision) throw new PersistenceConflictError("stale_room_revision", "room revision is stale");
  throw new PersistenceConflictError("invalid_state", `cannot cancel a room in ${room.state}`);
}
async function startRoom(database, input) {
  const actorId = `room:${input.roomId}`;
  const existing = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  if (!input.questions.length) throw new TypeError("a room needs at least one question");
  if (input.startAtMs <= input.nowMs || input.deadlineAtMs <= input.startAtMs) throw new TypeError("invalid room schedule");
  const marker = commandMarker(actorId, input.requestId);
  let result = {
    roomId: input.roomId,
    state: "COUNTDOWN",
    roomRevision: input.expectedRoomRevision + 1,
    startAtMs: input.startAtMs,
    deadlineAtMs: input.deadlineAtMs,
    questionIds: input.questions.map((question) => question.id)
  };
  const statements = [database.prepare(`
    UPDATE rooms
    SET state = 'COUNTDOWN', revision = revision + 1, start_at_ms = ?, deadline_at_ms = ?,
      expires_at_ms = MAX(expires_at_ms, ? + CASE kind WHEN 'class' THEN ? ELSE ? END),
      last_command_id = ?
    WHERE id = ? AND revision = ? AND state = 'WAITING' AND expires_at_ms > ?
      AND (SELECT COUNT(*) FROM participants p WHERE p.room_id = rooms.id AND p.status != 'REMOVED')
        >= CASE rooms.kind WHEN 'class' THEN 1 ELSE 2 END
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts
        WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?
      )
  `).bind(
    input.startAtMs,
    input.deadlineAtMs,
    input.deadlineAtMs,
    PUBLIC_CONFIG.retentionMs.classCompetition,
    PUBLIC_CONFIG.retentionMs.mateMatch,
    marker,
    input.roomId,
    input.expectedRoomRevision,
    input.nowMs,
    actorId,
    input.requestId
  )];
  statements.push(database.prepare(`
    UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(insertRoomQuestions(database, input.roomId, marker, input.questions));
  statements.push(database.prepare(`
    INSERT INTO participant_fields (room_id, participant_id, question_id, field_id)
    SELECT p.room_id, p.id, q.question_id, json_extract(field.value, '$.id')
    FROM participants p
    JOIN rooms r ON r.id = p.room_id
    JOIN room_questions q ON q.room_id = p.room_id
    JOIN json_each(q.field_spec_json) AS field
    WHERE p.room_id = ? AND p.status = 'ACTIVE' AND r.last_command_id = ?
  `).bind(input.roomId, marker));
  const receipt2 = () => database.prepare(`INSERT INTO command_receipts(room_id,actor_id,request_id,body_hash,result_code,result_json,processed_at_ms,expires_at_ms)
    SELECT id,?,?,?,'started',?,?,expires_at_ms FROM rooms WHERE id=? AND last_command_id=?`).bind(actorId, input.requestId, input.bodyHash, json(result), input.clock?.() ?? input.nowMs, input.roomId, marker);
  const lateSchedule = database.transactional && input.clock;
  if (!lateSchedule) statements.push(receipt2());
  let batch;
  try {
    batch = await database.batch(statements);
    if (lateSchedule && changed(batch[0])) {
      const startedAt = input.clock() + PUBLIC_CONFIG.countdownSeconds * 1e3;
      result = { ...result, startAtMs: startedAt, deadlineAtMs: startedAt + (input.deadlineAtMs - input.startAtMs) };
      await database.batch([
        database.prepare(`UPDATE rooms SET start_at_ms=?,deadline_at_ms=?,expires_at_ms=MAX(expires_at_ms,?+CASE kind WHEN 'class' THEN ? ELSE ? END) WHERE id=? AND last_command_id=?`).bind(result.startAtMs, result.deadlineAtMs, result.deadlineAtMs, PUBLIC_CONFIG.retentionMs.classCompetition, PUBLIC_CONFIG.retentionMs.mateMatch, input.roomId, marker),
        database.prepare(`UPDATE creation_receipts SET expires_at_ms=(SELECT expires_at_ms FROM rooms WHERE id=?) WHERE room_id=?`).bind(input.roomId, input.roomId),
        database.prepare(`UPDATE command_receipts SET expires_at_ms=(SELECT expires_at_ms FROM rooms WHERE id=?) WHERE room_id=?`).bind(input.roomId, input.roomId),
        receipt2()
      ]);
    }
  } catch (error) {
    const committed = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  if (changed(batch[0])) return result;
  const raced = await loadCommandReceipt(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  const room = await database.prepare("SELECT state, revision, expires_at_ms FROM rooms WHERE id = ?").bind(input.roomId).first();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.revision !== input.expectedRoomRevision) throw new PersistenceConflictError("stale_room_revision", "room revision is stale");
  throw new PersistenceConflictError("invalid_state", `cannot start a room in ${room.state}`);
}

// src/persistence/settings.ts
async function updateRoomSettingsCommand(database, input) {
  const actorId = `settings:${input.actorId}`;
  const existing = await loadCommandReceipt(
    database,
    input.roomId,
    actorId,
    input.requestId,
    input.bodyHash
  );
  if (existing) return existing;
  const result = {
    revision: input.expectedRevision + 1,
    settings: input.settings,
    maxScore: input.maxScore
  };
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms SET settings_json = ?, dataset_version = ?, max_score = ?, revision = revision + 1, last_command_id = ?
    WHERE id = ? AND state = 'WAITING' AND revision = ?
      AND NOT EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state != 'WAITING')
      AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts
        WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?
      )
  `).bind(
    json(input.settings),
    input.settings.chemistryContentVersion ?? "4",
    input.maxScore,
    marker,
    input.roomId,
    input.expectedRevision,
    actorId,
    input.requestId
  )];
  statements.push(database.prepare(`
    INSERT INTO command_receipts (
      room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
    )
    SELECT id, ?, ?, ?, 'settings_updated', ?, ?, expires_at_ms
    FROM rooms WHERE id = ? AND last_command_id = ?
  `).bind(
    actorId,
    input.requestId,
    input.bodyHash,
    json(result),
    input.nowMs,
    input.roomId,
    marker
  ));
  try {
    const batch = await database.batch(statements);
    if (changed(batch[0])) return result;
  } catch (error) {
    const committed = await loadCommandReceipt(
      database,
      input.roomId,
      actorId,
      input.requestId,
      input.bodyHash
    );
    if (committed) return committed;
    throw error;
  }
  const raced = await loadCommandReceipt(
    database,
    input.roomId,
    actorId,
    input.requestId,
    input.bodyHash
  );
  if (raced) return raced;
  throw new PersistenceConflictError("stale_room_revision", "room settings changed");
}
var SITE_SETTING_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1e3;
async function loadSiteSettingReceipt(database, teacherId, requestId2, bodyHash2) {
  const receipt2 = await database.prepare(`
    SELECT body_hash, result_json FROM site_setting_receipts
    WHERE teacher_id = ? AND request_id = ?
      AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  `).bind(teacherId, requestId2).first();
  if (!receipt2) return null;
  if (receipt2.body_hash !== bodyHash2) {
    throw new PersistenceConflictError("request_id_reused", "requestId was already used with another payload");
  }
  return JSON.parse(receipt2.result_json);
}
async function updateSiteSettingsCommand(database, input) {
  const existing = await loadSiteSettingReceipt(
    database,
    input.teacherId,
    input.requestId,
    input.bodyHash
  );
  if (existing) return existing;
  const result = { enabled: input.enabled, revision: input.expectedRevision + 1 };
  const marker = commandMarker(`site-settings:${input.teacherId}`, input.requestId);
  const statements = [database.prepare(`
    DELETE FROM site_setting_receipts
    WHERE teacher_id = ? AND request_id = ?
      AND expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
  `).bind(input.teacherId, input.requestId), database.prepare(`
    INSERT INTO site_settings (id, mate_match_enabled, revision, updated_at_ms)
    VALUES (1, 1, 0, 0) ON CONFLICT(id) DO NOTHING
  `), database.prepare(`
    UPDATE site_settings
    SET mate_match_enabled = ?, revision = revision + 1, updated_at_ms = ?, last_command_id = ?
    WHERE id = 1 AND revision = ?
      AND NOT EXISTS (
        SELECT 1 FROM site_setting_receipts WHERE teacher_id = ? AND request_id = ?
      )
  `).bind(
    input.enabled ? 1 : 0,
    input.nowMs,
    marker,
    input.expectedRevision,
    input.teacherId,
    input.requestId
  ), database.prepare(`
    INSERT INTO site_setting_receipts (
      teacher_id, request_id, body_hash, result_json, processed_at_ms, expires_at_ms
    )
    SELECT ?, ?, ?, ?, ?, ? FROM site_settings WHERE id = 1 AND last_command_id = ?
  `).bind(
    input.teacherId,
    input.requestId,
    input.bodyHash,
    json(result),
    input.nowMs,
    input.nowMs + SITE_SETTING_RECEIPT_RETENTION_MS,
    marker
  )];
  try {
    const batch = await database.batch(statements);
    if (changed(batch[2])) return result;
  } catch (error) {
    const committed = await loadSiteSettingReceipt(
      database,
      input.teacherId,
      input.requestId,
      input.bodyHash
    );
    if (committed) return committed;
    throw error;
  }
  const raced = await loadSiteSettingReceipt(
    database,
    input.teacherId,
    input.requestId,
    input.bodyHash
  );
  if (raced) return raced;
  throw new PersistenceConflictError("stale_room_revision", "site settings changed");
}

// src/persistence/v2-manifest.ts
async function prepareV2Room(db, input) {
  const actor = `v2-prepare:${input.roomId}`;
  const receipt2 = await loadCommandReceipt(db, input.roomId, actor, input.requestId, input.bodyHash);
  if (receipt2) return receipt2;
  const room = await db.prepare("SELECT state, revision, expires_at_ms, settings_json, start_at_ms, deadline_at_ms FROM rooms WHERE id = ?").bind(input.roomId).first();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.state !== "WAITING" || room.revision !== input.expectedRoomRevision) throw new PersistenceConflictError("invalid_state", "room is not waiting at the expected revision");
  if (!input.questions.length || input.questions.some((question, index) => question.ordinal !== index)) throw new TypeError("invalid question order");
  const settings = JSON.parse(room.settings_json);
  if (settings.gradingMode !== input.gradingMode || settings.questionCount !== input.questions.length) throw new TypeError("settings and manifest differ");
  const existing = await db.prepare("SELECT *, state AS v2_state FROM v2_room_manifests WHERE room_id = ?").bind(input.roomId).first();
  if (existing && existing.v2_state !== "WAITING") throw new PersistenceConflictError("invalid_state", "previous preparation is still active");
  const reuseQuestions = !!existing && existing.settings_json === room.settings_json;
  const manifestId = reuseQuestions ? existing.manifest_id : input.manifestId;
  const generation = existing ? existing.preparation_generation + 1 : 1;
  const response = { state: "PREPARING", manifestId, preparationGeneration: generation, roomRevision: room.revision + 1 };
  const marker = commandMarker(actor, input.requestId);
  const statements = [db.prepare(`UPDATE rooms SET revision = revision + 1, last_command_id = ?
    WHERE id = ? AND state = 'WAITING' AND revision = ? AND expires_at_ms > ?
      AND (SELECT COUNT(*) FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE') >= CASE kind WHEN 'class' THEN 1 ELSE 2 END`).bind(marker, input.roomId, input.expectedRoomRevision, input.nowMs)];
  if (existing) {
    statements.push(db.prepare(`UPDATE v2_room_manifests SET state = 'PREPARING', manifest_id = ?, evaluator_version = ?, grading_mode = ?,
      settings_revision = ?, settings_json = ?, preparation_generation = ?, prepared_at_ms = ?, collecting_at_ms = NULL,
      cutoff_at_ms = NULL, collection_until_ms = NULL, finalized_at_ms = NULL
      WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(
      manifestId,
      input.evaluatorVersion,
      input.gradingMode,
      room.revision,
      room.settings_json,
      generation,
      input.nowMs,
      input.roomId,
      input.roomId,
      marker
    ));
  } else {
    statements.push(db.prepare(`INSERT INTO v2_room_manifests(room_id, state, manifest_id, evaluator_version, grading_mode, settings_revision,
      settings_json, preparation_generation, prepared_at_ms) SELECT id, 'PREPARING', ?, ?, ?, ?, settings_json, 1, ? FROM rooms WHERE id = ? AND last_command_id = ?`).bind(manifestId, input.evaluatorVersion, input.gradingMode, room.revision, input.nowMs, input.roomId, marker));
  }
  if (!reuseQuestions) {
    if (existing) statements.push(db.prepare(`DELETE FROM room_questions WHERE room_id = ?
      AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.roomId, input.roomId, marker));
    statements.push(insertRoomQuestions(db, input.roomId, marker, input.questions));
  }
  statements.push(db.prepare(`INSERT OR IGNORE INTO v2_participant_progress(room_id, participant_id)
    SELECT p.room_id, p.id FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE p.room_id = ? AND p.status = 'ACTIVE' AND r.last_command_id = ?`).bind(input.roomId, marker));
  statements.push(db.prepare(`INSERT INTO command_receipts(room_id, actor_id, request_id, body_hash, result_code,
    result_json, processed_at_ms, expires_at_ms) SELECT id, ?, ?, ?, 'prepared', ?, ?, expires_at_ms
    FROM rooms WHERE id = ? AND last_command_id = ?`).bind(actor, input.requestId, input.bodyHash, json(response), input.nowMs, input.roomId, marker));
  try {
    const result = await db.batch(statements);
    if (changed(result[0])) {
      if (input.clock) await db.prepare(`UPDATE v2_room_manifests SET prepared_at_ms=? WHERE room_id=? AND preparation_generation=?`).bind(input.clock(), input.roomId, generation).run();
      return response;
    }
  } catch (error) {
    const raced2 = await loadCommandReceipt(db, input.roomId, actor, input.requestId, input.bodyHash);
    if (raced2) return raced2;
    throw error;
  }
  const raced = await loadCommandReceipt(db, input.roomId, actor, input.requestId, input.bodyHash);
  if (raced) return raced;
  throw new PersistenceConflictError("invalid_state", "room preparation did not commit");
}
async function loadV2Manifest(db, roomId, participantId) {
  const row = await db.prepare(`SELECT m.manifest_id, m.evaluator_version, m.grading_mode, m.preparation_generation, m.state, p.status
    FROM v2_room_manifests m JOIN rooms r ON r.id = m.room_id
    JOIN participants p ON p.room_id = m.room_id AND p.id = ? WHERE m.room_id = ?`).bind(participantId, roomId).first();
  if (!row || row.status === "REMOVED") throw new PersistenceConflictError("not_authorized", "participant cannot read manifest", 403);
  if (!["PREPARING", "COUNTDOWN", "RUNNING", "COLLECTING"].includes(row.state)) throw new PersistenceConflictError("invalid_state", "manifest is unavailable");
  const questionRows = await db.prepare("SELECT public_payload_json, answer_snapshot_json FROM room_questions WHERE room_id = ? ORDER BY ordinal").bind(roomId).all();
  return {
    manifestId: row.manifest_id,
    evaluatorVersion: row.evaluator_version,
    gradingMode: row.grading_mode,
    preparationGeneration: row.preparation_generation,
    questions: questionRows.results.map((question) => JSON.parse(row.grading_mode === "immediate" ? question.answer_snapshot_json : question.public_payload_json))
  };
}
async function markV2Ready(db, input) {
  const room = await db.prepare(`SELECT m.state, r.start_at_ms, r.deadline_at_ms, r.expires_at_ms, r.settings_json,
      m.manifest_id, m.evaluator_version, m.preparation_generation, m.prepared_at_ms
    FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id WHERE r.id = ?`).bind(input.roomId).first();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.manifest_id !== input.manifestId || room.evaluator_version !== input.evaluatorVersion || room.preparation_generation !== input.preparationGeneration) throw new PersistenceConflictError("invalid_state", "stale preparation generation");
  if (room.state !== "PREPARING" && room.state !== "COUNTDOWN" && room.state !== "RUNNING") throw new PersistenceConflictError("invalid_state", "room is not preparing");
  await db.prepare(`UPDATE v2_participant_progress SET ready_generation = ? WHERE room_id = ? AND participant_id = ?
    AND EXISTS (SELECT 1 FROM participants p WHERE p.room_id = ? AND p.id = ? AND p.status = 'ACTIVE')`).bind(input.preparationGeneration, input.roomId, input.participantId, input.roomId, input.participantId).run();
  const counts = await db.prepare(`SELECT COUNT(*) AS participant_count,
    SUM(CASE WHEN v.ready_generation = ? THEN 1 ELSE 0 END) AS ready_count
    FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
    WHERE p.room_id = ? AND p.status = 'ACTIVE'`).bind(input.preparationGeneration, input.roomId).first();
  const participantCount = Number(counts?.participant_count ?? 0);
  const readyCount = Number(counts?.ready_count ?? 0);
  const decisionAtMs = input.clock?.() ?? input.nowMs;
  let attemptedCountdown = false;
  if (participantCount && readyCount === participantCount && room.state === "PREPARING" && decisionAtMs < room.prepared_at_ms + 3e4) {
    attemptedCountdown = true;
    const startAtMs = decisionAtMs + PUBLIC_CONFIG.countdownSeconds * 1e3;
    const timeLimit = JSON.parse(room.settings_json).timeLimitMinutes * 6e4;
    const marker = commandMarker("v2-ready", `${input.roomId}:${input.preparationGeneration}`);
    await db.batch([
      db.prepare(`UPDATE rooms SET state = 'COUNTDOWN', revision = revision + 1,
      start_at_ms = ?, deadline_at_ms = ?, expires_at_ms = MAX(expires_at_ms, ? + CASE kind WHEN 'class' THEN ? ELSE ? END), last_command_id = ?
      WHERE id = ? AND state = 'WAITING' AND EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id
        AND m.state = 'PREPARING' AND m.preparation_generation = ? AND ? < m.prepared_at_ms + 30000) AND NOT EXISTS (
        SELECT 1 FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
        WHERE p.room_id = rooms.id AND p.status = 'ACTIVE' AND COALESCE(v.ready_generation, 0) != ?)`).bind(
        startAtMs,
        startAtMs + timeLimit,
        startAtMs + timeLimit,
        PUBLIC_CONFIG.retentionMs.classCompetition,
        PUBLIC_CONFIG.retentionMs.mateMatch,
        marker,
        input.roomId,
        input.preparationGeneration,
        decisionAtMs,
        input.preparationGeneration
      ),
      db.prepare(`UPDATE v2_room_manifests SET state = 'COUNTDOWN' WHERE room_id = ?
      AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.roomId, input.roomId, marker),
      db.prepare(`UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
      WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.roomId, input.roomId, input.roomId, marker),
      db.prepare(`UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
      WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.roomId, input.roomId, input.roomId, marker)
    ]);
  }
  const latest = attemptedCountdown ? await db.prepare(`SELECT m.state, r.start_at_ms, r.deadline_at_ms
    FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id WHERE r.id = ?`).bind(input.roomId).first() : room;
  return {
    state: latest?.state ?? room.state,
    readyCount,
    participantCount,
    startAtMs: latest?.start_at_ms ?? null,
    deadlineAtMs: latest?.deadline_at_ms ?? null,
    preparationTimedOut: room.state === "PREPARING" && decisionAtMs >= room.prepared_at_ms + 3e4
  };
}
async function cancelV2Preparation(db, input) {
  const marker = commandMarker("v2-cancel", input.roomId);
  const results = await db.batch([
    db.prepare(`UPDATE rooms SET revision = revision + 1, last_command_id = ? WHERE id = ? AND state = 'WAITING'
    AND revision = ? AND expires_at_ms > ? AND EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state = 'PREPARING')`).bind(marker, input.roomId, input.expectedRoomRevision, input.nowMs),
    db.prepare(`UPDATE v2_room_manifests SET state = 'WAITING' WHERE room_id = ? AND EXISTS
    (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.roomId, input.roomId, marker)
  ]);
  const result = results[0];
  if (!changed(result)) throw new PersistenceConflictError("invalid_state", "preparation could not be cancelled");
  return { state: "WAITING", roomRevision: input.expectedRoomRevision + 1 };
}
async function loadV2RoomPhase(db, roomId, nowMs) {
  const row = await db.prepare(`SELECT m.state, m.manifest_id, m.grading_mode, m.evaluator_version,
    m.preparation_generation, m.prepared_at_ms, m.cutoff_at_ms, m.collection_until_ms, m.finalized_at_ms,
    r.start_at_ms, r.deadline_at_ms, r.revision, r.end_reason
    FROM v2_room_manifests m JOIN rooms r ON r.id = m.room_id WHERE m.room_id = ?`).bind(roomId).first();
  if (!row) return null;
  const state = row.state === "COUNTDOWN" && row.start_at_ms != null && nowMs >= row.start_at_ms ? "RUNNING" : row.state;
  return {
    state,
    manifestId: row.manifest_id,
    gradingMode: row.grading_mode,
    evaluatorVersion: row.evaluator_version,
    preparationGeneration: row.preparation_generation,
    preparationTimedOut: row.state === "PREPARING" && nowMs >= row.prepared_at_ms + 3e4,
    startAtMs: row.start_at_ms,
    deadlineAtMs: row.deadline_at_ms,
    cutoffAtMs: row.cutoff_at_ms ?? row.deadline_at_ms,
    collectionUntilMs: row.collection_until_ms ?? (row.deadline_at_ms == null ? null : row.deadline_at_ms + 1e4),
    finalizedAtMs: row.finalized_at_ms,
    roomRevision: row.revision,
    endReason: row.end_reason
  };
}

// src/competition-core/v2-operations.ts
function fieldKey(questionId, fieldId) {
  return `${questionId}:${fieldId}`;
}
function nonempty(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object" && value !== null && "tokens" in value) {
    const entry = value;
    return Array.isArray(entry.tokens) && entry.tokens.some((token) => String(token).trim()) || entry.charge != null;
  }
  return false;
}
function replayV2Operations(questions, gradingMode, operations, startAtMs, cutoffAtMs, interruption = false, gradeDeferred = true) {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const fields = {};
  let finishedElapsedMs = null;
  let finishReason = null;
  let boundaryAcknowledged = false;
  let previousElapsed = -1;
  let currentOrdinal = 0;
  for (const operation of operations) {
    if (!Number.isSafeInteger(operation.seq) || operation.seq < 1 || !Number.isFinite(operation.elapsedMs) || operation.elapsedMs < previousElapsed) throw new TypeError("invalid operation order");
    previousElapsed = operation.elapsedMs;
    if (operation.type === "finish") {
      if (finishedElapsedMs !== null) throw new TypeError("duplicate finish");
      if (operation.reason === "completed" && gradingMode !== "immediate") throw new TypeError("completed finish requires immediate mode");
      if (operation.reason === "completed" && currentOrdinal !== questions.length && startAtMs + operation.elapsedMs < cutoffAtMs)
        throw new TypeError("questions are not complete");
      if (operation.reason === "timeout" || operation.reason === "interrupted") {
        if (operation.boundaryAtMs === cutoffAtMs) boundaryAcknowledged = true;
      }
      if (operation.reason === "submitted" && startAtMs + operation.elapsedMs < cutoffAtMs) {
        finishedElapsedMs = operation.elapsedMs;
        finishReason = "submitted";
      } else if (operation.reason === "completed" && startAtMs + operation.elapsedMs < cutoffAtMs) {
        finishedElapsedMs = operation.elapsedMs;
        finishReason = "completed";
      }
      continue;
    }
    if (finishedElapsedMs !== null) {
      if (startAtMs + operation.elapsedMs < cutoffAtMs) throw new TypeError("operation after finish");
      continue;
    }
    const question = questionById.get(operation.questionId ?? "");
    if (!question || !operation.fieldId || !question.fields.some((field) => field.id === operation.fieldId)) throw new TypeError("invalid question or field");
    const fieldId = operation.fieldId;
    const key2 = fieldKey(question.id, fieldId);
    const previous = fields[key2];
    const eventAtMs = startAtMs + operation.elapsedMs;
    const editAtMs = startAtMs + (operation.editedElapsedMs ?? operation.elapsedMs);
    const beforeCutoff = eventAtMs < cutoffAtMs || !interruption && operation.type === "draft" && eventAtMs === cutoffAtMs && editAtMs < cutoffAtMs;
    if (!beforeCutoff) continue;
    if (gradingMode === "immediate") {
      if (operation.type === "draft" || question.ordinal > currentOrdinal || question.ordinal < currentOrdinal && previous?.state !== "passed") throw new TypeError("invalid immediate operation");
      if (previous?.state === "correct" || operation.type === "pass" && previous?.state === "passed") throw new TypeError("field already resolved");
      if (operation.type === "pass") {
        fields[key2] = { state: "passed", value: previous?.value ?? null, editedElapsedMs: operation.elapsedMs };
      } else {
        const evaluation = evaluateField(question, fieldId, operation.value);
        fields[key2] = {
          state: evaluation.correct ? "correct" : previous?.state === "passed" ? "passed" : "unanswered",
          value: operation.value,
          editedElapsedMs: operation.elapsedMs
        };
      }
      if (question.ordinal === currentOrdinal && question.fields.every((field) => ["correct", "passed"].includes(fields[fieldKey(question.id, field.id)]?.state ?? ""))) {
        currentOrdinal += 1;
      }
    } else {
      if (operation.type !== "draft") throw new TypeError("invalid deferred operation");
      if (!Number.isFinite(operation.editedElapsedMs ?? operation.elapsedMs) || (operation.editedElapsedMs ?? operation.elapsedMs) > operation.elapsedMs || editAtMs >= cutoffAtMs) continue;
      fields[key2] = {
        state: nonempty(operation.value) ? "incorrect" : "unanswered",
        value: operation.value,
        editedElapsedMs: operation.editedElapsedMs ?? operation.elapsedMs
      };
    }
  }
  if (gradingMode === "deferred" && gradeDeferred) {
    for (const question of questions) for (const field of question.fields) {
      const key2 = fieldKey(question.id, field.id);
      const current = fields[key2];
      if (!current || current.state === "unanswered") continue;
      fields[key2] = { ...current, state: evaluateField(question, field.id, current.value).correct ? "correct" : "incorrect" };
    }
  }
  const correctCount = Object.values(fields).filter((field) => field.state === "correct").length;
  const answeredCount = Object.values(fields).filter((field) => nonempty(field.value)).length;
  const resolvedQuestionCount = gradingMode === "immediate" ? currentOrdinal : 0;
  return {
    fields,
    correctCount,
    answeredCount,
    resolvedQuestionCount,
    finishedElapsedMs,
    finishReason,
    boundaryAcknowledged
  };
}

// src/persistence/v2-operations.ts
function bodyHash(input) {
  return json({
    writerEpoch: input.writerEpoch,
    manifestId: input.manifestId,
    evaluatorVersion: input.evaluatorVersion,
    operations: input.operations
  });
}
async function receipt(db, input, hash) {
  const row = await db.prepare(`SELECT body_hash, response_json FROM v2_batch_receipts
    WHERE room_id = ? AND participant_id = ? AND request_id = ?`).bind(input.roomId, input.participantId, input.requestId).first();
  if (!row) return null;
  if (row.body_hash !== hash) throw new PersistenceConflictError("request_id_reused", "requestId was reused with different operations");
  return JSON.parse(row.response_json);
}
function validateBatch(input, previousSeq, previousElapsed) {
  if (!input.requestId || input.requestId.length > 128 || !Number.isSafeInteger(input.writerEpoch) || input.writerEpoch < 0) throw new TypeError("invalid batch identity");
  if (!input.operations.length || input.operations.length > 128 || json(input.operations).length > 128 * 1024) throw new TypeError("invalid batch size");
  let elapsed = previousElapsed;
  for (const [index, operation] of input.operations.entries()) {
    if (operation.seq !== previousSeq + index + 1 || !operation.operationId || operation.operationId.length > 128) {
      throw new PersistenceConflictError("stale_participant_revision", `expected sequence ${previousSeq + 1}`);
    }
    if (!Number.isSafeInteger(operation.elapsedMs) || operation.elapsedMs < elapsed) throw new TypeError("operation time must be nonnegative and monotonic");
    elapsed = operation.elapsedMs;
    if (!["answer", "pass", "draft", "finish"].includes(operation.type)) throw new TypeError("invalid operation type");
    if (operation.value !== void 0 && json(operation.value).length > 4096) throw new TypeError("answer too long");
    if (operation.type === "finish" && !["completed", "submitted", "timeout", "interrupted"].includes(operation.reason ?? "")) throw new TypeError("invalid finish reason");
  }
}
async function applyV2Operations(db, input) {
  const hash = bodyHash(input);
  const priorReceipt = await receipt(db, input, hash);
  if (priorReceipt) return priorReceipt;
  const context = await db.prepare(`SELECT r.state, r.start_at_ms, r.deadline_at_ms, r.expires_at_ms, r.end_reason,
    m.manifest_id, m.evaluator_version, m.grading_mode, m.cutoff_at_ms, m.collection_until_ms,
    p.status, v.writer_epoch, v.ack_seq, v.accepted_seq, v.last_elapsed_ms
    FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id
    JOIN participants p ON p.room_id = r.id AND p.id = ?
    JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
    WHERE r.id = ?`).bind(input.participantId, input.roomId).first();
  if (!context || context.status === "REMOVED") throw new PersistenceConflictError("not_authorized", "participant cannot save operations", 403);
  if (context.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (context.manifest_id !== input.manifestId || context.evaluator_version !== input.evaluatorVersion) {
    throw new PersistenceConflictError("invalid_state", "manifest or evaluator version differs");
  }
  if (context.writer_epoch !== input.writerEpoch) throw new PersistenceConflictError("stale_participant_revision", "writer epoch is stale");
  if (context.start_at_ms == null || context.deadline_at_ms == null || input.nowMs < context.start_at_ms) throw new PersistenceConflictError("invalid_state", "competition has not started");
  if (!["COUNTDOWN", "RUNNING", "COLLECTING"].includes(context.state)) throw new PersistenceConflictError("invalid_state", "competition is not accepting records");
  const cutoffAtMs = context.cutoff_at_ms ?? context.deadline_at_ms;
  const collectionUntilMs = context.collection_until_ms ?? cutoffAtMs + 1e4;
  if (input.nowMs >= collectionUntilMs) throw new PersistenceConflictError("deadline", "record collection has ended");
  validateBatch(input, context.ack_seq, context.last_elapsed_ms);
  const questions = (await db.prepare(`SELECT answer_snapshot_json FROM room_questions WHERE room_id = ? ORDER BY ordinal`).bind(input.roomId).all()).results.map((row) => JSON.parse(row.answer_snapshot_json));
  const previousOps = (await db.prepare(`SELECT payload_json FROM v2_operations WHERE room_id = ? AND participant_id = ? ORDER BY seq`).bind(input.roomId, input.participantId).all()).results.map((row) => JSON.parse(row.payload_json));
  const allOps = [...previousOps, ...input.operations];
  const interruption = context.end_reason === "interrupted";
  for (const operation of input.operations) {
    if (context.start_at_ms + operation.elapsedMs > input.nowMs + 250) {
      console.warn(JSON.stringify({ event: "operation_clock_rejected", type: operation.type, aheadByMs: context.start_at_ms + operation.elapsedMs - input.nowMs }));
      throw new TypeError("operation time is in the future");
    }
    if (operation.type === "finish" && operation.reason === "interrupted" && !interruption) throw new TypeError("unexpected interruption finish");
    if (context.grading_mode === "immediate" && operation.type === "draft") throw new TypeError("draft is not valid in immediate mode");
    if (context.grading_mode === "deferred" && ["answer", "pass"].includes(operation.type)) throw new TypeError("answer or pass is not valid in deferred mode");
  }
  const replay = replayV2Operations(questions, context.grading_mode, allOps, context.start_at_ms, cutoffAtMs, interruption, false);
  const ackSeq = input.operations.at(-1).seq;
  let acceptedSeq = context.accepted_seq;
  for (const operation of input.operations) {
    const at = context.start_at_ms + operation.elapsedMs;
    const valid = at < cutoffAtMs || !interruption && operation.type === "draft" && at === cutoffAtMs && context.start_at_ms + (operation.editedElapsedMs ?? operation.elapsedMs) < cutoffAtMs;
    if (valid) acceptedSeq = operation.seq;
  }
  const response = {
    ackSeq,
    acceptedSeq,
    roomState: context.state,
    cutoffAtMs,
    collectionUntilMs,
    correctCount: context.grading_mode === "immediate" ? replay.correctCount : 0,
    answeredCount: replay.answeredCount,
    resolvedQuestionCount: replay.resolvedQuestionCount
  };
  const marker = commandMarker(input.participantId, input.requestId);
  const statements = [db.prepare(`UPDATE v2_participant_progress SET ack_seq = ?, accepted_seq = ?, last_elapsed_ms = ?,
      answered_count = ?, finished_elapsed_ms = ?, finish_reason = ?, boundary_ack_at_ms = CASE WHEN ? THEN ? ELSE boundary_ack_at_ms END,
      last_sync_at_ms = ?, last_command_id = ?
    WHERE room_id = ? AND participant_id = ? AND writer_epoch = ? AND ack_seq = ?
      AND EXISTS (SELECT 1 FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id
        WHERE r.id = ? AND r.state IN ('COUNTDOWN', 'RUNNING', 'COLLECTING')
          AND ? < COALESCE(m.collection_until_ms, r.deadline_at_ms + 10000))`).bind(
    ackSeq,
    acceptedSeq,
    input.operations.at(-1).elapsedMs,
    replay.answeredCount,
    replay.finishedElapsedMs,
    replay.finishReason,
    replay.boundaryAcknowledged ? 1 : 0,
    replay.boundaryAcknowledged ? input.nowMs : null,
    input.nowMs,
    marker,
    input.roomId,
    input.participantId,
    input.writerEpoch,
    context.ack_seq,
    input.roomId,
    input.nowMs
  )];
  for (const operation of input.operations) statements.push(db.prepare(`INSERT INTO v2_operations
    (room_id, participant_id, seq, operation_id, payload_json, elapsed_ms, accepted_for_score, received_at_ms)
    SELECT room_id, participant_id, ?, ?, ?, ?, ?, ? FROM v2_participant_progress
    WHERE room_id = ? AND participant_id = ? AND last_command_id = ?`).bind(
    operation.seq,
    operation.operationId,
    json(operation),
    operation.elapsedMs,
    operation.seq <= acceptedSeq ? 1 : 0,
    input.nowMs,
    input.roomId,
    input.participantId,
    marker
  ));
  statements.push(db.prepare(`UPDATE participants SET correct_count = ?, resolved_question_count = ?,
    current_ordinal = ?, accepted_elapsed_ms = ?, wait_credit_ms = 0, revision = revision + 1
    WHERE room_id = ? AND id = ? AND EXISTS (SELECT 1 FROM v2_participant_progress v
      WHERE v.room_id = participants.room_id AND v.participant_id = participants.id AND v.last_command_id = ?)`).bind(
    context.grading_mode === "immediate" ? replay.correctCount : 0,
    replay.resolvedQuestionCount,
    replay.resolvedQuestionCount,
    input.operations.at(-1).elapsedMs,
    input.roomId,
    input.participantId,
    marker
  ));
  statements.push(db.prepare(`UPDATE rooms SET revision = revision + 1 WHERE id = ?
    AND EXISTS (SELECT 1 FROM v2_participant_progress v WHERE v.room_id = rooms.id
      AND v.participant_id = ? AND v.last_command_id = ?)`).bind(input.roomId, input.participantId, marker));
  statements.push(db.prepare(`INSERT INTO v2_batch_receipts(room_id, participant_id, request_id, body_hash, response_json, processed_at_ms)
    SELECT room_id, participant_id, ?, ?, ?, ? FROM v2_participant_progress
    WHERE room_id = ? AND participant_id = ? AND last_command_id = ?`).bind(
    input.requestId,
    hash,
    json(response),
    input.nowMs,
    input.roomId,
    input.participantId,
    marker
  ));
  try {
    const result = await db.batch(statements);
    if (changed(result[0])) return response;
  } catch (error) {
    const raced2 = await receipt(db, input, hash);
    if (raced2) return raced2;
    throw error;
  }
  const raced = await receipt(db, input, hash);
  if (raced) return raced;
  throw new PersistenceConflictError("stale_participant_revision", "operation sequence or writer changed");
}
async function takeOverV2Writer(db, roomId, participantId, expectedEpoch) {
  const result = await db.prepare(`UPDATE v2_participant_progress SET writer_epoch = writer_epoch + 1
    WHERE room_id = ? AND participant_id = ? AND writer_epoch = ?
      AND EXISTS (SELECT 1 FROM participants p WHERE p.room_id = ? AND p.id = ? AND p.status = 'ACTIVE')`).bind(roomId, participantId, expectedEpoch, roomId, participantId).run();
  if (!changed(result)) throw new PersistenceConflictError("stale_participant_revision", "writer epoch changed");
  return { writerEpoch: expectedEpoch + 1 };
}

// src/persistence/v2-results.ts
async function loadRoom(db, roomId) {
  return db.prepare(`SELECT r.state, r.revision, r.kind, r.start_at_ms, r.deadline_at_ms, r.expires_at_ms,
    r.end_reason, m.state AS phase_state, m.grading_mode, m.cutoff_at_ms, m.collection_until_ms, m.finalized_at_ms
    FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id WHERE r.id = ?`).bind(roomId).first();
}
async function collectV2Room(db, input) {
  const room = await loadRoom(db, input.roomId);
  if (!room) throw new PersistenceConflictError("not_found", "v2 room not found", 404);
  if (room.phase_state === "FINISHED") return { state: "FINISHED", cutoffAtMs: room.cutoff_at_ms ?? room.deadline_at_ms, collectionUntilMs: room.collection_until_ms ?? room.deadline_at_ms + 1e4 };
  if (room.phase_state === "COLLECTING") return { state: "COLLECTING", cutoffAtMs: room.cutoff_at_ms, collectionUntilMs: room.collection_until_ms };
  if (room.phase_state !== "COUNTDOWN" || room.start_at_ms == null || room.deadline_at_ms == null) {
    throw new PersistenceConflictError("invalid_state", "room has not started");
  }
  if (!input.interrupted && input.nowMs < room.deadline_at_ms) throw new PersistenceConflictError("invalid_state", "deadline has not arrived");
  const cutoffAtMs = input.interrupted ? Math.min(input.nowMs, room.deadline_at_ms) : room.deadline_at_ms;
  const marker = commandMarker("v2-collect", `${input.roomId}:${cutoffAtMs}`);
  const statements = [db.prepare(`UPDATE rooms SET state = 'RUNNING', revision = revision + 1,
    end_reason = ?, ended_at_ms = ?, last_command_id = ?
    WHERE id = ? AND revision = ? AND state IN ('COUNTDOWN', 'RUNNING')
      AND EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state = 'COUNTDOWN')`).bind(input.interrupted ? "interrupted" : "normal", cutoffAtMs, marker, input.roomId, room.revision)];
  statements.push(db.prepare(`UPDATE v2_room_manifests SET state = 'COLLECTING', collecting_at_ms = ?, cutoff_at_ms = ?, collection_until_ms = ?
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.nowMs, cutoffAtMs, cutoffAtMs + 1e4, input.roomId, input.roomId, marker));
  const results = await db.batch(statements);
  if (!changed(results[0])) return collectV2Room(db, input);
  return { state: "COLLECTING", cutoffAtMs, collectionUntilMs: cutoffAtMs + 1e4 };
}
async function maybeFinalizeV2Room(db, input) {
  let room = await loadRoom(db, input.roomId);
  if (!room) throw new PersistenceConflictError("not_found", "v2 room not found", 404);
  if (room.phase_state === "FINISHED") return {
    roomId: input.roomId,
    state: "FINISHED",
    cutoffAtMs: room.cutoff_at_ms ?? room.deadline_at_ms ?? 0,
    finalizedAtMs: room.finalized_at_ms ?? input.nowMs,
    participantCount: Number((await db.prepare("SELECT COUNT(*) AS count FROM final_results WHERE room_id = ?").bind(input.roomId).first())?.count ?? 0)
  };
  if (room.start_at_ms == null || room.deadline_at_ms == null) return null;
  if (input.nowMs >= room.deadline_at_ms && room.phase_state !== "COLLECTING") {
    await collectV2Room(db, { roomId: input.roomId, nowMs: input.nowMs });
    room = await loadRoom(db, input.roomId);
  }
  const participants = (await db.prepare(`SELECT p.id, p.joined_order, p.status, v.finished_elapsed_ms, v.finish_reason, v.boundary_ack_at_ms
    FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
    WHERE p.room_id = ? AND p.status != 'REMOVED' ORDER BY p.joined_order`).bind(input.roomId).all()).results;
  const allFinished = participants.length > 0 && participants.every((p) => p.finished_elapsed_ms != null);
  const boundaryReady = participants.every((p) => p.finished_elapsed_ms != null || p.boundary_ack_at_ms != null);
  const cutoff = room.cutoff_at_ms ?? room.deadline_at_ms;
  const until = room.collection_until_ms ?? room.deadline_at_ms + 1e4;
  if (room.phase_state === "COLLECTING") {
    if (!boundaryReady && input.nowMs < until) return null;
  } else if (!allFinished) return null;
  const questions = (await db.prepare("SELECT answer_snapshot_json FROM room_questions WHERE room_id = ? ORDER BY ordinal").bind(input.roomId).all()).results.map((row) => JSON.parse(row.answer_snapshot_json));
  const operationRows = (await db.prepare(`SELECT participant_id, payload_json FROM v2_operations WHERE room_id = ? ORDER BY participant_id, seq`).bind(input.roomId).all()).results;
  const operations = /* @__PURE__ */ new Map();
  for (const row of operationRows) {
    const current = operations.get(row.participant_id) ?? [];
    current.push(JSON.parse(row.payload_json));
    operations.set(row.participant_id, current);
  }
  const scored = participants.map((participant) => {
    const replay = replayV2Operations(
      questions,
      room.grading_mode,
      operations.get(participant.id) ?? [],
      room.start_at_ms,
      cutoff,
      room.end_reason === "interrupted"
    );
    const elapsedMs = replay.finishedElapsedMs ?? cutoff - room.start_at_ms;
    return {
      participantId: participant.id,
      joinedOrder: participant.joined_order,
      correctCount: replay.correctCount,
      elapsedCs: Math.floor(elapsedMs / 10),
      finishReason: replay.finishReason === "submitted" ? "submitted" : replay.finishReason ? "completed" : room.end_reason === "interrupted" ? "interrupted" : "timeout",
      finalSyncUnconfirmed: !replay.finishReason && !replay.boundaryAcknowledged,
      fields: replay.fields
    };
  });
  scored.sort((a, b) => b.correctCount - a.correctCount || a.elapsedCs - b.elapsedCs || a.joinedOrder - b.joinedOrder);
  const ranked = [];
  scored.forEach((row, index) => {
    const previous = ranked.at(-1);
    ranked.push({ ...row, rank: previous && previous.correctCount === row.correctCount && previous.elapsedCs === row.elapsedCs ? previous.rank : index + 1 });
  });
  const fieldRows = ranked.flatMap((row) => questions.flatMap((question) => question.fields.map((field) => {
    const scoredField = row.fields[`${question.id}:${field.id}`];
    return {
      participantId: row.participantId,
      questionId: question.id,
      fieldId: field.id,
      state: scoredField?.state ?? "unanswered",
      answerJson: scoredField?.value == null ? null : json(scoredField.value)
    };
  })));
  const marker = commandMarker("v2-finalize", input.roomId);
  const retention = room.kind === "class" ? PUBLIC_CONFIG.retentionMs.classCompetition : PUBLIC_CONFIG.retentionMs.mateMatch;
  const statements = [db.prepare(`UPDATE rooms SET state = 'FINISHED', revision = revision + 1,
    ended_at_ms = ?, expires_at_ms = ? + ?, last_command_id = ?
    WHERE id = ? AND revision = ? AND state IN ('COUNTDOWN', 'RUNNING')
      AND EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state IN ('COUNTDOWN', 'COLLECTING'))`).bind(cutoff, input.nowMs, retention, marker, input.roomId, room.revision)];
  statements.push(db.prepare(`UPDATE v2_room_manifests SET state = 'FINISHED', finalized_at_ms = ? WHERE room_id = ?
    AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.nowMs, input.roomId, input.roomId, marker));
  statements.push(db.prepare(`INSERT INTO final_results(room_id, participant_id, correct_count, elapsed_cs, rank, finish_reason)
    SELECT ?, json_extract(value,'$.participantId'), json_extract(value,'$.correctCount'),
      json_extract(value,'$.elapsedCs'), json_extract(value,'$.rank'), json_extract(value,'$.finishReason')
    FROM json_each(?) WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.roomId, json(ranked.map(({ participantId, correctCount, elapsedCs, rank, finishReason }) => ({ participantId, correctCount, elapsedCs, rank, finishReason }))), input.roomId, marker));
  statements.push(db.prepare(`INSERT INTO v2_final_fields(room_id, participant_id, question_id, field_id, state, answer_json)
    SELECT ?, json_extract(value,'$.participantId'), json_extract(value,'$.questionId'),
      json_extract(value,'$.fieldId'), json_extract(value,'$.state'), json_extract(value,'$.answerJson')
    FROM json_each(?) WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.roomId, json(fieldRows), input.roomId, marker));
  statements.push(db.prepare(`UPDATE participants SET status = 'FINISHED', finished_at_ms = ?,
    correct_count = COALESCE((SELECT f.correct_count FROM final_results f WHERE f.room_id = participants.room_id AND f.participant_id = participants.id), 0),
    elapsed_cs = COALESCE((SELECT f.elapsed_cs FROM final_results f WHERE f.room_id = participants.room_id AND f.participant_id = participants.id), 0),
    wait_credit_ms = 0 WHERE room_id = ? AND status != 'REMOVED'
      AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(cutoff, input.roomId, input.roomId, marker));
  try {
    const results = await db.batch(statements);
    if (changed(results[0])) return {
      roomId: input.roomId,
      state: "FINISHED",
      cutoffAtMs: cutoff,
      finalizedAtMs: input.nowMs,
      participantCount: participants.length
    };
  } catch (error) {
    const after2 = await loadRoom(db, input.roomId);
    if (after2?.phase_state === "FINISHED") return maybeFinalizeV2Room(db, input);
    throw error;
  }
  const after = await loadRoom(db, input.roomId);
  if (after?.phase_state === "FINISHED") return maybeFinalizeV2Room(db, input);
  return null;
}

// src/platform/result-answer.ts
function decodeDisplayAnswer(stored) {
  if (stored === null) return { lastAnswer: null, lastAnswerEntry: null };
  let raw;
  try {
    raw = JSON.parse(stored);
  } catch {
    return { lastAnswer: null, lastAnswerEntry: null, answerDisplayUnavailable: true };
  }
  if (raw === null) return { lastAnswer: null, lastAnswerEntry: null };
  if (typeof raw === "string") return { lastAnswer: raw, lastAnswerEntry: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { lastAnswer: null, lastAnswerEntry: null, answerDisplayUnavailable: true };
  const candidate = raw;
  if (!Array.isArray(candidate.tokens) || !candidate.tokens.every((token) => typeof token === "string")) {
    return { lastAnswer: null, lastAnswerEntry: null, answerDisplayUnavailable: true };
  }
  const charge = candidate.charge;
  if (charge !== null && charge !== void 0 && (!charge || typeof charge !== "object" || Array.isArray(charge) || !["+", "-"].includes(charge.sign) || !Number.isSafeInteger(charge.magnitude) || Number(charge.magnitude) < 1)) return { lastAnswer: null, lastAnswerEntry: null, answerDisplayUnavailable: true };
  const entry = {
    ...candidate,
    tokens: candidate.tokens,
    charge: charge ?? null,
    cursor: Number.isSafeInteger(candidate.cursor) ? candidate.cursor : candidate.tokens.length
  };
  const suffix = entry.charge ? `${entry.charge.magnitude === 1 ? "" : entry.charge.magnitude}${entry.charge.sign}` : "";
  return { lastAnswer: entry.tokens.join("") + suffix, lastAnswerEntry: entry };
}

// src/platform/participant-auth.ts
var ParticipantAuthorizationError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ParticipantAuthorizationError";
  }
};
function readParticipantBearerToken(request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    throw new ParticipantAuthorizationError(
      401,
      "participant_authentication_required",
      "\u53C2\u52A0\u8005\u30C8\u30FC\u30AF\u30F3\u304C\u5FC5\u8981\u3067\u3059"
    );
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (!match) {
    throw new ParticipantAuthorizationError(403, "participant_forbidden", "\u53C2\u52A0\u8005\u30C8\u30FC\u30AF\u30F3\u304C\u4E0D\u6B63\u3067\u3059");
  }
  return match[1];
}
async function hashParticipantToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function identifyParticipant(database, request, roomId) {
  const token = readParticipantBearerToken(request);
  const tokenHash = await hashParticipantToken(token);
  const participant = await database.prepare(`
    SELECT id, status, nickname FROM participants
    WHERE room_id = ? AND token_hash = ?
  `).bind(roomId, tokenHash).first();
  if (!participant) {
    throw new ParticipantAuthorizationError(403, "participant_forbidden", "\u53C2\u52A0\u8005\u3068\u3057\u3066\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093");
  }
  const claimedId = request.headers.get("x-participant-id");
  if (claimedId && claimedId !== participant.id) {
    throw new ParticipantAuthorizationError(403, "participant_forbidden", "\u5225\u306E\u53C2\u52A0\u8005\u306E\u60C5\u5831\u306F\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093");
  }
  return { participantId: participant.id, tokenHash, status: participant.status, nickname: participant.nickname };
}
async function requireParticipant(database, request, roomId) {
  const participant = await identifyParticipant(database, request, roomId);
  if (participant.status === "REMOVED") {
    throw new ParticipantAuthorizationError(403, "participant_forbidden", "\u53C2\u52A0\u8005\u3068\u3057\u3066\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093");
  }
  return participant;
}

// src/platform/teacher-identity.ts
var TeacherIdentityError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "TeacherIdentityError";
  }
};
function normalizeTeacherEmail(email) {
  return email.normalize("NFKC").trim().toLowerCase();
}
async function requireVerifiedTeacher(request, provider) {
  let identity;
  try {
    identity = await provider.getVerifiedIdentity(request);
  } catch (error) {
    if (error instanceof TeacherIdentityError) throw error;
    throw new TeacherIdentityError(503, "identity_unavailable", "\u6559\u54E1\u8A8D\u8A3C\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093");
  }
  if (!identity || !identity.id.trim() || !identity.email.trim()) {
    throw new TeacherIdentityError(401, "authentication_required", "\u30ED\u30B0\u30A4\u30F3\u304C\u5FC5\u8981\u3067\u3059");
  }
  const email = normalizeTeacherEmail(identity.email);
  return { id: identity.id.trim(), email };
}
async function requireTeacher(request, provider, allowedEmails) {
  const identity = await requireVerifiedTeacher(request, provider);
  const email = identity.email;
  const normalizedAllowlist = new Set(allowedEmails.map(normalizeTeacherEmail).filter(Boolean));
  if (!normalizedAllowlist.has(email)) {
    throw new TeacherIdentityError(403, "teacher_forbidden", "\u6559\u54E1\u3068\u3057\u3066\u8A31\u53EF\u3055\u308C\u3066\u3044\u307E\u305B\u3093");
  }
  return { id: identity.id.trim(), email };
}

// src/platform/http.ts
var MAX_BODY_BYTES = 4096;
var MAX_OPERATION_BODY_BYTES = 128 * 1024;
var MAX_ANSWER_LENGTH = 128;
var LAZY_CLEANUP_LIMIT = 25;
var JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
var ApiError = class extends Error {
  constructor(status, code, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "ApiError";
  }
};
function responseHeaders() {
  return {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  };
}
function jsonResponse(value, status = 200, extraHeaders) {
  const headers = new Headers(responseHeaders());
  if (extraHeaders) new Headers(extraHeaders).forEach((headerValue, name) => headers.set(name, headerValue));
  return new Response(JSON.stringify(value), { status, headers });
}
function publicError(error) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...error.retryAfterSeconds ? { retryAfter: String(error.retryAfterSeconds) } : {}
    };
  }
  if (error instanceof PersistenceConflictError) {
    const status = [400, 401, 403, 404, 409, 410, 429, 503].includes(error.status) ? error.status : 409;
    const messages = {
      capacity: "\u5B9A\u54E1\u306B\u9054\u3057\u307E\u3057\u305F",
      active_room_exists: "\u7D42\u4E86\u3057\u3066\u3044\u306A\u3044\u30E1\u30A4\u30C8\u30DE\u30C3\u30C1\u304C\u3042\u308A\u307E\u3059",
      database_conflict: "\u4FDD\u5B58\u304C\u7AF6\u5408\u3057\u307E\u3057\u305F\u3002\u540C\u3058 requestId \u3067\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044",
      deadline: "\u5236\u9650\u6642\u9593\u3092\u904E\u304E\u3066\u3044\u307E\u3059",
      expired: "\u3053\u306E\u30EB\u30FC\u30E0\u306E\u95B2\u89A7\u671F\u9650\u306F\u7D42\u4E86\u3057\u307E\u3057\u305F",
      invalid_state: "\u73FE\u5728\u306E\u72B6\u614B\u3067\u306F\u64CD\u4F5C\u3067\u304D\u307E\u305B\u3093",
      mate_disabled: "\u30E1\u30A4\u30C8\u30DE\u30C3\u30C1\u306F\u73FE\u5728\u5229\u7528\u3067\u304D\u307E\u305B\u3093",
      not_authorized: "\u3053\u306E\u60C5\u5831\u3092\u95B2\u89A7\u3059\u308B\u6A29\u9650\u304C\u3042\u308A\u307E\u305B\u3093",
      not_found: "\u30EB\u30FC\u30E0\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093",
      participant_not_found: "\u53C2\u52A0\u8005\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093",
      not_ready: "\u307E\u3060\u958B\u59CB\u3067\u304D\u307E\u305B\u3093",
      rate_limited: "\u77ED\u6642\u9593\u306B\u4F5C\u6210\u3067\u304D\u308B\u56DE\u6570\u3092\u8D85\u3048\u307E\u3057\u305F",
      request_id_reused: "requestId \u304C\u5225\u306E\u64CD\u4F5C\u3067\u4F7F\u7528\u3055\u308C\u3066\u3044\u307E\u3059",
      stale_participant_revision: "\u5225\u306E\u753B\u9762\u3067\u72B6\u614B\u304C\u66F4\u65B0\u3055\u308C\u307E\u3057\u305F",
      stale_room_revision: "\u30EB\u30FC\u30E0\u306E\u72B6\u614B\u304C\u66F4\u65B0\u3055\u308C\u307E\u3057\u305F",
      stale_question_profile: "\u51FA\u984C\u8A2D\u5B9A\u304C\u66F4\u65B0\u3055\u308C\u307E\u3057\u305F\u3002\u6700\u65B0\u306E\u8A2D\u5B9A\u3092\u8AAD\u307F\u76F4\u3057\u3066\u304F\u3060\u3055\u3044"
    };
    return {
      status,
      code: error.code,
      message: messages[error.code] ?? "\u8981\u6C42\u3092\u51E6\u7406\u3067\u304D\u307E\u305B\u3093",
      ...error.retryAfterSeconds ? { retryAfter: String(error.retryAfterSeconds) } : {}
    };
  }
  if (error instanceof TeacherIdentityError || error instanceof ParticipantAuthorizationError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return { status: 400, code: "invalid_request", message: "\u5165\u529B\u5185\u5BB9\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044" };
  }
  if (typeof error === "object" && error !== null && /(?:constraint|unique)/iu.test([
    String(error.code ?? ""),
    String(error.message ?? "")
  ].join(" "))) {
    return { status: 409, code: "conflict", message: "\u540C\u3058\u5185\u5BB9\u304C\u3059\u3067\u306B\u4F7F\u7528\u3055\u308C\u3066\u3044\u307E\u3059" };
  }
  return { status: 503, code: "service_unavailable", message: "\u30B5\u30FC\u30D3\u30B9\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093" };
}
async function safe(handler, propagateSqlErrors = false) {
  try {
    return await handler();
  } catch (error) {
    if (propagateSqlErrors && typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) throw error;
    const mapped = publicError(error);
    if (mapped.status >= 500 || error instanceof TypeError || error instanceof RangeError) {
      const candidate = error;
      console.error(JSON.stringify({
        event: "handler_failed",
        category: typeof candidate?.name === "string" ? candidate.name : "Unknown",
        code: typeof candidate?.code === "string" && /^[A-Z0-9]{5}$/.test(candidate.code) ? candidate.code : void 0,
        frames: typeof candidate?.stack === "string" ? candidate.stack.split("\n").filter((line) => /^\s+at\s/.test(line)).slice(0, 3).map((line) => line.slice(0, 240)) : void 0
      }));
    }
    return jsonResponse(
      { error: { code: mapped.code, message: mapped.message } },
      mapped.status,
      mapped.retryAfter ? { "retry-after": mapped.retryAfter } : void 0
    );
  }
}
async function resultSafe(handler, operation) {
  const requestId2 = crypto.randomUUID();
  let protocolVersion;
  try {
    return await handler(requestId2, (version) => {
      protocolVersion = version;
    });
  } catch (error) {
    if (error instanceof ApiError || error instanceof PersistenceConflictError || error instanceof TeacherIdentityError || error instanceof ParticipantAuthorizationError) {
      const mapped = publicError(error);
      return jsonResponse(
        { error: { code: mapped.code, message: mapped.message } },
        mapped.status,
        mapped.retryAfter ? { "retry-after": mapped.retryAfter } : void 0
      );
    }
    console.error(JSON.stringify({
      event: "result_build_failed",
      operation,
      requestId: requestId2,
      protocolVersion,
      category: error instanceof Error ? error.name : "Unknown"
    }));
    return jsonResponse(
      { error: { code: "result_build_failed", message: "\u7D50\u679C\u306E\u8868\u793A\u3092\u6E96\u5099\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044", requestId: requestId2 } },
      500,
      { "x-request-id": requestId2 }
    );
  }
}
function assertSameOriginMutation(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== requestUrl.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "origin_forbidden", "\u5225\u306E\u30B5\u30A4\u30C8\u304B\u3089\u306E\u64CD\u4F5C\u306F\u53D7\u3051\u4ED8\u3051\u307E\u305B\u3093");
  }
  if (request.headers.get("x-competition-csrf") !== "1") {
    throw new ApiError(403, "csrf_forbidden", "\u64CD\u4F5C\u306E\u78BA\u8A8D\u60C5\u5831\u304C\u3042\u308A\u307E\u305B\u3093");
  }
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readMutationBody(request, maxBodyBytes = MAX_BODY_BYTES) {
  assertSameOriginMutation(request);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "JSON\u3067\u9001\u4FE1\u3057\u3066\u304F\u3060\u3055\u3044");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBodyBytes)) {
    throw new ApiError(413, "body_too_large", "\u9001\u4FE1\u5185\u5BB9\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
  }
  if (!request.body) throw new ApiError(400, "invalid_json", "JSON\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    bytesRead += chunk.byteLength;
    if (bytesRead > maxBodyBytes) {
      await reader.cancel("body too large");
      throw new ApiError(413, "body_too_large", "\u9001\u4FE1\u5185\u5BB9\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "JSON\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093");
  }
  if (!isRecord(value)) throw new ApiError(400, "invalid_request", "JSON\u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u304C\u5FC5\u8981\u3067\u3059");
  return { value, bodyHash: await sha256(text) };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertKeys(value, allowed) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key2) => !allowedSet.has(key2))) {
    throw new ApiError(400, "invalid_request", "\u53D7\u3051\u4ED8\u3051\u3066\u3044\u306A\u3044\u9805\u76EE\u304C\u3042\u308A\u307E\u3059");
  }
}
function stringValue(value, name, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ApiError(400, "invalid_request", `${name}\u304C\u4E0D\u6B63\u3067\u3059`);
  }
  return value;
}
var FORMULA_TOKEN = /^(?:[A-Za-z]|[A-Z][a-z]?|\d+|[()[\]])$/u;
function formulaEntryValue(value) {
  if (!isRecord(value)) throw new ApiError(400, "invalid_request", "\u56DE\u7B54\u304C\u4E0D\u6B63\u3067\u3059");
  assertKeys(value, ["tokens", "cursor", "charge"]);
  if (!Array.isArray(value.tokens) || value.tokens.length < 1 || value.tokens.length > 64 || value.tokens.some((token) => typeof token !== "string" || !FORMULA_TOKEN.test(token)) || value.tokens.join("").length > MAX_ANSWER_LENGTH) {
    throw new ApiError(400, "invalid_request", "\u56DE\u7B54\u304C\u4E0D\u6B63\u3067\u3059");
  }
  if (!Number.isSafeInteger(value.cursor) || value.cursor < 0 || value.cursor > value.tokens.length) {
    throw new ApiError(400, "invalid_request", "\u56DE\u7B54\u304C\u4E0D\u6B63\u3067\u3059");
  }
  let charge = null;
  if (value.charge !== null) {
    if (!isRecord(value.charge)) throw new ApiError(400, "invalid_request", "\u56DE\u7B54\u304C\u4E0D\u6B63\u3067\u3059");
    assertKeys(value.charge, ["magnitude", "sign", "source"]);
    if (!Number.isSafeInteger(value.charge.magnitude) || value.charge.magnitude < 1 || value.charge.magnitude > 9 || value.charge.sign !== "+" && value.charge.sign !== "-" || value.charge.source !== "chargeButton") {
      throw new ApiError(400, "invalid_request", "\u56DE\u7B54\u304C\u4E0D\u6B63\u3067\u3059");
    }
    charge = {
      magnitude: value.charge.magnitude,
      sign: value.charge.sign,
      source: "chargeButton"
    };
  }
  return { tokens: [...value.tokens], cursor: value.cursor, charge };
}
function integerValue(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ApiError(400, "invalid_request", `${name}\u304C\u4E0D\u6B63\u3067\u3059`);
  }
  return value;
}
function requestId(value) {
  const id = stringValue(value, "requestId", 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new ApiError(400, "invalid_request", "requestId\u304C\u4E0D\u6B63\u3067\u3059");
  return id;
}
function parseSettings(value) {
  if (!isRecord(value)) throw new ApiError(400, "invalid_settings", "\u7AF6\u6280\u8A2D\u5B9A\u304C\u4E0D\u6B63\u3067\u3059");
  assertKeys(value, [
    "questionCount",
    "timeLimitMinutes",
    "mode",
    "difficulty",
    "ionAnswer",
    "compoundPrompts",
    "compoundAnswer",
    "gradingMode",
    "complexEnabled",
    "chemistryContentVersion"
  ]);
  if (!isRecord(value.compoundPrompts)) throw new ApiError(400, "invalid_settings", "\u51FA\u984C\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
  assertKeys(value.compoundPrompts, ["formula", "name"]);
  if (typeof value.compoundPrompts.formula !== "boolean" || typeof value.compoundPrompts.name !== "boolean") {
    throw new ApiError(400, "invalid_settings", "\u51FA\u984C\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
  }
  const settings = {
    ...value,
    gradingMode: value.gradingMode ?? "immediate",
    complexEnabled: value.complexEnabled === void 0 ? false : value.complexEnabled,
    chemistryContentVersion: value.chemistryContentVersion === void 0 ? CHEMISTRY_CONTENT_VERSION : value.chemistryContentVersion
  };
  try {
    validateGameSettings(settings);
  } catch {
    throw new ApiError(400, "invalid_settings", "\u7AF6\u6280\u8A2D\u5B9A\u304C\u4E0D\u6B63\u3067\u3059");
  }
  return settings;
}
function normalizeNickname(value) {
  if (typeof value !== "string") throw new ApiError(400, "invalid_nickname", "\u30CB\u30C3\u30AF\u30CD\u30FC\u30E0\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044");
  const nickname = value.trim();
  const length = Array.from(nickname).length;
  if (length < 1 || length > 16 || /[\u0000-\u001f\u007f-\u009f]/u.test(nickname)) {
    throw new ApiError(400, "invalid_nickname", "\u30CB\u30C3\u30AF\u30CD\u30FC\u30E0\u306F1\u301C16\u6587\u5B57\u3067\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044");
  }
  return { nickname, nicknameKey: nickname.normalize("NFKC").toLocaleLowerCase("ja-JP") };
}
function joinCode(random) {
  return Array.from({ length: 6 }, () => {
    const index = Math.min(JOIN_CODE_ALPHABET.length - 1, Math.floor(random() * JOIN_CODE_ALPHABET.length));
    return JOIN_CODE_ALPHABET[index];
  }).join("");
}
async function loadRoom2(database, externalId) {
  if (!externalId || externalId.length > 128) throw new ApiError(404, "not_found", "\u30EB\u30FC\u30E0\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
  const room = await database.prepare(`
    SELECT id, public_id, join_code, kind, owner_teacher_id, mate_host_id,
      settings_json, game_version, state, revision, max_score, created_at_ms, start_at_ms, deadline_at_ms, expires_at_ms, ended_at_ms, end_reason,
      (SELECT state FROM v2_room_manifests WHERE room_id = rooms.id) AS v2_phase
    FROM rooms WHERE public_id = ? OR id = ?
  `).bind(externalId, externalId).first();
  if (!room) throw new ApiError(404, "not_found", "\u30EB\u30FC\u30E0\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
  return room;
}
function requireUnexpired(room, nowMs) {
  if (room.expires_at_ms <= nowMs) {
    throw new ApiError(410, "expired", "\u3053\u306E\u30EB\u30FC\u30E0\u306E\u95B2\u89A7\u671F\u9650\u306F\u7D42\u4E86\u3057\u307E\u3057\u305F");
  }
}
function stateOf(room, nowMs) {
  if (room.game_version === "2") {
    if (room.state === "CANCELLED" || room.state === "EXPIRED") return room.state;
    if (room.v2_phase === "PREPARING" || room.v2_phase === "COLLECTING" || room.v2_phase === "FINISHED") return room.v2_phase;
    if ((room.v2_phase === "COUNTDOWN" || room.state === "COUNTDOWN") && room.start_at_ms != null && nowMs >= room.start_at_ms) return "RUNNING";
    return room.v2_phase ?? room.state;
  }
  return effectiveRoomState({
    storedState: room.state,
    startAtMs: room.start_at_ms,
    deadlineAtMs: room.deadline_at_ms
  }, nowMs);
}
async function readTeacherAllowlist(database) {
  return await database.prepare("SELECT emails_json, revision, last_request_id, last_body_hash FROM teacher_allowlist WHERE id = 1").first() ?? { emails_json: "[]", revision: 0, last_request_id: null, last_body_hash: null };
}
async function requireApplicationTeacher(dependencies, request) {
  const master = dependencies.serverConfig.masterTeacherEmail;
  if (!master) return requireTeacher(request, dependencies.teacherIdentity, dependencies.serverConfig.teacherAllowedEmails);
  const identity = await requireVerifiedTeacher(request, dependencies.teacherIdentity);
  if (identity.email === master) return identity;
  const list = await readTeacherAllowlist(dependencies.database);
  if (!JSON.parse(list.emails_json).includes(identity.email)) {
    throw new TeacherIdentityError(403, "teacher_forbidden", "\u6559\u54E1\u3068\u3057\u3066\u8A31\u53EF\u3055\u308C\u3066\u3044\u307E\u305B\u3093");
  }
  return identity;
}
async function authorizeTeacherOwner(dependencies, request, room) {
  const teacher = await requireApplicationTeacher(dependencies, request);
  if (room.kind !== "class" || room.owner_teacher_id !== teacher.id) {
    throw new ApiError(403, "room_owner_forbidden", "\u3053\u306E\u30EB\u30FC\u30E0\u3092\u64CD\u4F5C\u3059\u308B\u6A29\u9650\u304C\u3042\u308A\u307E\u305B\u3093");
  }
  return teacher;
}
async function authorizeRoomOwner(dependencies, request, room) {
  if (request.headers.has("authorization")) {
    const participant = await requireParticipant(dependencies.database, request, room.id);
    if (room.kind !== "mate" || room.mate_host_id !== participant.participantId) {
      throw new ApiError(403, "room_owner_forbidden", "\u3053\u306E\u30EB\u30FC\u30E0\u3092\u64CD\u4F5C\u3059\u308B\u6A29\u9650\u304C\u3042\u308A\u307E\u305B\u3093");
    }
    return { kind: "participant", id: participant.participantId };
  }
  const teacher = await authorizeTeacherOwner(dependencies, request, room);
  return { kind: "teacher", id: teacher.id };
}
async function readMateEnabled(database) {
  const row = await database.prepare(
    "SELECT mate_match_enabled, revision FROM site_settings WHERE id = 1"
  ).first();
  return row ? { enabled: row.mate_match_enabled === 1, revision: row.revision } : { enabled: true, revision: 0 };
}
async function tryFinalize(database, room, nowMs) {
  if (room.game_version === "2") {
    if (room.v2_phase === "COUNTDOWN" || room.v2_phase === "COLLECTING" || room.v2_phase === "FINISHED")
      await maybeFinalizeV2Room(database, { roomId: room.id, nowMs });
    return;
  }
  const effective = stateOf(room, nowMs);
  if (effective !== "FINISHED" || room.state === "FINISHED") return;
  try {
    await finalizeRoom(database, {
      roomId: room.id,
      requestId: `deadline-${room.deadline_at_ms ?? nowMs}`,
      bodyHash: `deadline-${room.deadline_at_ms ?? nowMs}`,
      nowMs
    });
  } catch (error) {
    if (!(error instanceof PersistenceConflictError && error.code === "invalid_state")) throw error;
  }
}
async function participantState(database, room, participantId, nowMs) {
  const participant = await database.prepare(`
    SELECT id, nickname, status, joined_order, current_ordinal, correct_count, resolved_question_count,
      revision, elapsed_cs, accepted_elapsed_ms, wait_credit_ms, timing_source
    FROM participants WHERE room_id = ? AND id = ? AND status != 'REMOVED'
  `).bind(room.id, participantId).first();
  if (!participant) throw new ApiError(403, "participant_forbidden", "\u53C2\u52A0\u8005\u3068\u3057\u3066\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093");
  let question = null;
  if (room.game_version !== "2" && stateOf(room, nowMs) === "RUNNING" && participant.status === "ACTIVE") {
    const row = await database.prepare(`
      SELECT public_payload_json FROM room_questions
      WHERE room_id = ? AND ordinal = ?
    `).bind(room.id, participant.current_ordinal).first();
    if (row) {
      const publicQuestion = JSON.parse(row.public_payload_json);
      const { results: resolved } = await database.prepare(`
        SELECT field_id, state FROM participant_fields
        WHERE room_id = ? AND participant_id = ? AND question_id = ?
        ORDER BY field_id
      `).bind(room.id, participant.id, publicQuestion.id).all();
      question = {
        ...publicQuestion,
        progress: { resolvedFieldIds: resolved.filter((field) => field.state === "correct" || field.state === "passed").map((field) => field.field_id), fieldStates: Object.fromEntries(resolved.map((field) => [field.field_id, field.state])) }
      };
    }
  }
  return {
    participant: {
      id: participant.id,
      joinedOrder: participant.joined_order,
      nickname: participant.nickname,
      status: participant.status,
      currentOrdinal: participant.current_ordinal,
      correctCount: participant.correct_count,
      resolvedQuestionCount: participant.resolved_question_count,
      revision: participant.revision,
      elapsedCs: participant.elapsed_cs,
      rawElapsedMs: participant.accepted_elapsed_ms,
      waitCreditMs: participant.wait_credit_ms,
      timingSource: participant.timing_source
    },
    question
  };
}
async function teacherProgress(database, roomId) {
  const { results } = await database.prepare(`
    SELECT id, nickname, status, joined_order, current_ordinal, correct_count, resolved_question_count,
      revision, elapsed_cs, timing_source, COALESCE(v.answered_count, 0) AS answered_count,
      v.finished_elapsed_ms
    FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
    WHERE p.room_id = ? AND p.status != 'REMOVED' ORDER BY p.joined_order
  `).bind(roomId).all();
  return results.map((participant) => ({
    id: participant.id,
    joinedOrder: participant.joined_order,
    nickname: participant.nickname,
    status: participant.status,
    currentOrdinal: participant.current_ordinal,
    correctCount: participant.correct_count,
    resolvedQuestionCount: participant.resolved_question_count,
    revision: participant.revision,
    elapsedCs: participant.elapsed_cs,
    timingSource: participant.timing_source,
    answeredCount: participant.answered_count,
    submitted: participant.finished_elapsed_ms != null
  }));
}
function roomView(room, nowMs) {
  return {
    id: room.public_id,
    playProtocolVersion: room.game_version === "2" ? 2 : 1,
    gradingMode: JSON.parse(room.settings_json).gradingMode ?? "immediate",
    kind: room.kind,
    state: stateOf(room, nowMs),
    revision: room.revision,
    settings: JSON.parse(room.settings_json),
    maxScore: room.max_score,
    createdAtMs: room.created_at_ms,
    startAtMs: room.start_at_ms,
    deadlineAtMs: room.deadline_at_ms,
    expiresAtMs: room.expires_at_ms,
    endedAtMs: room.ended_at_ms,
    endReason: room.end_reason
  };
}
function correctAnswer(question, fieldId) {
  const specification = question.answer.type === "both" ? question.answer[fieldId] : question.answer;
  return specification.canonical;
}
async function participantQuestionResults(database, roomId, participantId, protocolVersion = 1, requestId2) {
  const fieldSource = protocolVersion === 2 ? "v2_final_fields f" : "participant_fields f";
  const fieldColumns = protocolVersion === 2 ? "0 AS attempt_count, f.answer_json AS last_answer_json, CASE WHEN f.state = 'correct' THEN 1 WHEN f.state = 'incorrect' THEN 0 ELSE NULL END AS last_answer_correct" : "f.attempt_count, f.last_answer_json, f.last_answer_correct";
  const { results } = await database.prepare(`
    SELECT q.question_id, q.ordinal, q.public_payload_json, q.answer_snapshot_json,
      f.field_id, f.state, ${fieldColumns}
    FROM room_questions q
    JOIN ${fieldSource} ON f.room_id = q.room_id AND f.question_id = q.question_id
    WHERE q.room_id = ? AND f.participant_id = ?
    ORDER BY q.ordinal, json_extract(q.field_spec_json, '$[0].id') != f.field_id, f.field_id
  `).bind(roomId, participantId).all();
  const questions = /* @__PURE__ */ new Map();
  let unavailableCount = 0;
  for (const row of results) {
    const internal = JSON.parse(row.answer_snapshot_json);
    const publicQuestion = JSON.parse(row.public_payload_json);
    const question = questions.get(row.question_id) ?? {
      id: row.question_id,
      ordinal: row.ordinal,
      prompt: publicQuestion.prompt,
      fields: []
    };
    const displayAnswer = decodeDisplayAnswer(row.last_answer_json);
    if (displayAnswer.answerDisplayUnavailable) unavailableCount += 1;
    question.fields.push({
      id: row.field_id,
      state: row.state,
      correctAnswer: correctAnswer(internal, row.field_id),
      correctFormulaCore: row.field_id === "formula" && internal.ionCharge != null ? internal.ionFormula ?? null : null,
      correctFormulaCharge: row.field_id === "formula" ? internal.ionCharge ?? null : null,
      ...displayAnswer,
      lastAnswerCorrect: row.last_answer_correct === null ? null : row.last_answer_correct === 1,
      attemptCount: row.attempt_count
    });
    questions.set(row.question_id, question);
  }
  if (unavailableCount) console.warn(JSON.stringify({
    event: "result_answer_unavailable",
    requestId: requestId2,
    protocolVersion,
    unavailableCount
  }));
  return [...questions.values()];
}
async function teacherResultAggregate(database, room) {
  const fieldTable = room.game_version === "2" ? "v2_final_fields" : "participant_fields";
  const totals = await database.prepare(`
    SELECT COUNT(*) AS participant_count,
      COALESCE(AVG(correct_count), 0) AS average_correct_count,
      COALESCE(SUM(CASE WHEN correct_count = ? THEN 1 ELSE 0 END), 0) AS perfect_count,
      COALESCE(SUM(CASE WHEN finish_reason = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count
    FROM final_results WHERE room_id = ?
  `).bind(room.max_score, room.id).first();
  const participantCount = Number(totals?.participant_count ?? 0);
  const { results: rows } = await database.prepare(`
    SELECT q.question_id, q.ordinal, q.answer_snapshot_json, f.field_id,
      SUM(CASE WHEN f.state = 'correct' THEN 1 ELSE 0 END) AS correct_count,
      SUM(CASE WHEN f.state = 'passed' THEN 1 ELSE 0 END) AS passed_count,
      SUM(CASE WHEN f.state = 'unanswered' THEN 1 ELSE 0 END) AS unanswered_count
    FROM room_questions q
    JOIN ${fieldTable} f ON f.room_id = q.room_id AND f.question_id = q.question_id
    WHERE q.room_id = ?
    GROUP BY q.question_id, q.ordinal, q.answer_snapshot_json, f.field_id
    ORDER BY q.ordinal, f.field_id
  `).bind(room.id).all();
  const questions = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const internal = JSON.parse(row.answer_snapshot_json);
    const question = questions.get(row.question_id) ?? { id: row.question_id, ordinal: row.ordinal, fields: [] };
    const fieldCorrectCount = Number(row.correct_count);
    question.fields.push({
      id: row.field_id,
      correctAnswer: correctAnswer(internal, row.field_id),
      correctCount: fieldCorrectCount,
      passedCount: Number(row.passed_count),
      unansweredCount: Number(row.unanswered_count),
      correctRate: participantCount ? fieldCorrectCount / participantCount : 0
    });
    questions.set(row.question_id, question);
  }
  return {
    participantCount,
    averageCorrectCount: Number(totals?.average_correct_count ?? 0),
    perfectCount: Number(totals?.perfect_count ?? 0),
    completedCount: Number(totals?.completed_count ?? 0),
    questions: [...questions.values()]
  };
}
function createApiHandlers(dependencies) {
  const publicConfig = (request) => safe(async () => {
    const mate = await readMateEnabled(dependencies.database);
    return jsonResponse({
      ...PUBLIC_CONFIG,
      mateMatchEnabled: mate.enabled
    });
  });
  const joinInfo = (request) => safe(async () => {
    const search = new URL(request.url).searchParams;
    const rawCode = search.get("code");
    const rawPublicId = search.get("publicId");
    if (rawCode === null === (rawPublicId === null)) {
      throw new ApiError(400, "invalid_room_lookup", "\u53C2\u52A0\u5148\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
    }
    const code = rawCode?.trim().toUpperCase() ?? null;
    const publicId = rawPublicId?.trim() ?? null;
    if (code !== null && !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u.test(code)) {
      throw new ApiError(400, "invalid_join_code", "\u53C2\u52A0\u30B3\u30FC\u30C9\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
    }
    if (publicId !== null && !/^[A-Za-z0-9_-]{1,128}$/u.test(publicId)) {
      throw new ApiError(400, "invalid_public_id", "\u53C2\u52A0\u5148\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
    }
    const nowMs = dependencies.now();
    const room = await dependencies.database.prepare(`
      SELECT id, public_id, join_code, kind, owner_teacher_id, mate_host_id,
        settings_json, game_version, state, revision, max_score, start_at_ms, deadline_at_ms, expires_at_ms,
        (SELECT state FROM v2_room_manifests WHERE room_id = rooms.id) AS v2_phase
      FROM rooms WHERE (${code === null ? "public_id" : "join_code"}) = ?
    `).bind(publicId ?? code).first();
    if (!room) throw new ApiError(404, "not_found", "\u30EB\u30FC\u30E0\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
    requireUnexpired(room, nowMs);
    const count = await dependencies.database.prepare(
      "SELECT COUNT(*) AS count FROM participants WHERE room_id = ? AND status != 'REMOVED'"
    ).bind(room.id).first();
    return jsonResponse({
      room: {
        id: room.public_id,
        kind: room.kind,
        state: stateOf(room, nowMs),
        settings: JSON.parse(room.settings_json)
      },
      participantCount: Number(count?.count ?? 0),
      capacity: room.kind === "class" ? PUBLIC_CONFIG.participantLimits.classCompetition : PUBLIC_CONFIG.participantLimits.mateMatch
    });
  });
  const createClassRoom = (request) => safe(async () => {
    const teacher = await requireApplicationTeacher(dependencies, request);
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "settings"]);
    const idempotencyKey = requestId(value.requestId);
    const requestedV2 = isRecord(value.settings) && value.settings.gradingMode !== void 0;
    const settings = parseSettings(value.settings);
    const questionProfile = await readQuestionProfile(dependencies.database);
    const validated = validateGameSettings(settings, questionProfile.profile);
    const nowMs = dependencies.now();
    await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
    const created = await createRoom(dependencies.database, {
      roomId: dependencies.randomUUID(),
      publicId: dependencies.randomUUID(),
      joinCode: joinCode(dependencies.random),
      kind: "class",
      ownerTeacherId: teacher.id,
      settings,
      gameId: "ionic-formula",
      gameVersion: requestedV2 ? "2" : "1",
      datasetVersion: CHEMISTRY_CONTENT_VERSION,
      questionProfile,
      maxScore: validated.maxScore,
      actorKeyHash: await sha256(`teacher:${teacher.id}`),
      requestId: idempotencyKey,
      bodyHash: bodyHash2,
      nowMs,
      expiresAtMs: nowMs + PUBLIC_CONFIG.waitingRoomLifetimeMs
    });
    return jsonResponse({ room: { id: created.publicId, joinCode: created.joinCode, kind: created.kind, state: created.state, revision: created.revision } }, 201);
  });
  const createMateRoom = (request) => safe(async () => {
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "settings", "nickname"]);
    const creationKey = request.headers.get("x-creation-key") ?? "";
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(creationKey)) {
      throw new ApiError(401, "creation_credential_required", "\u4F5C\u6210\u8CC7\u683C\u304C\u5FC5\u8981\u3067\u3059");
    }
    const token = readParticipantBearerToken(request);
    const tokenHash = await hashParticipantToken(token);
    const credentialBoundBodyHash = await sha256(`${bodyHash2}:${tokenHash}`);
    const nickname2 = normalizeNickname(value.nickname);
    const requestedV2 = isRecord(value.settings) && value.settings.gradingMode !== void 0;
    const settings = parseSettings(value.settings);
    const questionProfile = await readQuestionProfile(dependencies.database);
    const validated = validateGameSettings(settings, questionProfile.profile);
    const nowMs = dependencies.now();
    await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
    const hostId = dependencies.randomUUID();
    const created = await createRoom(dependencies.database, {
      roomId: dependencies.randomUUID(),
      publicId: dependencies.randomUUID(),
      joinCode: joinCode(dependencies.random),
      kind: "mate",
      ownerTeacherId: null,
      settings,
      gameId: "ionic-formula",
      gameVersion: requestedV2 ? "2" : "1",
      datasetVersion: CHEMISTRY_CONTENT_VERSION,
      questionProfile,
      maxScore: validated.maxScore,
      actorKeyHash: await sha256(`creator:${creationKey}`),
      requestId: requestId(value.requestId),
      bodyHash: credentialBoundBodyHash,
      nowMs,
      expiresAtMs: nowMs + PUBLIC_CONFIG.waitingRoomLifetimeMs,
      host: { participantId: hostId, tokenHash, ...nickname2 }
    });
    return jsonResponse({
      room: { id: created.publicId, joinCode: created.joinCode, kind: created.kind, state: created.state, revision: created.revision },
      participant: created.hostParticipant
    }, 201);
  });
  const join = (request, parameters) => safe(async () => {
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "nickname"]);
    const room = await loadRoom2(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    const token = readParticipantBearerToken(request);
    const tokenHash = await hashParticipantToken(token);
    const nickname2 = normalizeNickname(value.nickname);
    const joined = await joinRoom(dependencies.database, {
      roomId: room.id,
      participantId: dependencies.randomUUID(),
      tokenHash,
      ...nickname2,
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      nowMs
    });
    return jsonResponse({
      participant: {
        id: joined.participantId,
        nickname: nickname2.nickname,
        joinedOrder: joined.joinedOrder,
        revision: joined.participantRevision
      }
    }, 201);
  });
  const nickname = (request, parameters) => safe(async () => {
    assertSameOriginMutation(request);
    const room = await loadRoom2(dependencies.database, parameters.id);
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedParticipantRevision", "nickname"]);
    const normalized = normalizeNickname(value.nickname);
    const result = await renameParticipant(dependencies.database, {
      roomId: room.id,
      participantId: participant.participantId,
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      expectedParticipantRevision: integerValue(value.expectedParticipantRevision, "expectedParticipantRevision"),
      ...normalized,
      nowMs: dependencies.now()
    });
    return jsonResponse({ participant: result });
  });
  const updateRoomSettings = (request, parameters) => safe(async () => {
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedRevision", "settings"]);
    const idempotencyKey = requestId(value.requestId);
    const room = await loadRoom2(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    const owner = await authorizeRoomOwner(dependencies, request, room);
    const expectedRevision = integerValue(value.expectedRevision, "expectedRevision");
    const settings = parseSettings(value.settings);
    const questionProfile = await readRoomQuestionProfile(dependencies.database, room.id);
    const validated = validateGameSettings(settings, questionProfile);
    const result = await updateRoomSettingsCommand(dependencies.database, {
      roomId: room.id,
      actorId: `${owner.kind}:${owner.id}`,
      requestId: idempotencyKey,
      bodyHash: bodyHash2,
      expectedRevision,
      settings,
      maxScore: validated.maxScore,
      nowMs
    });
    return jsonResponse({ room: { id: room.public_id, ...result } });
  });
  const start = (request, parameters) => safe(async () => {
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedRevision"]);
    const room = await loadRoom2(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await authorizeRoomOwner(dependencies, request, room);
    const replay = await loadCommandReceipt(dependencies.database, room.id, room.game_version === "2" ? `v2-prepare:${room.id}` : `room:${room.id}`, requestId(value.requestId), bodyHash2);
    if (replay) return jsonResponse(room.game_version === "2" ? replay : { state: replay.state, roomRevision: replay.roomRevision, startAtMs: replay.startAtMs, deadlineAtMs: replay.deadlineAtMs });
    const settings = parseSettings(JSON.parse(room.settings_json));
    const questionProfile = await readRoomQuestionProfile(dependencies.database, room.id);
    if (room.game_version === "2") {
      return jsonResponse(await prepareV2Room(dependencies.database, {
        roomId: room.id,
        requestId: requestId(value.requestId),
        bodyHash: bodyHash2,
        expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"),
        nowMs: dependencies.now(),
        clock: dependencies.now,
        manifestId: dependencies.randomUUID(),
        evaluatorVersion: EVALUATOR_VERSION,
        gradingMode: settings.gradingMode ?? "immediate",
        questions: generateQuestionSet(settings, dependencies.random, questionProfile)
      }));
    }
    const questions = generateQuestionSet(settings, dependencies.random, questionProfile);
    const scheduledAt = dependencies.now();
    const startAtMs = scheduledAt + PUBLIC_CONFIG.countdownSeconds * 1e3;
    const started = await startRoom(dependencies.database, {
      roomId: room.id,
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"),
      nowMs: scheduledAt,
      clock: dependencies.now,
      startAtMs,
      deadlineAtMs: startAtMs + settings.timeLimitMinutes * 6e4,
      questions
    });
    return jsonResponse({
      state: started.state,
      roomRevision: started.roomRevision,
      startAtMs: started.startAtMs,
      deadlineAtMs: started.deadlineAtMs
    });
  });
  const startStatus = (request, parameters) => safe(async () => {
    const key2 = new URL(request.url).searchParams.get("requestId");
    if (!key2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key2)) throw new ApiError(400, "invalid_request", "\u958B\u59CB\u8981\u6C42\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
    const room = await loadRoom2(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await authorizeRoomOwner(dependencies, request, room);
    const actor = room.game_version === "2" ? `v2-prepare:${room.id}` : `room:${room.id}`;
    const receipt2 = await dependencies.database.prepare(`SELECT result_json, processed_at_ms FROM command_receipts
      WHERE room_id=? AND actor_id=? AND request_id=? AND expires_at_ms>?`).bind(room.id, actor, key2, nowMs).first();
    const phase = room.game_version === "2" ? await loadV2RoomPhase(dependencies.database, room.id, nowMs) : null;
    const stored = receipt2 ? JSON.parse(receipt2.result_json) : null;
    return jsonResponse({
      requestId: key2,
      receipt: receipt2 ? {
        protocolVersion: room.game_version === "2" ? 2 : 1,
        roomRevision: stored.roomRevision,
        ...stored.manifestId ? { manifestId: stored.manifestId, preparationGeneration: stored.preparationGeneration } : {},
        processedAtMs: receipt2.processed_at_ms
      } : null,
      room: {
        state: stateOf(room, nowMs),
        revision: room.revision,
        startAtMs: room.start_at_ms,
        expiresAtMs: room.expires_at_ms,
        manifestId: phase?.manifestId ?? null,
        preparationGeneration: phase?.preparationGeneration ?? null,
        preparationTimedOut: phase?.preparationTimedOut ?? false
      },
      serverNow: nowMs
    });
  });
  const manifest = (request, parameters) => safe(async () => {
    const room = dependencies.snapshotRoom ?? await loadRoom2(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "\u554F\u984C\u306E\u6E96\u5099\u60C5\u5831\u304C\u3042\u308A\u307E\u305B\u3093");
    const participant = await requireParticipant(dependencies.database, request, room.id);
    return jsonResponse(await loadV2Manifest(dependencies.database, room.id, participant.participantId));
  });
  const ready = (request, parameters) => safe(async () => {
    const room = await loadRoom2(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "\u6E96\u5099\u60C5\u5831\u304C\u3042\u308A\u307E\u305B\u3093");
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value } = await readMutationBody(request);
    assertKeys(value, ["manifestId", "preparationGeneration", "evaluatorVersion"]);
    return jsonResponse(await markV2Ready(dependencies.database, {
      roomId: room.id,
      participantId: participant.participantId,
      manifestId: stringValue(value.manifestId, "manifestId", 128),
      evaluatorVersion: stringValue(value.evaluatorVersion, "evaluatorVersion", 128),
      preparationGeneration: integerValue(value.preparationGeneration, "preparationGeneration", 1),
      nowMs: dependencies.now(),
      clock: dependencies.now
    }));
  });
  const cancelPreparation = (request, parameters) => safe(async () => {
    const room = await loadRoom2(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "\u6E96\u5099\u60C5\u5831\u304C\u3042\u308A\u307E\u305B\u3093");
    await authorizeRoomOwner(dependencies, request, room);
    const { value } = await readMutationBody(request);
    assertKeys(value, ["expectedRevision"]);
    return jsonResponse(await cancelV2Preparation(dependencies.database, {
      roomId: room.id,
      expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"),
      nowMs: dependencies.now()
    }));
  });
  const operations = (request, parameters) => safe(async () => {
    const room = await loadRoom2(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "\u4FDD\u5B58\u5148\u304C\u3042\u308A\u307E\u305B\u3093");
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value } = await readMutationBody(request, MAX_OPERATION_BODY_BYTES);
    assertKeys(value, ["requestId", "writerEpoch", "manifestId", "evaluatorVersion", "operations"]);
    if (!Array.isArray(value.operations)) throw new ApiError(400, "invalid_request", "\u89E3\u7B54\u8A18\u9332\u304C\u4E0D\u6B63\u3067\u3059");
    const response = await applyV2Operations(dependencies.database, {
      roomId: room.id,
      participantId: participant.participantId,
      requestId: requestId(value.requestId),
      writerEpoch: integerValue(value.writerEpoch, "writerEpoch"),
      manifestId: stringValue(value.manifestId, "manifestId", 128),
      evaluatorVersion: stringValue(value.evaluatorVersion, "evaluatorVersion", 128),
      operations: value.operations,
      nowMs: dependencies.now()
    });
    await maybeFinalizeV2Room(dependencies.database, { roomId: room.id, nowMs: dependencies.now() });
    return jsonResponse(response);
  });
  const writer = (request, parameters) => safe(async () => {
    const room = await loadRoom2(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "\u66F8\u304D\u624B\u60C5\u5831\u304C\u3042\u308A\u307E\u305B\u3093");
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value } = await readMutationBody(request);
    assertKeys(value, ["expectedEpoch"]);
    return jsonResponse(await takeOverV2Writer(
      dependencies.database,
      room.id,
      participant.participantId,
      integerValue(value.expectedEpoch, "expectedEpoch", 1)
    ));
  });
  const cancel = (request, parameters) => safe(async () => {
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedRevision"]);
    const room = await loadRoom2(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await authorizeRoomOwner(dependencies, request, room);
    return jsonResponse(await cancelRoom(dependencies.database, {
      roomId: room.id,
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"),
      nowMs
    }));
  });
  const interrupt = (request, parameters) => safe(async () => {
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedRevision"]);
    let room = await loadRoom2(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (request.headers.has("authorization")) throw new ApiError(403, "room_owner_forbidden", "\u4F5C\u6210\u6559\u54E1\u3060\u3051\u304C\u4E2D\u65AD\u3067\u304D\u307E\u3059");
    await authorizeTeacherOwner(dependencies, request, room);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await tryFinalize(dependencies.database, room, nowMs);
    room = await loadRoom2(dependencies.database, room.id);
    if (room.game_version === "2") return jsonResponse(await collectV2Room(dependencies.database, { roomId: room.id, nowMs, interrupted: true }));
    return jsonResponse(await interruptRoom(dependencies.database, {
      roomId: room.id,
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"),
      nowMs
    }));
  });
  const removeParticipant2 = (request, parameters) => safe(async () => {
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, [
      "requestId",
      "participantId",
      "expectedRoomRevision",
      "expectedParticipantRevision"
    ]);
    const room = await loadRoom2(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    const owner = await authorizeRoomOwner(dependencies, request, room);
    const result = await removeParticipant(dependencies.database, {
      roomId: room.id,
      actorId: `${owner.kind}:${owner.id}`,
      targetParticipantId: stringValue(value.participantId, "participantId"),
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      expectedRoomRevision: integerValue(value.expectedRoomRevision, "expectedRoomRevision"),
      expectedParticipantRevision: integerValue(value.expectedParticipantRevision, "expectedParticipantRevision"),
      nowMs
    });
    return jsonResponse({
      roomRevision: result.roomRevision,
      participant: {
        id: result.participantId,
        status: result.participantStatus,
        revision: result.participantRevision
      }
    });
  });
  const actions = (request, parameters) => safe(async () => {
    assertSameOriginMutation(request);
    const room = await loadRoom2(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "questionId", "expectedParticipantRevision", "clientElapsedMs", "waitCredit", "action"]);
    if (!isRecord(value.action)) throw new ApiError(400, "invalid_action", "\u64CD\u4F5C\u5185\u5BB9\u304C\u4E0D\u6B63\u3067\u3059");
    let action;
    if (value.action.type === "pass") {
      if (value.action.fieldId === void 0) {
        const replay = await loadCommandReceipt(dependencies.database, room.id, participant.participantId, requestId(value.requestId), bodyHash2);
        if (replay) return jsonResponse(replay);
        throw new ApiError(400, "invalid_action", "\u30A2\u30D7\u30EA\u3092\u66F4\u65B0\u3057\u3066\u3001\u30D1\u30B9\u3059\u308B\u6B04\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
      }
      assertKeys(value.action, ["type", "fieldId"]);
      if (value.action.fieldId !== "formula" && value.action.fieldId !== "name") throw new ApiError(400, "invalid_action", "\u30D1\u30B9\u3059\u308B\u6B04\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
      action = { type: "pass", fieldId: value.action.fieldId };
    } else if (value.action.type === "answer") {
      assertKeys(value.action, ["type", "fieldId", "value"]);
      if (value.action.fieldId !== "formula" && value.action.fieldId !== "name") {
        throw new ApiError(400, "invalid_action", "\u56DE\u7B54\u6B04\u304C\u4E0D\u6B63\u3067\u3059");
      }
      action = {
        type: "answer",
        fieldId: value.action.fieldId,
        value: value.action.fieldId === "formula" && isRecord(value.action.value) ? formulaEntryValue(value.action.value) : stringValue(value.action.value, "\u56DE\u7B54", MAX_ANSWER_LENGTH)
      };
    } else {
      throw new ApiError(400, "invalid_action", "\u64CD\u4F5C\u5185\u5BB9\u304C\u4E0D\u6B63\u3067\u3059");
    }
    const clientElapsedMs = value.clientElapsedMs === null ? null : integerValue(value.clientElapsedMs, "clientElapsedMs");
    let waitCredit;
    if (isRecord(value.waitCredit)) {
      const source = value.waitCredit.sourceRequestId;
      const waitMs = value.waitCredit.waitMs;
      if (typeof source === "string" && source.length > 0 && source.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(source) && Number.isSafeInteger(waitMs) && waitMs >= 0) {
        waitCredit = { sourceRequestId: source, waitMs };
      }
    }
    const result = await applyPlayerAction(dependencies.database, {
      roomId: room.id,
      participantId: participant.participantId,
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      questionId: stringValue(value.questionId, "questionId"),
      expectedParticipantRevision: integerValue(value.expectedParticipantRevision, "expectedParticipantRevision"),
      clientElapsedMs,
      waitCredit,
      serverNowMs: nowMs,
      action
    });
    if (result.finished) {
      const latest = await loadRoom2(dependencies.database, room.id);
      try {
        await finalizeRoom(dependencies.database, {
          roomId: room.id,
          requestId: `all-finished-${result.participantRevision}`,
          bodyHash: `all-finished-${result.participantRevision}`,
          nowMs
        });
      } catch (error) {
        if (!(error instanceof PersistenceConflictError && (error.code === "invalid_state" || error.code === "stale_room_revision"))) throw error;
      }
      void latest;
    }
    return jsonResponse(result);
  });
  const state = (request, parameters) => safe(async () => {
    let room = dependencies.snapshotRoom ?? await loadRoom2(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    if (room.expires_at_ms <= nowMs) {
      if (!dependencies.snapshotRoom) await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
      throw new ApiError(410, "expired", "\u3053\u306E\u30EB\u30FC\u30E0\u306E\u95B2\u89A7\u671F\u9650\u306F\u7D42\u4E86\u3057\u307E\u3057\u305F");
    }
    if (!dependencies.snapshotRoom) await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
    requireUnexpired(room, nowMs);
    if (!dependencies.snapshotRoom) {
      await tryFinalize(dependencies.database, room, nowMs);
      room = await loadRoom2(dependencies.database, room.id);
    }
    const v2Phase = room.game_version === "2" ? await loadV2RoomPhase(dependencies.database, room.id, nowMs) : null;
    const v2Preparation = v2Phase?.state === "PREPARING" ? (await dependencies.database.prepare(`SELECT p.nickname, v.ready_generation FROM participants p
          LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
          WHERE p.room_id = ? AND p.status = 'ACTIVE' ORDER BY p.joined_order`).bind(room.id).all()).results : null;
    const v2 = v2Phase ? {
      ...v2Phase,
      readyCount: v2Preparation?.filter((p) => p.ready_generation === v2Phase.preparationGeneration).length ?? null,
      participantCount: v2Preparation?.length ?? null,
      notReadyNicknames: v2Preparation?.filter((p) => p.ready_generation !== v2Phase.preparationGeneration).map((p) => p.nickname) ?? []
    } : void 0;
    if (request.headers.has("authorization")) {
      const identity = dependencies.snapshotParticipant ?? await identifyParticipant(dependencies.database, request, room.id);
      if (identity.status === "REMOVED") {
        const roomState = stateOf(room, nowMs);
        return jsonResponse({ error: {
          code: "participant_removed",
          message: "\u30DB\u30B9\u30C8\u304C\u30ED\u30D3\u30FC\u304B\u3089\u3042\u306A\u305F\u306E\u30A8\u30F3\u30C8\u30EA\u30FC\u3092\u524A\u9664\u3057\u307E\u3057\u305F\u3002",
          nickname: identity.nickname,
          roomState,
          canRejoin: roomState === "WAITING"
        } }, 403);
      }
      const own = await participantState(dependencies.database, room, identity.participantId, nowMs);
      const participants = room.kind === "mate" && room.mate_host_id === identity.participantId ? await teacherProgress(dependencies.database, room.id) : void 0;
      return jsonResponse({
        serverNow: nowMs,
        room: roomView(room, nowMs),
        ...v2 ? { v2 } : {},
        ...own,
        ...participants ? { participants } : {}
      });
    }
    await authorizeTeacherOwner(dependencies, request, room);
    return jsonResponse({ serverNow: nowMs, room: roomView(room, nowMs), ...v2 ? { v2 } : {}, participants: await teacherProgress(dependencies.database, room.id) });
  });
  const results = (request, parameters) => resultSafe(async (requestId2, setProtocolVersion) => {
    let room = await loadRoom2(dependencies.database, parameters.id);
    setProtocolVersion(room.game_version === "2" ? 2 : 1);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await tryFinalize(dependencies.database, room, nowMs);
    room = await loadRoom2(dependencies.database, room.id);
    if (stateOf(room, nowMs) !== "FINISHED") throw new ApiError(409, "results_not_ready", "\u7D50\u679C\u306F\u307E\u3060\u78BA\u5B9A\u3057\u3066\u3044\u307E\u305B\u3093");
    const { results: rankingRows } = await dependencies.database.prepare(`
      SELECT p.nickname, f.correct_count, f.elapsed_cs, f.rank, f.finish_reason,
        v.finished_elapsed_ms, v.boundary_ack_at_ms, v.finish_reason AS v2_finish_reason
      FROM final_results f JOIN participants p ON p.room_id = f.room_id AND p.id = f.participant_id
      LEFT JOIN v2_participant_progress v ON v.room_id = f.room_id AND v.participant_id = f.participant_id
      WHERE f.room_id = ? ORDER BY f.rank, p.joined_order
    `).bind(room.id).all();
    const ranking = rankingRows.map((row) => ({
      nickname: row.nickname,
      correctCount: row.correct_count,
      elapsedCs: row.elapsed_cs,
      rank: row.rank,
      finishReason: room.game_version === "2" && row.v2_finish_reason === "submitted" ? "submitted" : row.finish_reason,
      ...room.game_version === "2" ? { finalSyncUnconfirmed: row.finished_elapsed_ms == null && row.boundary_ack_at_ms == null } : {}
    }));
    if (request.headers.has("authorization")) {
      const identity = await requireParticipant(dependencies.database, request, room.id);
      const own = await loadAuthorizedResult(dependencies.database, {
        roomId: room.id,
        participantId: identity.participantId,
        tokenHash: identity.tokenHash,
        nowMs
      });
      const ownProgress = room.game_version === "2" ? await dependencies.database.prepare(`SELECT finished_elapsed_ms, boundary_ack_at_ms, finish_reason
        FROM v2_participant_progress WHERE room_id = ? AND participant_id = ?`).bind(room.id, identity.participantId).first() : null;
      return jsonResponse({
        room: roomView(room, nowMs),
        ranking: room.kind === "class" ? ranking.filter((row) => row.rank <= 3) : ranking,
        own: { ...own, ...ownProgress ? {
          finalSyncUnconfirmed: ownProgress.finished_elapsed_ms == null && ownProgress.boundary_ack_at_ms == null,
          finishReason: ownProgress.finish_reason === "submitted" ? "submitted" : own.finishReason
        } : {} },
        questions: await participantQuestionResults(dependencies.database, room.id, identity.participantId, room.game_version === "2" ? 2 : 1, requestId2)
      });
    }
    await authorizeTeacherOwner(dependencies, request, room);
    return jsonResponse({
      room: roomView(room, nowMs),
      ranking,
      aggregate: await teacherResultAggregate(dependencies.database, room)
    });
  }, "results");
  const resultSummary = (request, parameters) => resultSafe(async (_requestId, setProtocolVersion) => {
    let room = await loadRoom2(dependencies.database, parameters.id);
    setProtocolVersion(room.game_version === "2" ? 2 : 1);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await tryFinalize(dependencies.database, room, nowMs);
    room = await loadRoom2(dependencies.database, room.id);
    if (stateOf(room, nowMs) !== "FINISHED") throw new ApiError(409, "results_not_ready", "\u7D50\u679C\u306F\u307E\u3060\u78BA\u5B9A\u3057\u3066\u3044\u307E\u305B\u3093");
    if (request.headers.has("authorization")) {
      const identity = await requireParticipant(dependencies.database, request, room.id);
      const own = await loadAuthorizedResult(dependencies.database, {
        roomId: room.id,
        participantId: identity.participantId,
        tokenHash: identity.tokenHash,
        nowMs
      });
      const progress = room.game_version === "2" ? await dependencies.database.prepare(`SELECT finished_elapsed_ms, boundary_ack_at_ms, finish_reason
        FROM v2_participant_progress WHERE room_id = ? AND participant_id = ?`).bind(room.id, identity.participantId).first() : null;
      return jsonResponse({ room: roomView(room, nowMs), own: {
        ...own,
        ...progress ? {
          finalSyncUnconfirmed: progress.finished_elapsed_ms == null && progress.boundary_ack_at_ms == null,
          finishReason: progress.finish_reason === "submitted" ? "submitted" : own.finishReason
        } : {}
      } });
    }
    await authorizeTeacherOwner(dependencies, request, room);
    return jsonResponse({ room: roomView(room, nowMs) });
  }, "result-summary");
  const teacherQuestionProfile = (request) => safe(async () => {
    const teacher = await requireApplicationTeacher(dependencies, request);
    if (!dependencies.serverConfig.masterTeacherEmail || teacher.email !== dependencies.serverConfig.masterTeacherEmail) {
      throw new ApiError(403, "master_required", "\u7BA1\u7406\u8005\u6559\u54E1\u306E\u307F\u64CD\u4F5C\u3067\u304D\u307E\u3059");
    }
    const catalog = questionProfileCatalog();
    if (request.method === "GET") return jsonResponse({ ...await readQuestionProfile(dependencies.database), catalog });
    if (request.method !== "PATCH") throw new ApiError(405, "method_not_allowed", "\u3053\u306E\u64CD\u4F5C\u306F\u5229\u7528\u3067\u304D\u307E\u305B\u3093");
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "profile", "expectedRevision"]);
    let profile;
    try {
      profile = validateQuestionProfileShape(value.profile);
      validateQuestionProfile(profile);
    } catch (error) {
      throw new ApiError(400, "invalid_question_profile", error instanceof Error ? error.message : "\u51FA\u984C\u8A2D\u5B9A\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
    }
    const saved = await updateQuestionProfile(dependencies.database, {
      teacherId: teacher.id,
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      expectedRevision: integerValue(value.expectedRevision, "expectedRevision"),
      profile,
      nowMs: dependencies.now()
    });
    return jsonResponse({ ...saved, catalog });
  });
  const teacherSiteSettings = (request) => safe(async () => {
    const teacher = await requireApplicationTeacher(dependencies, request);
    const nowMs = dependencies.now();
    await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
    if (request.method === "GET") return jsonResponse(await readMateEnabled(dependencies.database));
    if (!dependencies.serverConfig.masterTeacherEmail || teacher.email !== dependencies.serverConfig.masterTeacherEmail) {
      throw new ApiError(403, "master_required", "\u30DE\u30B9\u30BF\u30FC\u6559\u54E1\u306E\u307F\u64CD\u4F5C\u3067\u304D\u307E\u3059");
    }
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["requestId", "enabled", "expectedRevision"]);
    if (typeof value.enabled !== "boolean") throw new ApiError(400, "invalid_request", "enabled\u304C\u4E0D\u6B63\u3067\u3059");
    return jsonResponse(await updateSiteSettingsCommand(dependencies.database, {
      teacherId: teacher.id,
      requestId: requestId(value.requestId),
      bodyHash: bodyHash2,
      expectedRevision: integerValue(value.expectedRevision, "expectedRevision"),
      enabled: value.enabled,
      nowMs
    }));
  });
  const teacherSession = (request) => safe(async () => {
    const teacher = await requireApplicationTeacher(dependencies, request);
    return jsonResponse({ email: teacher.email, role: teacher.email === dependencies.serverConfig.masterTeacherEmail ? "master" : "teacher" });
  });
  const teacherAllowlist = (request) => safe(async () => {
    const teacher = await requireVerifiedTeacher(request, dependencies.teacherIdentity);
    const master = dependencies.serverConfig.masterTeacherEmail;
    if (!master || teacher.email !== master) throw new ApiError(403, "master_required", "\u30DE\u30B9\u30BF\u30FC\u6559\u54E1\u306E\u307F\u64CD\u4F5C\u3067\u304D\u307E\u3059");
    let current = await readTeacherAllowlist(dependencies.database);
    const view = (row) => ({ masterEmail: master, emails: JSON.parse(row.emails_json), revision: row.revision });
    if (request.method === "GET") return jsonResponse(view(current));
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    assertKeys(value, ["email", "enabled", "expectedRevision", "requestId"]);
    const key2 = requestId(value.requestId);
    const expected = integerValue(value.expectedRevision, "expectedRevision");
    if (typeof value.email !== "string" || typeof value.enabled !== "boolean") throw new ApiError(400, "invalid_request", "\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9\u3068\u64CD\u4F5C\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
    const email = normalizeTeacherEmail(value.email);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "invalid_email", "\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
    if (email === master) throw new ApiError(400, "master_fixed", "\u30DE\u30B9\u30BF\u30FC\u6559\u54E1\u306F\u3053\u306E\u753B\u9762\u3067\u306F\u5909\u66F4\u3067\u304D\u307E\u305B\u3093");
    if (current.last_request_id === key2) {
      if (current.last_body_hash !== bodyHash2) throw new ApiError(409, "request_id_reused", "\u64CD\u4F5CID\u304C\u518D\u5229\u7528\u3055\u308C\u3066\u3044\u307E\u3059");
      return jsonResponse(view(current));
    }
    if (current.revision !== expected) throw new ApiError(409, "stale_allowlist", "\u4E00\u89A7\u304C\u66F4\u65B0\u3055\u308C\u307E\u3057\u305F\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u3066\u304B\u3089\u64CD\u4F5C\u3057\u3066\u304F\u3060\u3055\u3044");
    const emails = new Set(JSON.parse(current.emails_json));
    if (value.enabled) emails.add(email);
    else emails.delete(email);
    if (emails.size > 100) throw new ApiError(400, "allowlist_limit", "\u8A31\u53EF\u6559\u54E1\u306F100\u4EF6\u307E\u3067\u767B\u9332\u3067\u304D\u307E\u3059");
    const result = await dependencies.database.batch([
      dependencies.database.prepare("INSERT OR IGNORE INTO teacher_allowlist (id) VALUES (1)"),
      dependencies.database.prepare("UPDATE teacher_allowlist SET emails_json = ?, revision = revision + 1, last_request_id = ?, last_body_hash = ? WHERE id = 1 AND revision = ?").bind(JSON.stringify([...emails].sort()), key2, bodyHash2, expected)
    ]);
    current = await readTeacherAllowlist(dependencies.database);
    if (!result[1]?.meta.changes && !(current.last_request_id === key2 && current.last_body_hash === bodyHash2)) throw new ApiError(409, "stale_allowlist", "\u4E00\u89A7\u304C\u66F4\u65B0\u3055\u308C\u307E\u3057\u305F\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u3066\u304B\u3089\u64CD\u4F5C\u3057\u3066\u304F\u3060\u3055\u3044");
    return jsonResponse(view(current));
  });
  return {
    teacherQuestionProfile,
    teacherSession,
    teacherAllowlist,
    publicConfig,
    joinInfo,
    createClassRoom,
    createMateRoom,
    joinRoom: join,
    nickname,
    updateRoomSettings,
    startRoom: start,
    startStatus,
    manifest,
    ready,
    cancelPreparation,
    operations,
    writer,
    cancelRoom: cancel,
    interruptRoom: interrupt,
    removeParticipant: removeParticipant2,
    actions,
    state,
    results,
    resultSummary,
    teacherSiteSettings
  };
}

// src/platform/postgres-room-commands.ts
async function nativeRoomCommand(db, request, publicId, uid, kind) {
  let unsupported = false;
  const response = await safe(async () => {
    const { value, bodyHash: bodyHash2 } = await readMutationBody(request);
    const tokenHash = await hashParticipantToken(readParticipantBearerToken(request));
    let row;
    if (kind === "join") {
      assertKeys(value, ["requestId", "nickname"]);
      const nickname = normalizeNickname(value.nickname);
      row = await db.prepare("SELECT competition_private.join_room_v1(?,?,?,?,?,?,?,?) AS result").bind(publicId, uid, tokenHash, crypto.randomUUID(), requestId(value.requestId), bodyHash2, nickname.nickname, nickname.nicknameKey).first();
    } else {
      assertKeys(value, ["manifestId", "preparationGeneration", "evaluatorVersion"]);
      row = await db.prepare("SELECT competition_private.mark_ready_v1(?,?,?,?,?,?,?) AS result").bind(publicId, uid, tokenHash, request.headers.get("x-participant-id"), stringValue(value.manifestId, "manifestId", 128), stringValue(value.evaluatorVersion, "evaluatorVersion", 128), integerValue(value.preparationGeneration, "preparationGeneration", 1)).first();
    }
    const result = row?.result;
    if (result?.unsupported) {
      unsupported = true;
      return jsonResponse({});
    }
    if (!result || !result.status) throw new Error("Invalid native command envelope");
    if (result.code) {
      if (result.message) return jsonResponse({ error: { code: result.code, message: result.message } }, result.status);
      throw new PersistenceConflictError(result.code, "Native command rejected", result.status);
    }
    return jsonResponse(result.body, result.status);
  }, true);
  return unsupported ? null : response;
}

// src/platform/supabase-identity.ts
function googleIdentity(user) {
  if (user.is_anonymous || !user.email || !user.email_confirmed_at || !user.identities?.some((x) => x.provider === "google")) return null;
  return { id: user.id, email: normalizeTeacherEmail(user.email) };
}
async function verifySupabaseUser(request, url2, key2) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  try {
    const response = await fetch(`${url2}/auth/v1/user`, { headers: { authorization, apikey: key2 }, signal: AbortSignal.timeout(5e3) });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error("Authentication service unavailable");
    const user = await response.json();
    if (typeof user.id !== "string" || !user.id) throw new Error("Authentication service unavailable");
    return user;
  } catch {
    throw new AuthenticationUnavailableError();
  }
}
var AuthenticationUnavailableError = class extends Error {
  constructor() {
    super("Authentication service unavailable");
    this.name = "AuthenticationUnavailableError";
  }
};

// src/web/realtime-policy.ts
var reservedEventCost = (people) => 1 + people * 2;

// src/platform/realtime-outbox.ts
async function readRoom(db, publicId) {
  return db.prepare(`SELECT r.id,r.public_id,r.kind,r.state,r.revision,r.owner_teacher_id,r.mate_host_id,r.settings_json,r.start_at_ms,r.deadline_at_ms,r.expires_at_ms,
    m.state AS manifest_state,m.preparation_generation,m.cutoff_at_ms,m.collection_until_ms,t.epoch
    FROM rooms r LEFT JOIN v2_room_manifests m ON m.room_id=r.id
    LEFT JOIN app_room_topics t ON t.room_id=r.id WHERE r.public_id=?`).bind(publicId).first();
}
async function readParticipants(db, id) {
  return (await db.prepare(`SELECT p.id,p.nickname,p.status,p.joined_order,p.current_ordinal,p.correct_count,p.resolved_question_count,p.revision,p.elapsed_cs,p.timing_source,
    COALESCE(v.answered_count,0) AS answered_count,v.finished_elapsed_ms,v.ready_generation
    FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id=p.room_id AND v.participant_id=p.id
    WHERE p.room_id=? ORDER BY p.joined_order,p.id`).bind(id).all()).results;
}
async function fingerprint(db, r, includeProgress) {
  const participants = includeProgress ? await readParticipants(db, r.id) : [];
  return {
    control: JSON.stringify([r.state, r.manifest_state, r.preparation_generation, r.settings_json, r.start_at_ms, r.deadline_at_ms, r.cutoff_at_ms, r.collection_until_ms, r.epoch]),
    progress: JSON.stringify(participants.map((p) => [p.id, p.nickname, p.status, p.ready_generation, p.correct_count, p.answered_count, p.revision, p.finished_elapsed_ms]))
  };
}
async function roomFingerprint(db, publicId, includeProgress = true) {
  const r = await readRoom(db, publicId);
  return r ? fingerprint(db, r, includeProgress) : null;
}
async function queueRoomEvents(db, publicId, before, now, includeProgress = true, forceHost = false) {
  const room = await readRoom(db, publicId);
  if (!room) return;
  const next = await fingerprint(db, room, includeProgress);
  const kinds = [];
  if (!before || before.control !== next.control) kinds.push("control");
  if (forceHost || !before || before.progress !== next.progress) kinds.push("host");
  if (!kinds.length) return;
  const topic = await db.prepare("UPDATE app_room_topics SET progress_revision=progress_revision+1,control_revision=control_revision+1 WHERE room_id=? RETURNING epoch,progress_revision,control_revision").bind(room.id).first();
  if (!topic) return;
  for (const kind of kinds) {
    const event = { eventId: crypto.randomUUID(), roomId: publicId, epoch: topic.epoch, revision: kind === "host" ? topic.progress_revision : topic.control_revision, roomRevision: room.revision };
    await db.prepare(`INSERT INTO app_outbox(room_id,kind,revision,payload_json,event_id) VALUES(?,?,?,?,?)
      ON CONFLICT(room_id,kind) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json,event_id=excluded.event_id,lease_id=NULL,lease_until_ms=0,queued_at_ms=excluded.queued_at_ms`).bind(room.id, kind, event.revision, JSON.stringify(event), event.eventId).run();
  }
}
async function flushRoomEvents(transact2, publicId, send, now = Date.now()) {
  let nextEligibleAt = null;
  const defer = (at) => {
    nextEligibleAt = Math.min(nextEligibleAt ?? Infinity, at);
  };
  const claimStarted = Date.now();
  const claimed = await transact2(`broadcast:${publicId}`, async (db) => {
    const room = await readRoom(db, publicId);
    if (!room || room.expires_at_ms <= now) return [];
    const topic = await db.prepare("SELECT epoch,sent_control_ms,sent_progress_ms FROM app_room_topics WHERE room_id=?").bind(room.id).first();
    const pending = (await db.prepare(`SELECT * FROM app_outbox WHERE room_id=? ORDER BY CASE kind WHEN 'control' THEN 0 ELSE 1 END`).bind(room.id).all()).results;
    const recipients = await db.prepare(`SELECT count(*) AS count FROM participants WHERE room_id=? AND status<>'REMOVED'`).bind(room.id).first();
    const hosts = 1;
    const result = [];
    for (const event of pending) {
      if (event.lease_until_ms >= now) {
        defer(Number(event.lease_until_ms) + 1);
        continue;
      }
      const eligible = Number(event.kind === "host" ? topic.sent_progress_ms : topic.sent_control_ms) + 1e3;
      if (now < eligible) {
        defer(eligible);
        continue;
      }
      const cost = reservedEventCost(event.kind === "host" ? hosts : Number(recipients?.count ?? 0) + (room.kind === "mate" ? 0 : 1));
      const budget = await db.prepare("SELECT window_ms,used FROM app_broadcast_budget WHERE id=1 FOR UPDATE").first();
      const window = Math.floor(now / 1e3) * 1e3;
      const used = budget.window_ms === window ? budget.used : 0;
      if (used + cost > 90) {
        defer(window + 1e3);
        continue;
      }
      const lease = crypto.randomUUID();
      const leased = await db.prepare("UPDATE app_outbox SET lease_id=?,lease_until_ms=? WHERE room_id=? AND kind=? AND event_id=? AND lease_until_ms<? RETURNING *").bind(lease, now + 5e3, room.id, event.kind, event.event_id, now).first();
      if (!leased) {
        defer(now + 1e3);
        continue;
      }
      await db.prepare("UPDATE app_broadcast_budget SET window_ms=?,used=? WHERE id=1").bind(window, used + cost).run();
      result.push({ ...leased, lease, topic: `room:${publicId}:${event.kind === "host" ? "host" : "control"}:${topic.epoch}`, epoch: topic.epoch });
    }
    return result;
  });
  const claimMs = Date.now() - claimStarted;
  for (const event of claimed) {
    let sendMs = 0;
    let ackMs = 0;
    try {
      const stored = JSON.parse(event.payload_json);
      const payload = { eventId: event.event_id, roomId: publicId, epoch: event.epoch, revision: Number(event.revision), roomRevision: Number(stored.roomRevision) };
      const current = await transact2(`broadcast:${publicId}`, (db) => db.prepare("SELECT epoch FROM app_room_topics WHERE room_id=?").bind(event.room_id).first());
      if (stored.epoch !== event.epoch || current?.epoch !== event.epoch) {
        await transact2(`broadcast:${publicId}`, (db) => db.prepare("DELETE FROM app_outbox WHERE room_id=? AND kind=? AND event_id=? AND lease_id=?").bind(event.room_id, event.kind, event.event_id, event.lease).run());
        continue;
      }
      const sendingAt = Date.now();
      await send(event.topic, event.kind === "host" ? "host.progress" : "room.changed", payload);
      sendMs = Date.now() - sendingAt;
      const ackAt = Date.now();
      await transact2(`broadcast:${publicId}`, async (db) => {
        const removed = await db.prepare("DELETE FROM app_outbox WHERE room_id=? AND kind=? AND event_id=? AND lease_id=? RETURNING event_id").bind(event.room_id, event.kind, event.event_id, event.lease).first();
        if (removed) await db.prepare(`UPDATE app_room_topics SET ${event.kind === "host" ? "sent_progress_ms" : "sent_control_ms"}=? WHERE room_id=? AND epoch=?`).bind(now, event.room_id, event.epoch).run();
        else defer(now + 1e3);
      });
      ackMs = Date.now() - ackAt;
      console.info(JSON.stringify({ event: "broadcast_delivery", claimMs, sendMs, ackMs, outcome: "sent" }));
    } catch {
      defer(now + 1e3);
      console.info(JSON.stringify({ event: "broadcast_delivery", claimMs, sendMs, ackMs, outcome: "failed" }));
      await transact2(`broadcast:${publicId}`, async (db) => {
        await db.prepare("UPDATE app_outbox SET lease_until_ms=0 WHERE room_id=? AND kind=? AND event_id=? AND lease_id=?").bind(event.room_id, event.kind, event.event_id, event.lease).run();
      });
    }
  }
  return { nextEligibleAt };
}
async function retryRoomDrain(drain, options = {}) {
  const clock = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < (options.attempts ?? 8); attempt++) {
    const result = await drain();
    if (result.nextEligibleAt == null) return;
    await sleep(Math.min(5e3, Math.max(100, result.nextEligibleAt - clock() + 25)));
  }
}
function coalescedRoomFlusher(drain) {
  const rooms = /* @__PURE__ */ new Map();
  return (id) => {
    const existing = rooms.get(id);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const entry = { dirty: false, promise: Promise.resolve() };
    rooms.set(id, entry);
    entry.promise = (async () => {
      try {
        do {
          entry.dirty = false;
          await drain(id);
        } while (entry.dirty);
      } finally {
        rooms.delete(id);
      }
    })();
    return entry.promise;
  };
}

// src/platform/room-snapshot.ts
async function readSnapshotRoom(db, publicId, uid, credential) {
  const token = credential ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(credential)?.[1] : void 0;
  const hash = token ? await hashParticipantToken(token) : "";
  return db.prepare(`SELECT r.*, v.state AS v2_phase, v.collection_until_ms, t.epoch AS topic_epoch,
      p.id AS participant_id,p.status AS participant_status,p.nickname AS participant_nickname,p.token_hash,
      b.uid AS membership_uid,
      EXISTS(SELECT 1 FROM participants a WHERE a.room_id=r.id AND a.status<>'REMOVED') AND
      NOT EXISTS(SELECT 1 FROM participants a LEFT JOIN v2_participant_progress g ON g.room_id=a.room_id AND g.participant_id=a.id
        WHERE a.room_id=r.id AND a.status<>'REMOVED' AND g.finished_elapsed_ms IS NULL) AS all_finished,
      NOT EXISTS(SELECT 1 FROM participants a LEFT JOIN v2_participant_progress g ON g.room_id=a.room_id AND g.participant_id=a.id
        WHERE a.room_id=r.id AND a.status<>'REMOVED' AND g.finished_elapsed_ms IS NULL AND g.boundary_ack_at_ms IS NULL) AS boundary_ready
    FROM rooms r LEFT JOIN v2_room_manifests v ON v.room_id=r.id
    LEFT JOIN app_room_topics t ON t.room_id=r.id
    LEFT JOIN participants p ON p.room_id=r.id AND p.token_hash=?
    LEFT JOIN app_memberships b ON b.room_id=p.room_id AND b.participant_id=p.id
    WHERE r.public_id=?`).bind(hash, publicId).first();
}
function snapshotNeedsTransition(room, now) {
  if (room.expires_at_ms <= now || ["CANCELLED", "EXPIRED", "FINISHED"].includes(room.state)) return false;
  if (room.game_version !== "2") return room.deadline_at_ms != null && now >= room.deadline_at_ms;
  if (room.v2_phase === "COUNTDOWN") return room.all_finished || room.deadline_at_ms != null && now >= room.deadline_at_ms;
  if (room.v2_phase === "COLLECTING") return room.boundary_ready || now >= (room.collection_until_ms ?? (room.deadline_at_ms ?? Infinity) + 1e4);
  return false;
}

// src/platform/supabase-gateway.ts
var topRoutes = {
  "/api/public-config": { method: ["GET"], name: "publicConfig" },
  "/api/join-info": { method: ["GET"], name: "joinInfo" },
  "/api/class-rooms": { method: ["POST"], name: "createClassRoom" },
  "/api/mate-rooms": { method: ["POST"], name: "createMateRoom" },
  "/api/teacher/session": { method: ["GET"], name: "teacherSession" },
  "/api/teacher/allowlist": { method: ["GET", "POST"], name: "teacherAllowlist" },
  "/api/teacher/question-profile": { method: ["GET", "PATCH"], name: "teacherQuestionProfile" },
  "/api/teacher/site-settings": { method: ["GET", "PATCH"], name: "teacherSiteSettings" }
};
var roomRoutes = {
  state: { method: ["GET"], name: "state" },
  join: { method: ["POST"], name: "joinRoom" },
  nickname: { method: ["PATCH"], name: "nickname" },
  settings: { method: ["PATCH"], name: "updateRoomSettings" },
  "start-status": { method: ["GET"], name: "startStatus" },
  start: { method: ["POST"], name: "startRoom" },
  manifest: { method: ["GET"], name: "manifest" },
  ready: { method: ["POST"], name: "ready" },
  "cancel-preparation": { method: ["POST"], name: "cancelPreparation" },
  operations: { method: ["POST"], name: "operations" },
  writer: { method: ["POST"], name: "writer" },
  cancel: { method: ["POST"], name: "cancelRoom" },
  interrupt: { method: ["POST"], name: "interruptRoom" },
  remove: { method: ["POST"], name: "removeParticipant" },
  actions: { method: ["POST"], name: "actions" },
  results: { method: ["GET"], name: "results" },
  "result-summary": { method: ["GET"], name: "resultSummary" }
};
function failure(status, code, message) {
  return jsonResponse({ error: { code, message } }, status);
}
function withCors(response, origin, preflight = false) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  const vary = headers.get("vary");
  if (!vary?.split(",").some((value) => value.trim().toLowerCase() === "origin")) headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  if (preflight) headers.set("access-control-max-age", "600");
  headers.set("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,apikey,content-type,x-region,x-participant-authorization,x-competition-csrf,x-creation-key");
  headers.set("access-control-expose-headers", "retry-after,x-request-id");
  return new Response(response.body, { status: response.status, headers });
}
async function teacherProvider(db, user, masterEmail, readOnly = false) {
  const identity = googleIdentity(user);
  if (!identity) return { getVerifiedIdentity: async () => null };
  const master = masterEmail.trim().toLowerCase();
  if (!master) return { getVerifiedIdentity: async () => null };
  if (!readOnly) await db.prepare("INSERT OR IGNORE INTO app_auth_config(id,master_email) VALUES(1,?)").bind(master).run();
  const settings = await db.prepare("SELECT master_email FROM app_auth_config WHERE id=1").first();
  if (settings?.master_email !== master) throw new Error("Master identity configuration differs");
  const list = await db.prepare("SELECT emails_json FROM teacher_allowlist WHERE id=1").first();
  const permitted = identity.email === master || JSON.parse(list?.emails_json ?? "[]").includes(identity.email);
  const byUid = await db.prepare("SELECT email,active FROM app_teacher_bindings WHERE uid=?").bind(user.id).first();
  const byEmail = await db.prepare("SELECT uid FROM app_teacher_bindings WHERE email=?").bind(identity.email).first();
  if (!permitted || byUid && byUid.email !== identity.email || byEmail && byEmail.uid !== user.id) return { getVerifiedIdentity: async () => null };
  if (readOnly) return { getVerifiedIdentity: async () => byUid?.active ? identity : null };
  if (!byUid) await db.prepare("INSERT INTO app_teacher_bindings(uid,email) VALUES(?,?)").bind(user.id, identity.email).run();
  else if (!byUid.active) await db.prepare("UPDATE app_teacher_bindings SET active=true WHERE uid=?").bind(user.id).run();
  return { getVerifiedIdentity: async () => identity };
}
async function associateParticipant(db, user, request, publicId) {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match) return;
  const hash = await hashParticipantToken(match[1]);
  const participant = await db.prepare(`SELECT p.room_id,p.id,m.uid FROM participants p JOIN rooms r ON r.id=p.room_id LEFT JOIN app_memberships m ON m.room_id=p.room_id AND m.participant_id=p.id
    WHERE r.public_id=? AND p.token_hash=? AND p.status<>'REMOVED'`).bind(publicId, hash).first();
  if (!participant) return;
  if (participant.uid === user.id) return;
  const old = participant.uid;
  await db.prepare(`INSERT INTO app_memberships(room_id,participant_id,uid) VALUES(?,?,?)
    ON CONFLICT(room_id,participant_id) DO UPDATE SET uid=excluded.uid WHERE app_memberships.uid<>excluded.uid`).bind(participant.room_id, participant.id, user.id).run();
  if (old && old !== user.id) await db.prepare("INSERT INTO app_audit(actor_uid,event,room_id) VALUES(?,?,?)").bind(user.id, "participant_rebound", participant.room_id).run();
}
async function topicsFor(db, user, publicId, now) {
  const room = await db.prepare(`SELECT r.owner_teacher_id,r.mate_host_id,t.epoch,m.participant_id,b.uid AS teacher_uid
    FROM rooms r JOIN app_room_topics t ON t.room_id=r.id
    LEFT JOIN app_memberships m ON m.room_id=r.id AND m.uid=?
      AND EXISTS(SELECT 1 FROM participants p WHERE p.room_id=m.room_id AND p.id=m.participant_id AND p.status<>'REMOVED')
    LEFT JOIN app_teacher_bindings b ON b.uid=? AND b.active=true
    WHERE r.public_id=? AND r.expires_at_ms>? LIMIT 1`).bind(user.id, user.id, publicId, now).first();
  if (!room) return null;
  const owner = room.teacher_uid != null && room.teacher_uid === room.owner_teacher_id;
  if (!room.participant_id && !owner) return null;
  const epoch = room.epoch;
  return { control: `room:${publicId}:control:${epoch}`, host: owner || room.participant_id === room.mate_host_id ? `room:${publicId}:host:${epoch}` : null, epoch, role: owner ? "teacher" : room.participant_id === room.mate_host_id ? "host" : "participant" };
}
function createSupabaseGateway(options) {
  return async (incoming) => {
    const wallStarted = Date.now();
    const receivedAtMs = (options.now ?? Date.now)();
    const origin = incoming.headers.get("origin");
    if (!origin || !options.allowedOrigins.includes(origin)) return failure(403, "origin_forbidden", "\u8A31\u53EF\u3055\u308C\u305F\u30A2\u30D7\u30EA\u304B\u3089\u5229\u7528\u3057\u3066\u304F\u3060\u3055\u3044");
    if (incoming.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin, true);
    const url2 = new URL(incoming.url);
    const marker = url2.pathname.indexOf("/api/");
    if (marker < 0) return withCors(failure(404, "not_found", "API\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093"), origin);
    const path = url2.pathname.slice(marker);
    const match = /^\/api\/rooms\/([A-Za-z0-9_-]{1,128})\/([a-z-]+)$/.exec(path);
    const route = topRoutes[path] ?? (match ? roomRoutes[match[2]] : void 0);
    const realtime = match?.[2] === "realtime";
    if (!route && !realtime) return withCors(failure(404, "not_found", "API\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093"), origin);
    if (!(realtime ? ["GET"] : route.method).includes(incoming.method)) return withCors(failure(405, "method_not_allowed", "\u64CD\u4F5C\u65B9\u6CD5\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044"), origin);
    const requestId2 = crypto.randomUUID();
    const metrics = { poolWaitMs: 0, roomLockWaitMs: 0, dbWorkMs: 0, queryCount: 0, controlQueryCount: 0, ...route?.name === "joinRoom" || route?.name === "ready" ? { commandPath: "legacy" } : {} };
    let authMs = 0;
    let quotaMs = 0;
    const finish = (response) => {
      response.headers.set("x-request-id", requestId2);
      if (route?.name === "startRoom" || !response.ok || Math.random() < (options.metricSampleRate ?? 0.02)) console.info(JSON.stringify({ event: "api_request", requestId: requestId2, route: match?.[2] ?? path, totalMs: Date.now() - wallStarted, authMs, quotaMs, ...metrics, responseStatus: response.status }));
      return withCors(response, origin);
    };
    try {
      const authStarted = Date.now();
      const user = await options.verifyUser(incoming);
      authMs = Date.now() - authStarted;
      if (!user) return finish(failure(401, "authentication_required", "\u53C2\u52A0\u8CC7\u683C\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093"));
      const headers = new Headers(incoming.headers);
      const participant = headers.get("x-participant-authorization");
      headers.delete("authorization");
      if (participant) headers.set("authorization", participant);
      headers.set("origin", "https://competition.internal");
      headers.delete("sec-fetch-site");
      const request = new Request(`https://competition.internal${path}${url2.search}`, { method: incoming.method, headers, body: ["GET", "HEAD"].includes(incoming.method) ? void 0 : incoming.body, duplex: "half" });
      let publicId = match?.[1] ?? "";
      const scope = path.startsWith("/api/teacher/") ? "teacher-configuration" : publicId ? `room:${publicId}` : `creation:${user.id}`;
      const inspect2 = options.inspect ?? options.transact;
      const now = (options.now ?? Date.now)();
      const quotaStarted = Date.now();
      const limit = await inspect2(`quota:${route?.name === "startStatus" || route?.name === "startRoom" ? "critical:" : ""}${user.id}`, async (db) => db.prepare(`INSERT INTO app_request_limits(bucket,window_ms,count) VALUES(?,?,1)
        ON CONFLICT(bucket) DO UPDATE SET count=app_request_limits.count+1 RETURNING count`).bind(`${user.id}:${Math.floor(now / 6e4)}`, now).first(), metrics);
      quotaMs = Date.now() - quotaStarted;
      if ((limit?.count ?? 0) > 180) {
        const limited = failure(429, "rate_limited", "\u901A\u4FE1\u304C\u96C6\u4E2D\u3057\u3066\u3044\u307E\u3059\u3002\u5C11\u3057\u5F85\u3063\u3066\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044");
        limited.headers.set("retry-after", String(Math.ceil((6e4 - now % 6e4) / 1e3)));
        return finish(limited);
      }
      if (route?.name === "startStatus") {
        const response2 = await inspect2(`snapshot:${publicId}`, async (db) => {
          const provider = await teacherProvider(db, user, options.masterEmail, true);
          if (participant) {
            const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(participant)?.[1];
            const hash = token ? await hashParticipantToken(token) : "";
            const membership = await db.prepare(`SELECT m.uid FROM app_memberships m JOIN participants p ON p.room_id=m.room_id AND p.id=m.participant_id
              JOIN rooms r ON r.id=p.room_id WHERE r.public_id=? AND p.token_hash=? AND p.status<>'REMOVED' AND m.uid=?`).bind(publicId, hash, user.id).first();
            if (!membership) return failure(403, "not_authorized", "\u53C2\u52A0\u8CC7\u683C\u3092\u518D\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
          }
          const handlers = createApiHandlers({ database: db, teacherIdentity: provider, serverConfig: { teacherAllowedEmails: [], masterTeacherEmail: options.masterEmail.trim().toLowerCase() }, now: options.now ?? Date.now, random: Math.random, randomUUID: () => crypto.randomUUID() });
          return handlers.startStatus(request, { id: publicId });
        }, metrics);
        return finish(response2);
      }
      if (options.snapshotReads !== false && (realtime || route?.name === "state" || route?.name === "manifest")) {
        const snapshot = await (options.read ?? inspect2)(`snapshot:${publicId}`, async (db) => {
          const room = await readSnapshotRoom(db, publicId, user.id, participant);
          if (!room) return failure(404, "not_found", "\u30EB\u30FC\u30E0\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
          if (participant && room.participant_id && room.participant_status !== "REMOVED" && room.membership_uid !== user.id) return null;
          const provider = await teacherProvider(db, user, options.masterEmail, true);
          if (!participant && googleIdentity(user) && !await provider.getVerifiedIdentity()) return null;
          const handlers = createApiHandlers({
            database: db,
            teacherIdentity: provider,
            serverConfig: { teacherAllowedEmails: [], masterTeacherEmail: options.masterEmail.trim().toLowerCase() },
            now: options.now ?? Date.now,
            random: Math.random,
            randomUUID: () => crypto.randomUUID(),
            snapshotRoom: room,
            ...participant && room.participant_id && (!request.headers.has("x-participant-id") || request.headers.get("x-participant-id") === room.participant_id) ? { snapshotParticipant: { participantId: room.participant_id, tokenHash: room.token_hash, status: room.participant_status, nickname: room.participant_nickname } } : {}
          });
          const result = await handlers[route?.name === "manifest" ? "manifest" : "state"](request, { id: publicId });
          if (!result.ok) return result;
          if (route?.name !== "manifest" && snapshotNeedsTransition(room, (options.now ?? Date.now)())) return null;
          const body = await result.json();
          const identity = await provider.getVerifiedIdentity();
          const owner = identity?.id === room.owner_teacher_id;
          const member = room.participant_id && room.membership_uid === user.id && room.participant_status !== "REMOVED";
          const topics = room.topic_epoch != null && room.expires_at_ms > (options.now ?? Date.now)() && (owner || member) ? {
            control: `room:${publicId}:control:${room.topic_epoch}`,
            host: owner || room.participant_id === room.mate_host_id ? `room:${publicId}:host:${room.topic_epoch}` : null,
            epoch: room.topic_epoch,
            role: owner ? "teacher" : room.participant_id === room.mate_host_id ? "host" : "participant"
          } : null;
          if (realtime) return topics ? jsonResponse(topics) : failure(403, "not_authorized", "\u901A\u77E5\u3092\u8CFC\u8AAD\u3059\u308B\u6A29\u9650\u304C\u3042\u308A\u307E\u305B\u3093");
          return jsonResponse({ ...body, ...route?.name === "state" ? { ...topics ? { realtime: topics } : {}, serverTiming: { receivedAtMs, sentAtMs: (options.now ?? Date.now)() } } : {} });
        }, metrics);
        if (snapshot) return finish(snapshot);
      }
      const response = await options.transact(scope, async (db) => {
        const now2 = (options.now ?? Date.now)();
        const provider = await teacherProvider(db, user, options.masterEmail);
        const handlers = createApiHandlers({ database: db, teacherIdentity: provider, serverConfig: { teacherAllowedEmails: [], masterTeacherEmail: options.masterEmail.trim().toLowerCase() }, now: options.now ?? Date.now, random: () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296, randomUUID: () => crypto.randomUUID() });
        if (route?.name === "joinRoom" && options.nativeJoin || route?.name === "ready" && options.nativeReady) {
          const native = await nativeRoomCommand(db, request.clone(), publicId, user.id, route.name === "joinRoom" ? "join" : "ready");
          if (native) {
            metrics.commandPath = "native";
            return native;
          }
        }
        const includeProgress = route?.name !== "state" && route?.name !== "ready" && !realtime;
        const before = publicId ? await roomFingerprint(db, publicId, includeProgress) : null;
        const result = await handlers[realtime ? "state" : route.name](request.clone(), { id: publicId });
        if (!result.ok) return result;
        const body = await result.clone().json();
        publicId = publicId || body.room?.id || "";
        if (publicId) {
          const room = await db.prepare("SELECT id FROM rooms WHERE public_id=?").bind(publicId).first();
          if (room) {
            if (incoming.method !== "GET") await db.prepare("INSERT OR IGNORE INTO app_room_topics(room_id) VALUES(?)").bind(room.id).run();
            await associateParticipant(db, user, request, publicId);
            await queueRoomEvents(db, publicId, before, now2, includeProgress, route?.name === "ready");
          }
          const topics = realtime || route?.name === "state" ? await topicsFor(db, user, publicId, now2) : null;
          if (realtime) return topics ? jsonResponse(topics) : failure(403, "not_authorized", "\u901A\u77E5\u3092\u8CFC\u8AAD\u3059\u308B\u6A29\u9650\u304C\u3042\u308A\u307E\u305B\u3093");
          if (route?.name === "state" && topics) return jsonResponse({ ...body, realtime: topics });
        }
        return result;
      }, metrics);
      if (publicId) void options.flush(publicId).catch(() => {
      });
      const timedResponse = route?.name === "state" && response.ok ? jsonResponse({ ...await response.clone().json(), serverTiming: { receivedAtMs, sentAtMs: (options.now ?? Date.now)() } }) : response;
      return finish(timedResponse);
    } catch (error) {
      console.error(JSON.stringify({ event: "gateway_failed", category: error instanceof Error ? error.name : "Unknown", code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : void 0 }));
      const code = error.code;
      const unavailable = failure(503, code === "55P03" ? "database_busy" : code === "57014" ? "database_timeout" : error instanceof Error && ["TimeoutError", "AuthenticationUnavailableError"].includes(error.name) ? "authentication_unavailable" : "service_unavailable", "\u30B5\u30FC\u30D3\u30B9\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093\u3002\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044");
      unavailable.headers.set("retry-after", "2");
      return finish(unavailable);
    }
  };
}

// src/platform/priority-transactions.ts
function priorityTransactions(run, limit = 256) {
  const queue = [];
  let active = false;
  let criticalStreak = 0;
  const pump = () => {
    if (active || !queue.length) return;
    active = true;
    const preferred = queue.findIndex((x) => x.priority === (criticalStreak >= 8 ? 1 : 0));
    const entry = queue.splice(preferred < 0 ? 0 : preferred, 1)[0];
    criticalStreak = entry.priority === 0 ? criticalStreak + 1 : 0;
    void entry.start().finally(() => {
      active = false;
      pump();
    });
  };
  return (scope, work, metrics) => new Promise((resolve, reject) => {
    if (queue.length >= limit) {
      reject(new Error("Critical request queue full"));
      return;
    }
    const queued = Date.now();
    queue.push({ priority: scope.startsWith("snapshot:") || scope.startsWith("quota:critical:") ? 0 : 1, start: async () => {
      if (metrics) metrics.poolWaitMs += Date.now() - queued;
      try {
        resolve(await run(scope, work, metrics));
      } catch (error) {
        reject(error);
      }
    } });
    pump();
  });
}

// src/platform/maintenance.ts
function createMaintenanceHandler(options) {
  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: { code: "method_not_allowed" } }, { status: 405 });
    if (!options.secret) return Response.json({ error: { code: "maintenance_unavailable" } }, { status: 503 });
    if (request.headers.get("authorization") !== `Bearer ${options.secret}`) return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    const clock = options.now ?? Date.now;
    const now = clock();
    try {
      const pending = await options.transact("maintenance", async (db) => {
        const lease = await db.prepare("UPDATE app_maintenance SET lease_until_ms=?,last_attempt_ms=? WHERE id=1 AND lease_until_ms<? RETURNING id").bind(now + 55e3, now, now).first();
        if (!lease) return null;
        await cleanupExpired(db, { nowMs: now, limit: 40 });
        await db.prepare("SELECT app_prune_auxiliary()").run();
        const rooms = (await db.prepare(`SELECT r.public_id,r.id AS room_id FROM app_outbox o JOIN rooms r ON r.id=o.room_id
      WHERE r.expires_at_ms>? GROUP BY r.public_id,r.id ORDER BY MIN(o.maintenance_attempt_ms),MIN(o.queued_at_ms),r.public_id LIMIT 8`).bind(now).all()).results;
        if (rooms.length) await db.prepare(`UPDATE app_outbox SET maintenance_attempt_ms=? WHERE room_id IN (${rooms.map(() => "?").join(",")})`).bind(now, ...rooms.map((r) => r.room_id)).run();
        return rooms;
      });
      if (!pending) return Response.json({ skipped: true }, { status: 202 });
      await Promise.all(pending.map((room) => options.flush(room.public_id)));
      await options.transact("maintenance", (db) => db.prepare("UPDATE app_maintenance SET last_success_ms=? WHERE id=1 AND last_attempt_ms=?").bind(clock(), now).run());
      return Response.json({ checkedRooms: pending.length });
    } catch {
      console.error(JSON.stringify({ event: "maintenance_failed" }));
      return Response.json({ error: { code: "maintenance_unavailable" } }, { status: 503 });
    }
  };
}

// src/platform/shared-teacher-authority.ts
var encoder = new TextEncoder();
var JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function validSignature(secret, body, signature) {
  if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const key2 = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key2, Uint8Array.from(signature.match(/../g), (part) => parseInt(part, 16)), encoder.encode(body));
}
async function sha2562(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
function validEnvelope(value) {
  return value && typeof value === "object" && /^[a-z0-9-]{3,64}$/.test(value.appId) && /^[A-Za-z0-9_-]{16,128}$/.test(value.requestId) && Number.isSafeInteger(value.issuedAtMs) && ["authorize", "allowlist.get", "allowlist.mutate"].includes(value.action) && typeof value.bearerToken === "string" && value.bearerToken.length > 0 && value.bearerToken.length <= 8192;
}
function validMutation(value) {
  return value && typeof value === "object" && typeof value.email === "string" && typeof value.enabled === "boolean" && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 && typeof value.requestId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.requestId);
}
function createSharedTeacherAuthority(options) {
  return async (request) => {
    if (request.method !== "POST") return reply(405, { error: { code: "method_not_allowed" } });
    let body;
    try {
      body = await request.text();
      if (encoder.encode(body).length > 12e3) return reply(413, { error: { code: "body_too_large" } });
    } catch {
      return reply(400, { error: { code: "invalid_request" } });
    }
    let envelope;
    try {
      envelope = JSON.parse(body);
    } catch {
      return reply(400, { error: { code: "invalid_request" } });
    }
    if (!validEnvelope(envelope)) return reply(400, { error: { code: "invalid_request" } });
    try {
      const registry = await options.lookupRegistry(envelope.appId);
      if (!registry || registry.appId !== envelope.appId || !/^https:\/\/[^/?#]+$/.test(registry.authUrl)) return reply(401, { error: { code: "caller_forbidden" } });
      const secret = options.readSecret(registry.secretName);
      if (!secret || secret.length < 32 || !await validSignature(secret, body, request.headers.get("x-shared-teacher-signature"))) return reply(401, { error: { code: "caller_forbidden" } });
      if (Math.abs(options.now() - envelope.issuedAtMs) > 3e4) return reply(401, { error: { code: "request_expired" } });
      if (!await options.claimRequest(envelope.appId, envelope.requestId, envelope.issuedAtMs)) return reply(409, { error: { code: "request_replayed" } });
      const remote = await options.verifyRemoteUser(registry.authUrl, registry.publishableKey, envelope.bearerToken);
      const identity = remote && googleIdentity(remote);
      if (!identity) return reply(403, { error: { code: "teacher_forbidden" } });
      const master = normalizeTeacherEmail(options.masterEmail);
      if (!master) return reply(503, { error: { code: "authority_unavailable" } });
      const list = await options.readAllowlist();
      const isMaster = identity.email === master;
      const allowed = isMaster || list.emails.includes(identity.email);
      if (envelope.action === "authorize") return allowed ? reply(200, { allowed: true, master: isMaster, email: identity.email, revision: list.revision }) : reply(403, { error: { code: "teacher_forbidden" } });
      if (!isMaster) return reply(403, { error: { code: "master_required" } });
      const view = (value) => ({ masterEmail: master, emails: value.emails, revision: value.revision });
      if (envelope.action === "allowlist.get") return reply(200, view(list));
      if (!validMutation(envelope.mutation)) return reply(400, { error: { code: "invalid_request" } });
      const mutation = { ...envelope.mutation, email: normalizeTeacherEmail(envelope.mutation.email) };
      if (mutation.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mutation.email)) return reply(400, { error: { code: "invalid_email" } });
      if (mutation.email === master) return reply(400, { error: { code: "master_fixed" } });
      const bodyHash2 = await sha2562(JSON.stringify(mutation));
      if (list.lastOperation?.requestId === mutation.requestId) {
        return list.lastOperation.bodyHash === bodyHash2 ? reply(200, view(list)) : reply(409, { error: { code: "request_id_reused" } });
      }
      if (list.revision !== mutation.expectedRevision) return reply(409, { error: { code: "stale_allowlist" } });
      if (mutation.enabled && !list.emails.includes(mutation.email) && list.emails.length >= 100) return reply(400, { error: { code: "allowlist_limit" } });
      if (!await options.mutateAllowlist({ ...mutation, bodyHash: bodyHash2 })) return reply(409, { error: { code: "stale_allowlist" } });
      return reply(200, view(await options.readAllowlist()));
    } catch {
      return reply(503, { error: { code: "authority_unavailable" } });
    }
  };
}

// src/platform/shared-teacher-store.ts
function sharedTeacherStore(transact2, masterEmail) {
  return {
    lookupRegistry: (appId) => transact2(`shared-registry:${appId}`, async (db) => {
      const row = await db.prepare("SELECT app_id,auth_url,publishable_key,secret_env_name FROM shared_teacher_callers WHERE app_id=? AND enabled=true").bind(appId).first();
      return row ? { appId: row.app_id, authUrl: row.auth_url, publishableKey: row.publishable_key, secretName: row.secret_env_name } : null;
    }),
    claimRequest: (appId, requestId2, issuedAtMs) => transact2(`shared-request:${appId}:${requestId2}`, async (db) => {
      const row = await db.prepare("INSERT INTO shared_teacher_requests(app_id,request_id,issued_at_ms) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING request_id").bind(appId, requestId2, issuedAtMs).first();
      if (crypto.getRandomValues(new Uint32Array(1))[0] % 200 === 0) {
        await db.prepare("DELETE FROM shared_teacher_requests WHERE issued_at_ms<?").bind(Date.now() - 12e4).run();
      }
      return !!row;
    }),
    readAllowlist: () => transact2("shared-allowlist-read", async (db) => {
      await ensureMasterConfig(db, masterEmail);
      return readAllowlist(db);
    }),
    mutateAllowlist: (value) => transact2("shared-allowlist", async (db) => {
      await ensureMasterConfig(db, masterEmail);
      await db.prepare("INSERT INTO teacher_allowlist(id) VALUES(1) ON CONFLICT DO NOTHING").run();
      const current = await readAllowlist(db);
      if (current.revision !== value.expectedRevision) return false;
      const emails = new Set(current.emails);
      value.enabled ? emails.add(value.email) : emails.delete(value.email);
      if (emails.size > 100) return false;
      const updated = await db.prepare("UPDATE teacher_allowlist SET emails_json=?,revision=revision+1,last_request_id=?,last_body_hash=? WHERE id=1 AND revision=? RETURNING revision").bind(JSON.stringify([...emails].sort()), value.requestId, value.bodyHash, value.expectedRevision).first();
      return !!updated;
    })
  };
}
async function ensureMasterConfig(db, masterEmail) {
  await db.prepare("INSERT INTO app_auth_config(id,master_email) VALUES(1,?) ON CONFLICT DO NOTHING").bind(masterEmail).run();
  const configured = await db.prepare("SELECT master_email FROM app_auth_config WHERE id=1").first();
  if (configured?.master_email !== masterEmail) throw new Error("Master identity configuration differs");
}
async function readAllowlist(db) {
  const row = await db.prepare("SELECT emails_json,revision,last_request_id,last_body_hash FROM teacher_allowlist WHERE id=1").first();
  return row ? {
    emails: JSON.parse(row.emails_json),
    revision: row.revision,
    lastOperation: row.last_request_id && row.last_body_hash ? { requestId: row.last_request_id, bodyHash: row.last_body_hash } : null
  } : { emails: [], revision: 0, lastOperation: null };
}

// src/platform/edge-entry.ts
var required = (name) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing backend configuration: ${name}`);
  return value;
};
var url = required("SUPABASE_URL");
var key = required("SUPABASE_ANON_KEY");
var serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
var databaseUrl = Deno.env.get("COMPETITION_DATABASE_URL") ?? transactionPoolerUrl(
  required("SUPABASE_DB_URL"),
  "slktkbpvvsfpflnmpuvr",
  "aws-0-ap-northeast-2.pooler.supabase.com"
);
var transact = postgresTransactions(databaseUrl);
var inspect = priorityTransactions(postgresTransactions(databaseUrl));
var read = postgresTransactions(databaseUrl);
var flush = coalescedRoomFlusher(async (publicId) => {
  await retryRoomDrain(() => flushRoomEvents(transact, publicId, async (topic, event, payload) => {
    const result = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: true }] }),
      signal: AbortSignal.timeout(3e3)
    });
    if (!result.ok) throw new Error("Broadcast delivery failed");
  }));
});
var gateway = createSupabaseGateway({
  transact,
  inspect,
  read,
  nativeJoin: Deno.env.get("COMPETITION_NATIVE_JOIN") === "true",
  nativeReady: Deno.env.get("COMPETITION_NATIVE_READY") === "true",
  snapshotReads: Deno.env.get("COMPETITION_SNAPSHOT_READS") !== "false",
  verifyUser: (request) => verifySupabaseUser(request, url, key),
  masterEmail: required("MASTER_TEACHER_EMAIL"),
  allowedOrigins: required("ALLOWED_ORIGINS").split(",").map((x) => x.trim()).filter(Boolean),
  flush: async (id) => {
    EdgeRuntime.waitUntil(flush(id));
  }
});
var maintenance = createMaintenanceHandler({ transact, flush, secret: Deno.env.get("COMPETITION_MAINTENANCE_KEY") });
var store = sharedTeacherStore(transact, required("MASTER_TEACHER_EMAIL").trim().toLowerCase());
var authority = createSharedTeacherAuthority({
  now: Date.now,
  masterEmail: required("MASTER_TEACHER_EMAIL"),
  lookupRegistry: store.lookupRegistry,
  readSecret: (name) => Deno.env.get(name),
  claimRequest: store.claimRequest,
  verifyRemoteUser: (authUrl, publishableKey, bearerToken) => verifySupabaseUser(
    new Request(`${authUrl}/auth/v1/user`, { headers: { authorization: `Bearer ${bearerToken}` } }),
    authUrl,
    publishableKey
  ),
  readAllowlist: store.readAllowlist,
  mutateAllowlist: store.mutateAllowlist
});
Deno.serve(async (request) => {
  const path = new URL(request.url).pathname;
  return path.endsWith("/maintenance") ? maintenance(request) : path.endsWith("/shared-teacher") ? authority(request) : gateway(request);
});
