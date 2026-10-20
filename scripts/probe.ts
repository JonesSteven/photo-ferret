// Live probe: prepares one photo exactly like the server and prints Jev's raw and normalized answers.
// Costs one Jev request. Never prints the key. Usage: npm run probe -- path/to/photo.jpg
import { readFile } from "node:fs/promises";
import { prepareImage } from "../server/imagePrep.ts";
import { askJev, describeJevError, hasApiKey, normalize } from "../server/jev.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run probe -- <photo>");
  process.exit(2);
}
if (!hasApiKey()) {
  console.error("TYPESAFE_API_KEY is not set (put it in .env).");
  process.exit(2);
}

const img = await prepareImage(await readFile(file));
console.log(`Prepared ${file}: ${img.originalFormat} -> JPEG ${img.width}x${img.height}, ${(img.jpeg.length / 1024).toFixed(0)} KiB, resized=${img.resized}`);
try {
  const { res, elapsedMs } = await askJev(img);
  console.log("Raw answers:", JSON.stringify(res.answers, null, 2));
  const summary = normalize(res.answers, img, { model: res.model, usage: res.usage, elapsedMs });
  console.log("Normalized:", JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(describeJevError(err));
  process.exit(1);
}
