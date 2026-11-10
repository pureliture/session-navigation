# Shared engine core

Dependency-free ESM TypeScript implementation of `docs/engine-contract.md`.
The root export never imports either SQLite driver. Hosts choose explicitly:

```ts
import { Engine, Store } from '@session-navigation/core';
import { NodeDriver } from '@session-navigation/core/sqlite/node';
const store = new Store(new NodeDriver('/absolute/path/state.sqlite3'));
const engine = new Engine(store);
```

Bun hosts use `BunDriver` from `@session-navigation/core/sqlite/bun` instead.
SQLite APIs are synchronous: run this service inside the host's dedicated worker,
not on its UI/event loop. Model callbacks stay outside transactions. No model
client or provider is included.

`parseCanonicalJson` preserves Python JSON integer/float distinctions and large
integers. Use it for invocation JSON, rather than `JSON.parse`, before hashing.
Ordinary JS integer Numbers represent Python ints; `PythonFloat` explicitly
represents floats (including integral floats and negative zero). BigInt integers
serialize exactly. Unsafe integer Numbers and non-finite numbers are rejected.
Driver result INTEGER values outside the JS safe range remain BigInt; callers
must not coerce them to Number. Persisted invocation snapshots use the lossless
parser on read.

Each mutation commits independently; batch errors do not undo earlier targets.
Aliases are discovery-only: use the registration's resolved `scope_key` before
mutating or hashing. No scope/item migration occurs during alias lookup.

## Checks (from repository root)

Core TypeScript uses Prettier 3.5.3 with the local `.prettierrc.json`, matching
Paseo's two-space indentation, double quotes and semicolons. Run
`npm --prefix packages/core run format` to format this package. The Python
conformance runner is formatted with Ruff 0.11.13.

```sh
node paseo-plugin/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node --test packages/core/test/core.test.ts
bun test packages/core/test/core.test.ts
PYTHONPATH=src .venv/bin/python tools/core_conformance.py
.venv/bin/python -m pytest -q
```

Typechecking uses the already-installed repository TypeScript/Node dev types.
Node 24's native TypeScript stripping runs the tests without a runtime loader.
Bun tests use the same source and test cases with its native driver.
The fixtures compare Python, Node and Bun replacements, hashes, versions and
durable rows, then exercise both directions of cross-runtime writes. Timestamps
are normalized for comparison; originals and replacement bytes are not.
