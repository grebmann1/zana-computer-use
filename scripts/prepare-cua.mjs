import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, rename, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../vendor/cua/", import.meta.url);
const release = JSON.parse(await readFile(new URL("release.json", root), "utf8"));
const check = process.argv.includes("--check");
for (const asset of Object.values(release.assets)) {
  const path = fileURLToPath(new URL(asset.archive, root));
  if (!existsSync(path)) {
    if (check) throw new Error(`Missing bundled release: ${asset.archive}. Run npm run prepare:cua.`);
    const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${asset.archive}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${asset.archive}`);
    const partial = `${path}.partial`;
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error(`Checksum mismatch: ${asset.archive}`);
      await writeFile(partial, bytes);
      await rename(partial, path);
    } finally { await rm(partial, { force: true }); }
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== asset.sha256) throw new Error(`Checksum mismatch: ${asset.archive}`);
  console.log(`Verified ${asset.archive}`);
}
