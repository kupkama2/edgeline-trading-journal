/**
 * Load a Sigil Core seed pack into the database, from the command line.
 *
 *   DATABASE_URL=postgres://… npx tsx script/sigil-seed.ts path/to/sigil-core-seed.zip
 *   DATABASE_URL=postgres://… npx tsx script/sigil-seed.ts path/to/sigil-core-seed/
 *
 * The same import the Portfolio page's "Load a seed pack" does. Running it
 * twice leaves the same rows; an asset edited in the app since is kept.
 */
import fs from "node:fs";
import path from "node:path";

async function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) throw new Error("Give the path of the seed pack: a .zip, or the unpacked folder.");
  const { initSchema } = await import("../server/storage");
  const { importSeed, unzip } = await import("../server/sigil");
  await initSchema();
  let files: Map<string, Buffer>;
  if (fs.statSync(src).isDirectory()) {
    files = new Map();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(src, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else files.set(rel.replace(/\\/g, "/"), fs.readFileSync(path.join(src, rel)));
      }
    };
    walk("");
  } else files = unzip(fs.readFileSync(src));
  const done = await importSeed(files);
  console.log(`Loaded: ${done.snapshots} snapshots, ${done.changes} days of changes, ${done.history} history points, ${done.assets} assets.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
