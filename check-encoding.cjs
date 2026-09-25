// Fails if any tracked text file has been through a lossy character-set round
// trip. Catches the class of bug where UTF-8 is decoded as Windows-1252 and
// re-encoded, which silently turns "°C" into "Â°C" and friends.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs",
  ".json", ".html", ".css", ".md", ".sql", ".yml", ".yaml", ".env", ".txt",
]);

// U+FFFD, and CP1252-mojibake lead bytes followed by a char that only appears
// when UTF-8 bytes are misread as Windows-1252.
const PATTERNS = [
  { name: "U+FFFD replacement character", re: /\uFFFD/g },
  { name: "UTF-8 read as CP1252 (A-circumflex)", re: /\u00C2[\u00A0-\u00FF\u0080-\u009F]/g },
  { name: "UTF-8 read as CP1252 (A-tilde)", re: /\u00C3[\u00A0-\u00FF\u0080-\u009F]/g },
  { name: "UTF-8 read as CP1252 (a-circumflex)", re: /\u00E2[\u20AC\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u2020\u2022\u2026\u2030\u2039\u02DC]/g },
  { name: "UTF-8 read as Latin-1 (C-circumflex)", re: /\u00C7[\u00A0-\u00FF]/g },
];

function trackedFiles() {
  let out = "";
  try {
    out = execSync("git ls-files -z", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    console.error("check-encoding: could not run `git ls-files`; run this inside the repo.");
    process.exit(2);
  }
  return out.split("\0").filter(Boolean);
}

const findings = [];
let scanned = 0;

for (const rel of trackedFiles()) {
  if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
  let buf;
  try {
    buf = fs.readFileSync(rel);
  } catch {
    continue;
  }
  scanned++;

  // A real mojibake source file is not valid UTF-8, but many tools still emit
  // valid UTF-8 of the wrong characters -- so decode strictly and report either
  // way rather than guessing.
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    findings.push({ file: rel, line: 0, what: "not valid UTF-8" });
    continue;
  }

  const lines = text.split("\n");
  for (const { name, re } of PATTERNS) {
    const rx = new RegExp(re.source, "g");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(rx);
      if (m) {
        for (const hit of m) {
          const cp = [...hit]
            .map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"))
            .join("+");
          findings.push({ file: rel, line: i + 1, what: name + " (" + cp + ")" });
        }
      }
    }
  }
}

if (findings.length === 0) {
  console.log("check-encoding: OK - " + scanned + " text files clean");
  process.exit(0);
}

console.error("check-encoding: " + findings.length + " encoding problem(s) found\n");
for (const f of findings) {
  console.error("  " + f.file + ":" + f.line + "  " + f.what);
}
console.error(
  "\nThese are almost always a UTF-8 file decoded as Windows-1252 and written\n" +
  "back as UTF-8 (PowerShell 5.1 Get-Content/Set-Content, or Out-File without\n" +
  "-Encoding utf8). Fix by editing the file with a UTF-8 aware tool."
);
process.exit(1);
