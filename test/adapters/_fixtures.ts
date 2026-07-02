import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "fixtures", "tee-on");

/**
 * Load a Tee-On fixture and return the REAL HTTP body bytes.
 *
 * The captured fixtures (logc-2026-07-15.html, logc-results-2026-07-15.html)
 * were saved JSON-encoded (the file is one JSON string of the HTML). Live HTTP
 * responses are plain HTML, so tests decode here to reconstruct the exact bytes
 * the adapter would receive off the wire. Hand-authored fixtures are stored as
 * plain HTML; the leading-quote check distinguishes the two.
 */
export function loadFixture(name: string): string {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
  if (raw.startsWith('"')) {
    return JSON.parse(raw) as string;
  }
  return raw;
}
