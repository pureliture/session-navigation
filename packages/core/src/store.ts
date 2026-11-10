import { EngineError, safeNumber, type Driver, type Row, type Value } from "./driver.ts";
import { adapterProtocol, engineProtocol, schema, schemaVersion } from "./schema.ts";
import {
  bytes,
  canonical,
  invocationDigest,
  itemId,
  parseCanonicalJson,
  scopeAliases,
  scopeKey,
  sha256,
  type Item,
  type Json,
  type RecordInput,
  type Result,
  type ScopeLike,
} from "./model.ts";
export const walSupported = (version: string): boolean => {
  const versionParts = version.split(".").map(Number);
  const minimumWalVersion = [3, 51, 3];
  for (let index = 0; index < 3; index++) {
    if (versionParts[index] > minimumWalVersion[index]) {
      return true;
    }
    if (versionParts[index] < minimumWalVersion[index]) {
      return ["3.44.6", "3.50.7"].includes(version);
    }
  }
  return true;
};
function decodeItem(row: Row): Item {
  const { scope_key: _scope, ...columns } = row;
  return {
    ...columns,
    result_position: safeNumber(row.result_position),
    version: safeNumber(row.version),
    excerpt_lines: JSON.parse(String(row.excerpt_lines)),
    invocation_snapshot:
      row.invocation_snapshot === null ? null : parseCanonicalJson(String(row.invocation_snapshot)),
    context_hint: row.context_hint === null ? null : parseCanonicalJson(String(row.context_hint)),
    invocation_options_omitted: !!row.invocation_options_omitted,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  } as unknown as Item;
}
export interface Registration {
  adapter_id: string;
  adapter_protocol: number;
  capabilities: {
    hide: boolean;
    summarize: boolean;
    unhide: boolean;
  };
  enabled: boolean;
  instance_id: string;
  last_seen: number;
  scope_key?: string;
}
export class Store {
  readonly sqliteVersion: string;
  readonly driver: Driver;
  readonly clock: () => number;

