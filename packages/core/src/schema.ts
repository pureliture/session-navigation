export const schemaVersion='2';
export const engineProtocol=1;
export const adapterProtocol=1;
export const schema = [
  `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)`,
  `CREATE TABLE IF NOT EXISTS items(scope_key TEXT NOT NULL,item_id TEXT NOT NULL,tool_call_id TEXT,result_position INTEGER DEFAULT 0,content_sha256 TEXT,invocation_digest TEXT NOT NULL,original TEXT,compacted TEXT,excerpt_lines TEXT DEFAULT '[]',visibility TEXT CHECK(visibility IN ('hidden','visible')) DEFAULT 'hidden',version INTEGER DEFAULT 1,tool_name TEXT,compaction_source TEXT,invocation_snapshot TEXT,context_hint TEXT,invocation_options_omitted INTEGER DEFAULT 0,created_at REAL,updated_at REAL,PRIMARY KEY(scope_key,item_id),UNIQUE(scope_key,tool_call_id,content_sha256,invocation_digest,result_position))`,
  `CREATE TABLE IF NOT EXISTS identities(scope_key TEXT NOT NULL,tool_call_id TEXT NOT NULL,content_sha256 TEXT NOT NULL,invocation_digest TEXT NOT NULL,result_position INTEGER DEFAULT 0,item_id TEXT NOT NULL,version INTEGER DEFAULT 1,updated_at REAL,PRIMARY KEY(scope_key,tool_call_id,content_sha256,invocation_digest,result_position))`,
  `CREATE TABLE IF NOT EXISTS units(scope_key TEXT NOT NULL,unit_id TEXT NOT NULL,message_uid TEXT,kind TEXT CHECK(kind IN ('user','assistant','tool_call','tool_result')),parent_unit_id TEXT,tool_call_id TEXT,content_sha256 TEXT,char_count INTEGER DEFAULT 0,tokens_display TEXT DEFAULT '—',visibility TEXT DEFAULT 'visible',version INTEGER DEFAULT 1,updated_at REAL,PRIMARY KEY(scope_key,unit_id))`,
  `CREATE INDEX IF NOT EXISTS idx_units_scope_message ON units(scope_key,message_uid)`,
  `CREATE TABLE IF NOT EXISTS calls(scope_key TEXT NOT NULL,call_key TEXT NOT NULL,prompt_tokens INTEGER,completion_tokens INTEGER,total_tokens INTEGER,cost_usd REAL,recorded_at REAL,PRIMARY KEY(scope_key,call_key))`,
  `CREATE TABLE IF NOT EXISTS adapter_sessions(scope_key TEXT PRIMARY KEY,adapter_id TEXT NOT NULL,adapter_protocol INTEGER NOT NULL,capabilities TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),instance_id TEXT NOT NULL,last_seen REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS adapter_targets(scope_key TEXT NOT NULL,item_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,result_position INTEGER NOT NULL,invocation_digest TEXT NOT NULL,invocation_snapshot TEXT NOT NULL,original TEXT NOT NULL,content_sha256 TEXT NOT NULL,tool_name TEXT NOT NULL,options_omitted INTEGER NOT NULL DEFAULT 0,created_at REAL NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(scope_key,item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_adapter_targets_scope_seq ON adapter_targets(scope_key,seq)`,
];
