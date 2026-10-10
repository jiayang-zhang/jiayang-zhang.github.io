// Fails if the built frontend contains secret names, secret values or
// server-only code. Run after `npm run build`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "..", "assets", "biotech");
if (!existsSync(outDir)) {
  console.error("No build output found. Run `npm run build` first.");
  process.exit(1);
}

// Identifiers that exist only in server code or secret configuration.
const needles = ["FINNHUB_API_KEY", "X-Finnhub-Token", "ANTHROPIC_API_KEY", "ACCESS_AUD", "DEV_ADMIN_EMAIL", "Cf-Access-Jwt-Assertion", "SEC_USER_AGENT", "exactly five event categories"];

// Actual secret values, when a local secrets file or environment provides them.
const devVars = join(root, "worker", ".dev.vars");
const pairs = existsSync(devVars)
  ? readFileSync(devVars, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]+)"?/)).filter(Boolean).map((m) => [m[1], m[2].trim()])
  : [];
for (const [name, value] of [...pairs, ...Object.entries(process.env)]) {
  if (/(KEY|TOKEN|SECRET)$/.test(name) && value && value.length >= 12) needles.push(value);
}

const files = readdirSync(outDir);
let bad = false;
for (const file of files) {
  if (file.endsWith(".map")) {
    console.error(`FAIL ${file}: source maps must not be published`);
    bad = true;
    continue;
  }
  const text = readFileSync(join(outDir, file), "utf8");
  for (const needle of needles) {
    if (text.includes(needle)) {
      console.error(`FAIL ${file}: contains ${needles.indexOf(needle) < 8 ? needle : "a secret value"}`);
      bad = true;
    }
  }
}
if (bad) process.exit(1);
console.log(`OK: ${files.length} bundle files checked, no secrets or server-only code found.`);
