import { mkdirSync } from "node:fs";

mkdirSync(new URL("./dist", import.meta.url), { recursive: true });
for (const entrypoint of ["extension", "worker"]) {
  const result = await Bun.build({
    entrypoints: [new URL(`./src/${entrypoint}.ts`, import.meta.url).pathname],
    outdir: new URL("./dist", import.meta.url).pathname,
    target: "bun",
    format: "esm",
    external: ["@oh-my-pi/*"],
    minify: false,
  });
  if (!result.success) throw new AggregateError(result.logs, "OMP package build failed");
}