  constructor(driver: Driver, clock = () => Date.now() / 1000) {
    this.driver = driver;
    this.clock = clock;
    try {
      driver.exec("PRAGMA busy_timeout=5000");
      this.checkProtocol();
      this.sqliteVersion = String(driver.get("SELECT sqlite_version() AS version")!.version);
      const mode = this.configureJournalMode();
      driver.exec(`PRAGMA synchronous=${mode === "wal" ? "NORMAL" : "FULL"}`);
      const meta = this.meta();
      if (
        meta.schema_version !== schemaVersion ||
        meta.engine_protocol_version !== String(engineProtocol) ||
        ![
          "meta",
          "items",
          "identities",
          "units",
          "calls",
          "adapter_sessions",
          "adapter_targets",
        ].every((name) =>
          driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]),
        )
      ) {
        this.transaction(() => {
          for (const sql of schema) {
            driver.exec(sql);
          }
          for (const [key, value] of [
            ["schema_version", schemaVersion],
            ["engine_protocol_version", String(engineProtocol)],
          ]) {
            driver.run(
              "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              [key, value],
            );
          }
        });
      }
    } catch (error) {
      driver.close();
      throw error;
    }
  }

  private configureJournalMode(): string {
    try {
      this.driver.get("PRAGMA journal_mode=DELETE");
    } catch {
      // Python also permits a retained WAL only after verifying the runtime gate.
      return this.verifyJournalMode();
    }
    return this.verifyJournalMode();
  }

  private verifyJournalMode(): string {
    const mode = String(this.driver.get("PRAGMA journal_mode")!.journal_mode);
    if (mode === "wal" && !walSupported(this.sqliteVersion)) {
      throw new EngineError("unsafe_journal_mode");
    }
    if (!["delete", "wal", "memory"].includes(mode)) {
      throw new EngineError("db_error", "Unverified journal mode");
    }
    return mode;
  }

  private meta(): {
    [key: string]: string;
  } {
    return this.driver.get("SELECT name FROM sqlite_master WHERE name='meta'")
      ? Object.fromEntries(
          this.driver
            .all("SELECT key,value FROM meta")
            .map((row) => [String(row.key), String(row.value)]),
        )
      : {};
  }

  checkProtocol(): void {
    const metadata = this.meta();
    if (
      (metadata.engine_protocol_version !== undefined &&
        metadata.engine_protocol_version !== String(engineProtocol)) ||
      (metadata.schema_version !== undefined && !["1", "2"].includes(metadata.schema_version))
    ) {
      throw new EngineError("engine_protocol_incompatible");
    }
  }

  private checkWrite(): void {
    this.checkProtocol();
    if (
      String(this.driver.get("PRAGMA journal_mode")!.journal_mode) === "wal" &&
      !walSupported(this.sqliteVersion)
    ) {
      throw new EngineError("unsafe_journal_mode");
    }
  }

  transaction<T>(operation: () => T): T {
    this.checkWrite();
    this.driver.exec("BEGIN IMMEDIATE");
    try {
      this.checkWrite();
      const result = operation();
      this.driver.exec("COMMIT");
      return result;
    } catch (error) {
      this.driver.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.driver.close();
  }

  get(scope: ScopeLike, id: string): Item | undefined {
    const row = this.driver.get("SELECT * FROM items WHERE scope_key=? AND item_id=?", [
      scopeKey(scope),
      id,
    ]);
    return row ? decodeItem(row) : undefined;
  }

  items(scope: ScopeLike): Item[] {
    return this.driver
      .all("SELECT * FROM items WHERE scope_key=? ORDER BY created_at,item_id", [scopeKey(scope)])
      .map(decodeItem);
  }

  put(scope: ScopeLike, item: Item, expectedVersion?: number, createOnly = false): Result {
    return this.transaction(() => {
      const key = scopeKey(scope);
      const existing = this.get(scope, item.item_id);
      if (createOnly && existing) {
        return { ok: false, error: "version_conflict", item: existing };
      }
      if (expectedVersion !== undefined && (!existing || existing.version !== expectedVersion)) {
        return { ok: false, error: "version_conflict", item: existing };
      }
      const now = this.clock();
      const saved = {
        ...item,
        content_sha256: item.content_sha256 || sha256(item.original),
        created_at: existing?.created_at || item.created_at || now,
        updated_at: now,
      };
      const columns = [
        "tool_call_id",
        "result_position",
        "content_sha256",
        "invocation_digest",
        "original",
        "compacted",
        "excerpt_lines",
        "visibility",
        "version",
        "tool_name",
        "compaction_source",
        "invocation_snapshot",
        "context_hint",
        "invocation_options_omitted",
        "created_at",
        "updated_at",
      ] as const;
      const values = columns.map((column) =>
        column === "excerpt_lines" || column === "invocation_snapshot" || column === "context_hint"
          ? saved[column] === null
            ? null
            : canonical(saved[column] as Json)
          : column === "invocation_options_omitted"
            ? Number(saved[column])
            : saved[column],
      ) as Value[];
      const result = existing
        ? this.driver.run(
            `UPDATE items SET ${columns.map((column) => `${column}=?`).join(",")} WHERE scope_key=? AND item_id=? AND version=?`,
            [...values, key, item.item_id, existing.version],
          )
        : this.driver.run(
            `INSERT INTO items(scope_key,item_id,${columns.join(",")}) VALUES (${Array(18).fill("?").join(",")}) ON CONFLICT(scope_key,item_id) DO NOTHING`,
            [key, item.item_id, ...values],
          );
      if (result.changes !== 1) {
        return { ok: false, error: "version_conflict", item: this.get(scope, item.item_id) };
      }
      this.driver.run(
        `INSERT INTO
        identities
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, tool_call_id, content_sha256, invocation_digest, result_position) DO UPDATE
      SET
        item_id = excluded.item_id,
        version = excluded.version,
        updated_at = excluded.updated_at`,
        [
          key,
          item.tool_call_id,
          saved.content_sha256,
          item.invocation_digest,
          item.result_position,
          item.item_id,
          item.version,
          now,
        ],
      );
      return { ok: true, item: saved };
    });
  }

  restore(scope: ScopeLike, id: string, expectedVersion?: number): Result {
    return this.transaction(() => {
      const item = this.get(scope, id);
      if (!item) {
        return { ok: false, error: "not_found" };
      }
      if (expectedVersion !== undefined && expectedVersion !== item.version) {
        return { ok: false, error: "version_conflict", item };
      }
      if (item.visibility === "visible") {
        return { ok: true, item };
      }
      const now = this.clock();
      const updateResult = this.driver.run(
        `UPDATE items
      SET
        visibility = 'visible',
        version = ?,
        updated_at = ?
      WHERE
        scope_key = ?
        AND item_id = ?
        AND version = ?`,
        [item.version + 1, now, scopeKey(scope), id, item.version],
      );
      return updateResult.changes === 1
        ? {
            ok: true,
            item: { ...item, visibility: "visible", version: item.version + 1, updated_at: now },
          }
        : { ok: false, error: "version_conflict", item };
    });
  }

  batch<T>(
    itemIdentities: string[],
    operation: (id: string) => T,
  ): {
    id: string;
    result: T | Result;
  }[] {
    return [...new Set(itemIdentities)].map((id) => {
      try {
        return { id, result: operation(id) };
      } catch (error) {
        if (error instanceof EngineError) {
          return { id, result: { ok: false, error: error.code } };
        }
        throw error;
      }
    });
  }

  registration(scope: ScopeLike): Registration | undefined {
    for (const key of scopeAliases(scopeKey(scope))) {
      const row = this.driver.get("SELECT * FROM adapter_sessions WHERE scope_key=?", [key]);
      if (row) {
        return {
          ...row,
          scope_key: key,
          capabilities: JSON.parse(String(row.capabilities)),
          enabled: !!row.enabled,
          adapter_protocol: safeNumber(row.adapter_protocol),
          last_seen: Number(row.last_seen),
        } as unknown as Registration;
      }
    }
  }

  can(scope: ScopeLike, capability: "hide" | "summarize" | "unhide"): boolean {
    const registration = this.registration(scope);
    return (
      !!registration &&
      registration.enabled &&
      registration.adapter_protocol === adapterProtocol &&
      registration.capabilities[capability] === true
    );
  }

  register(
    scope: ScopeLike,
    registration: Omit<Registration, "scope_key" | "last_seen">,
    now = this.clock(),
  ): boolean {
    const key = scopeKey(scope);
    const adapterRegistration = registration;
    if (!adapterRegistration.instance_id || key.split(":")[0] !== adapterRegistration.adapter_id) {
      throw new EngineError("invalid_adapter_registration");
    }
    const capabilitiesJson = canonical({
      hide: adapterRegistration.capabilities.hide === true,
      summarize: adapterRegistration.capabilities.summarize === true,
      unhide: adapterRegistration.capabilities.unhide === true,
    });
    return this.transaction(() => {
      const previousRegistration = this.driver.get(
        "SELECT * FROM adapter_sessions WHERE scope_key=?",
        [key],
      );
      if (
        previousRegistration &&
        previousRegistration.adapter_id === adapterRegistration.adapter_id &&
        previousRegistration.adapter_protocol === adapterRegistration.adapter_protocol &&
        previousRegistration.capabilities === capabilitiesJson &&
        !!previousRegistration.enabled === adapterRegistration.enabled &&
        previousRegistration.instance_id === adapterRegistration.instance_id &&
        now - Number(previousRegistration.last_seen) < 300
      ) {
        return false;
      }
      this.driver.run(
        `INSERT INTO
        adapter_sessions
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key) DO UPDATE
      SET
        adapter_id = excluded.adapter_id,
        adapter_protocol = excluded.adapter_protocol,
        capabilities = excluded.capabilities,
        enabled = excluded.enabled,
        instance_id = excluded.instance_id,
        last_seen = excluded.last_seen`,
        [
          key,
          adapterRegistration.adapter_id,
          adapterRegistration.adapter_protocol,
          capabilitiesJson,
          Number(adapterRegistration.enabled),
          adapterRegistration.instance_id,
          now,
        ],
      );
      return true;
    });
  }

  publishTargets(
    scope: ScopeLike,
    targets: {
      record: RecordInput;
      omitted?: {
        [key: string]: Json;
      };
    }[],
  ): void {
    const key = scopeKey(scope);
    for (const { record: record, omitted = {} } of targets) {
      if (
        !record.call_id ||
        record.result_position < 0 ||
        !record.invocation.tool_name ||
        record.status !== "ok" ||
        sha256(record.content) !== record.content_sha256 ||
        invocationDigest(record.invocation, omitted) !== record.invocation_digest
      ) {
        throw new EngineError("invalid_target_identity");
      }
    }
    this.transaction(() => {
      const owner = this.driver.get("SELECT * FROM adapter_sessions WHERE scope_key=?", [key]);
      if (
        !owner ||
        !owner.enabled ||
        owner.adapter_protocol !== adapterProtocol ||
        JSON.parse(String(owner.capabilities)).hide !== true
      ) {
        throw new EngineError("adapter_unavailable");
      }
      for (const { record: record, omitted = {} } of targets) {
        const invocationJson = canonical(record.invocation);
        if (bytes(record.content) + bytes(invocationJson) > 4 * 1024 * 1024) {
          continue;
        }
        const sequence = safeNumber(
          this.driver.get(
            "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM adapter_targets WHERE scope_key=?",
            [key],
          )!.seq,
        );
        this.driver.run(
          `INSERT INTO
        adapter_targets
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, item_id) DO NOTHING`,
          [
            key,
            itemId(
              key,
              record.call_id,
              record.content_sha256,
              record.invocation_digest,
              record.result_position,
            ),
            record.call_id,
            record.result_position,
            record.invocation_digest,
            invocationJson,
            record.content,
            record.content_sha256,
            String(record.invocation.tool_name),
            Number(Object.keys(omitted).length > 0),
            this.clock(),
            sequence,
          ],
        );
      }
      let size = 0;
      this.driver
        .all(
          `SELECT
        item_id,
        length(CAST(original AS BLOB)) + length(CAST(invocation_snapshot AS BLOB)) AS bytes
      FROM
        adapter_targets
      WHERE
        scope_key = ?
      ORDER BY
        seq DESC,
        item_id DESC`,
          [key],
        )
        .forEach((targetRow, index) => {
          size += safeNumber(targetRow.bytes);
          if (index >= 256 || size > 4 * 1024 * 1024) {
            this.driver.run("DELETE FROM adapter_targets WHERE scope_key=? AND item_id=?", [
              key,
              targetRow.item_id,
            ]);
          }
        });
    });
  }

  targets(scope: ScopeLike): Row[] {
    const owner = this.registration(scope);
    return owner
      ? this.driver.all("SELECT * FROM adapter_targets WHERE scope_key=? ORDER BY seq", [
          owner.scope_key!,
        ])
      : [];
  }

  ensureMessages(
    scope: ScopeLike,
    units: {
      unit_id: string;
      kind: string;
      content_sha256: string;
      char_count: number;
    }[],
  ): void {
    this.transaction(() => {
      for (const unit of units) {
        this.driver.run(
          `INSERT OR IGNORE INTO
        units (
          scope_key,
          unit_id,
          message_uid,
          kind,
          content_sha256,
          char_count,
          visibility,
          version,
          updated_at
        )
      VALUES
        (?, ?, ?, ?, ?, ?, 'visible', 1, ?)`,
          [
            scopeKey(scope),
            unit.unit_id,
            unit.unit_id,
            unit.kind,
            unit.content_sha256,
            unit.char_count,
            this.clock(),
          ],
        );
      }
    });
  }

  hiddenMessages(scope: ScopeLike): string[] {
    return this.driver
      .all(
        `SELECT
        unit_id
      FROM
        units
      WHERE
        scope_key = ?
        AND kind IN ('user', 'assistant')
        AND visibility = 'hidden'
      ORDER BY
        unit_id`,
        [scopeKey(scope)],
      )
      .map((row) => String(row.unit_id));
  }

  listUnits(scope: ScopeLike, messageUid?: string): Row[] {
    return this.driver.all(
      `SELECT * FROM units WHERE scope_key=?${messageUid === undefined ? "" : " AND message_uid=?"}`,
      [scopeKey(scope), ...(messageUid === undefined ? [] : [messageUid])],
    );
  }

  upsertUnit(
    scope: ScopeLike,
    unit: Row & {
      unit_id: string;
    },
  ): void {
    const row: Row = {
      scope_key: scopeKey(scope),
      unit_id: unit.unit_id,
      message_uid: null,
      kind: null,
      parent_unit_id: null,
      tool_call_id: null,
      content_sha256: null,
      char_count: 0,
      tokens_display: "—",
      visibility: "visible",
      version: 1,
      updated_at: this.clock(),
    };
    for (const key of Object.keys(row)) {
      if (!["scope_key", "unit_id"].includes(key) && unit[key] !== undefined) {
        row[key] = unit[key];
      }
    }
    const columns = Object.keys(row);
    this.transaction(() => {
      this.driver.run(
        `INSERT INTO units(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(scope_key,unit_id) DO UPDATE SET ${columns
          .filter((column) => !["scope_key", "unit_id"].includes(column))
          .map((column) => `${column}=excluded.${column}`)
          .join(",")}`,
        Object.values(row),
      );
    });
  }

  recordCall(
    scope: ScopeLike,
    key: string,
    prompt = 0,
    completion = 0,
    total = 0,
    cost: number | null = 0,
    recordedAt = this.clock(),
  ): void {
    this.transaction(() => {
      this.driver.run(
        `INSERT INTO
        calls
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, call_key) DO UPDATE
      SET
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        total_tokens = excluded.total_tokens,
        cost_usd = excluded.cost_usd,
        recorded_at = excluded.recorded_at`,
        [scopeKey(scope), key, prompt, completion, total, cost, recordedAt],
      );
    });
  }

  getCall(scope: ScopeLike, key: string): Row | undefined {
    return this.driver.get("SELECT * FROM calls WHERE scope_key=? AND call_key=?", [
      scopeKey(scope),
      key,
    ]);
  }

  fence(scope: ScopeLike, record: RecordInput): string | undefined {
    const row = this.driver.get(
      `SELECT
        item_id
      FROM
        identities
      WHERE
        scope_key = ?
        AND tool_call_id = ?
        AND content_sha256 = ?
        AND invocation_digest = ?
        AND result_position = ?`,
      [
        scopeKey(scope),
        record.call_id,
        record.content_sha256,
        record.invocation_digest,
        record.result_position,
      ],
    );
    return row ? String(row.item_id) : undefined;
  }

  setMessageVisibility(
    scope: ScopeLike,
    messageUid: string,
    kind: string,
    contentSha256: string,
    charCount: number,
    visibility: "hidden" | "visible",
    expectedVersion?: number,
  ): {
    ok: boolean;
    version: number;
    visibility: string;
    error?: string;
  } {
    return this.transaction(() => {
      const key = scopeKey(scope);
      const row = this.driver.get(
        "SELECT version,visibility FROM units WHERE scope_key=? AND unit_id=?",
        [key, messageUid],
      );
      const version = row ? safeNumber(row.version) : 1;
      const current = String(row?.visibility ?? "visible");
      if (expectedVersion !== undefined && expectedVersion !== version) {
        return { ok: false, error: "version_conflict", version, visibility: current };
      }
      if (current === visibility) {
        return { ok: true, version, visibility };
      }
      if (row) {
        this.driver.run(
          "UPDATE units SET visibility=?,version=?,updated_at=? WHERE scope_key=? AND unit_id=? AND version=?",
          [visibility, version + 1, this.clock(), key, messageUid, version],
        );
      } else {
        this.driver.run(
          `INSERT INTO
        units (
          scope_key,
          unit_id,
          message_uid,
          kind,
          content_sha256,
          char_count,
          visibility,
          version,
          updated_at
        )
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            key,
            messageUid,
            messageUid,
            kind,
            contentSha256,
            charCount,
            visibility,
            version + 1,
            this.clock(),
          ],
        );
      }
      return { ok: true, version: version + 1, visibility };
    });
  }

  fork(
    source: ScopeLike,
    destination: ScopeLike,
  ): {
    [key: string]: number;
  } {
    const sourceKey = scopeKey(source);
    const destinationKey = scopeKey(destination);
    return this.transaction(() => {
      const counts: {
        [key: string]: number;
      } = {};
      const itemIdentities = new Map<string, string>();
      for (const table of ["items", "identities", "units", "calls"]) {
        const rows = this.driver.all(`SELECT * FROM ${table} WHERE scope_key=?`, [sourceKey]);
        counts[table] = rows.length;
        for (const row of rows) {
          const copiedRow: Row = { ...row, scope_key: destinationKey };
          if (table === "items") {
            copiedRow.item_id = itemId(
              destinationKey,
              String(row.tool_call_id ?? ""),
              String(row.content_sha256 ?? ""),
              String(row.invocation_digest ?? ""),
              safeNumber(row.result_position),
            );
            itemIdentities.set(String(row.item_id), String(copiedRow.item_id));
          }
          if (table === "identities") {
            copiedRow.item_id = itemIdentities.get(String(row.item_id)) ?? row.item_id;
          }
          const columns = Object.keys(copiedRow);
          this.driver.run(
            `INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            Object.values(copiedRow),
          );
        }
      }
      return counts;
    });
  }
}
