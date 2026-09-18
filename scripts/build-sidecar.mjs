import { rm } from "node:fs/promises"
import { build } from "esbuild"

await rm("dist-sidecar", { recursive: true, force: true })
await build({
  entryPoints: ["src/sidecar/server.ts"],
  outfile: "dist-sidecar/sidecar/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["playwright-core"],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "eof",
  minifyIdentifiers: false,
  minifySyntax: true,
  minifyWhitespace: true,
  sourcemap: false,
})
