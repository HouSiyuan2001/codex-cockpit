import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGE_JSON = resolve(ROOT, "package.json");
const PACKAGE_LOCK = resolve(ROOT, "package-lock.json");
const CARGO_TOML = resolve(ROOT, "src-tauri", "Cargo.toml");
const CARGO_LOCK = resolve(ROOT, "src-tauri", "Cargo.lock");
const TAURI_CONFIG = resolve(ROOT, "src-tauri", "tauri.conf.json");
const CHANGELOG = resolve(ROOT, "docs", "CHANGELOG.md");

function run(name, args, { capture = false } = {}) {
  const windowsNpm = process.platform === "win32" && name === "npm";
  const command = windowsNpm ? process.env.ComSpec || "cmd.exe" : name;
  const commandArgs = windowsNpm ? ["/d", "/s", "/c", "npm", ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${name} ${args.join(" ")} failed with exit code ${result.status}.${detail}`);
  }
  return capture ? result.stdout.trim() : "";
}

export function nextVersion(current, spec) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(current);
  if (!match) throw new Error(`Current version is not supported semver: ${current}`);
  const [, majorText, minorText, patchText] = match;
  let major = Number(majorText);
  let minor = Number(minorText);
  let patch = Number(patchText);
  const betaNumber = match[4] ? Number(match[4]) : null;
  const compare = (target) => {
    const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(target);
    if (!parsed) throw new Error("Version must be patch, minor, major, beta, stable, or x.y.z[-beta.n].");
    for (let index = 1; index <= 3; index += 1) {
      const delta = Number(parsed[index]) - Number(match[index]);
      if (delta !== 0) return delta;
    }
    if (!match[4] && parsed[4]) return -1;
    if (match[4] && !parsed[4]) return 1;
    return Number(parsed[4] ?? 0) - Number(match[4] ?? 0);
  };
  if (/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(spec)) {
    if (compare(spec) <= 0) throw new Error(`Target version ${spec} must be newer than ${current}.`);
    return spec;
  }
  if (spec === "beta") {
    return betaNumber === null ? `${major}.${minor}.${patch + 1}-beta.1` : `${major}.${minor}.${patch}-beta.${betaNumber + 1}`;
  }
  if (spec === "stable") {
    if (betaNumber === null) throw new Error("The current version is already stable.");
    return `${major}.${minor}.${patch}`;
  }
  if (spec === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (spec === "minor") {
    minor += 1;
    patch = 0;
  } else if (spec === "patch") {
    patch += 1;
  } else {
    throw new Error("Version must be patch, minor, major, beta, stable, or an explicit x.y.z[-beta.n] value.");
  }
  return `${major}.${minor}.${patch}`;
}

export function updateCargoManifest(raw, version) {
  const packageStart = raw.indexOf("[package]");
  if (packageStart < 0) throw new Error("Cargo.toml is missing [package].");
  const nextSection = raw.indexOf("\n[", packageStart + 1);
  const end = nextSection < 0 ? raw.length : nextSection;
  const packageSection = raw.slice(packageStart, end);
  if (!/^version\s*=\s*"[^"]+"/m.test(packageSection)) {
    throw new Error("Cargo.toml [package] is missing version.");
  }
  return `${raw.slice(0, packageStart)}${packageSection.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`)}${raw.slice(end)}`;
}

export function buildChangelog(existing, version, commits, date) {
  const bullets = commits.length > 0 ? commits.map((subject) => `- ${subject}`).join("\n") : "- Maintenance release.";
  const section = `## ${version} - ${date}\n\n${bullets}\n`;
  const normalized = existing.trim();
  if (!normalized) return `# Changelog\n\n${section}\n`;
  if (normalized.startsWith("# Changelog")) {
    return `# Changelog\n\n${section}\n${normalized.slice("# Changelog".length).trimStart()}\n`;
  }
  return `# Changelog\n\n${section}\n${normalized}\n`;
}

function cargoVersion(raw) {
  const packageStart = raw.indexOf("[package]");
  const nextSection = raw.indexOf("\n[", packageStart + 1);
  const section = raw.slice(packageStart, nextSection < 0 ? raw.length : nextSection);
  return /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
}

function cargoLockVersion(raw) {
  const match = /\[\[package\]\]\s+name = "quota-float"\s+version = "([^"]+)"/m.exec(raw);
  return match?.[1] ?? null;
}

export function assertVersionSync(versions, tag = null) {
  const values = Object.values(versions);
  const expected = values[0];
  const mismatches = Object.entries(versions).filter(([, value]) => value !== expected);
  if (!expected || mismatches.length > 0) {
    throw new Error(`Version mismatch: ${Object.entries(versions).map(([name, value]) => `${name}=${value ?? "missing"}`).join(", ")}`);
  }
  if (tag && tag !== `v${expected}`) {
    throw new Error(`Tag ${tag} does not match synchronized version v${expected}.`);
  }
  return expected;
}

