import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

it("publication audit catches removed historical credentials without printing their value", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cockpit-audit-test-"));
  const git = args => execFileSync("git", args, { cwd, stdio: "pipe" });
  const commit = message => git(["-c", "user.name=Test", "-c", "user.email=test@users.noreply.github.com", "-c", "commit.gpgsign=false", "commit", "-m", message]);
  const audit = args => spawnSync(process.execPath, [fileURLToPath(new URL("./audit-public.mjs", import.meta.url)), ...args], { cwd, encoding: "utf8" });
  const synthetic = "ghp_" + "a".repeat(30);
  try {
    git(["init"]);
    writeFileSync(join(cwd, "notes.txt"), `credential=${synthetic}\n`);
    git(["add", "notes.txt"]); commit("synthetic fixture");
    const current = audit([]);
    expect(current.status).toBe(1);
    expect(current.stderr).toContain("access token");
    expect(current.stderr).not.toContain(synthetic);
    unlinkSync(join(cwd, "notes.txt"));
    writeFileSync(join(cwd, "README.md"), "Synthetic fixture only.\n");
    git(["add", "-A"]); commit("remove fixture");
    expect(audit([]).status).toBe(0);
    const history = audit(["--history"]);
    expect(history.status).toBe(1);
    expect(history.stderr).toContain("notes.txt@");
    expect(history.stderr).not.toContain(synthetic);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