function readVersionState() {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const packageLock = JSON.parse(readFileSync(PACKAGE_LOCK, "utf8"));
  const cargoToml = readFileSync(CARGO_TOML, "utf8");
  const cargoLock = readFileSync(CARGO_LOCK, "utf8");
  const tauriConfig = JSON.parse(readFileSync(TAURI_CONFIG, "utf8"));
  return {
    packageJson: packageJson.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.[""]?.version,
    cargoToml: cargoVersion(cargoToml),
    cargoLock: cargoLockVersion(cargoLock),
    tauriConfig: tauriConfig.version,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function synchronizeVersion(version) {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  packageJson.version = version;
  writeJson(PACKAGE_JSON, packageJson);

  const packageLock = JSON.parse(readFileSync(PACKAGE_LOCK, "utf8"));
  packageLock.version = version;
  if (!packageLock.packages?.[""]) throw new Error("package-lock.json is missing the root package entry.");
  packageLock.packages[""].version = version;
  writeJson(PACKAGE_LOCK, packageLock);

  writeFileSync(CARGO_TOML, updateCargoManifest(readFileSync(CARGO_TOML, "utf8"), version), "utf8");

  const tauriConfig = JSON.parse(readFileSync(TAURI_CONFIG, "utf8"));
  tauriConfig.version = version;
  writeJson(TAURI_CONFIG, tauriConfig);
}

async function confirmRelease(message) {
  if (!process.stdin.isTTY) throw new Error("Interactive confirmation requires a terminal. Pass --yes to confirm explicitly.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(`${message} [y/N] `);
  terminal.close();
  return /^y(es)?$/i.test(answer.trim());
}

function optionValue(args, name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const version = assertVersionSync(readVersionState(), optionValue(args, "--tag"));
    console.log(`Version files are synchronized at ${version}.`);
    return;
  }

  const spec = args.find((arg) => !arg.startsWith("--"));
  if (!spec) throw new Error("Usage: npm run release -- patch|minor|major|beta|stable|x.y.z[-beta.n] [--dry-run] [--no-push] [--yes]");
  const dryRun = args.includes("--dry-run");
  const noPush = args.includes("--no-push");
  const assumeYes = args.includes("--yes");
  const current = assertVersionSync(readVersionState());
  const target = nextVersion(current, spec);
  if (target === current) throw new Error(`Target version ${target} is already current.`);

  const branch = run("git", ["branch", "--show-current"], { capture: true });
  if (branch !== "main") throw new Error(`Releases must be prepared from main, not ${branch || "detached HEAD"}.`);
  if (run("git", ["status", "--porcelain"], { capture: true })) {
    throw new Error("The worktree must be clean before release preparation.");
  }
  if (run("git", ["tag", "--list", `v${target}`], { capture: true })) {
    throw new Error(`Tag v${target} already exists.`);
  }

  run("git", ["fetch", "origin", "main"]);
  const behind = Number(run("git", ["rev-list", "--count", "HEAD..origin/main"], { capture: true }));
  if (behind > 0) throw new Error(`Local main is ${behind} commit(s) behind origin/main.`);

  const latestTag = run("git", ["describe", "--tags", "--abbrev=0"], { capture: true });
  const commits = run("git", ["log", `${latestTag}..HEAD`, "--pretty=%s"], { capture: true })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (commits.length === 0) throw new Error(`No commits exist after ${latestTag}.`);

  console.log(`Preparing Quota Float ${current} -> ${target}`);
  console.log(`Changes since ${latestTag}:\n${commits.map((subject) => `  - ${subject}`).join("\n")}`);
  if (!dryRun && !assumeYes && !(await confirmRelease(`Run release verification and ${noPush ? "create a local release" : `publish v${target}`}?`))) {
    console.log("Release cancelled without modifying files.");
    return;
  }

  run("npm", ["test"]);
  run("npm", ["run", "build"]);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]);
  if (dryRun) {
    console.log(`Dry run complete. v${target} is ready to prepare.`);
    return;
  }

  synchronizeVersion(target);
  const existingChangelog = (() => {
    try {
      return readFileSync(CHANGELOG, "utf8");
    } catch {
      return "";
    }
  })();
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(CHANGELOG, buildChangelog(existingChangelog, target, commits, date), "utf8");
  run("cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"]);
  assertVersionSync(readVersionState());
  run("git", ["diff", "--check"]);
  run("git", ["add", "package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "docs/CHANGELOG.md"]);
  run("git", ["commit", "-m", `release: v${target}`]);
  run("git", ["tag", "-a", `v${target}`, "-m", `Quota Float v${target}`]);

  if (noPush) {
    console.log(`Created local release commit and tag v${target}. Push when ready.`);
    return;
  }
  run("git", ["push", "origin", "main"]);
  run("git", ["push", "origin", `v${target}`]);
  console.log(`Published v${target}. GitHub Actions will verify and build the beta desktop packages.`);
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Release failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
