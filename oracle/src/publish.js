// Publish the site's data files to the `pages-data` branch, so GitHub Pages
// shows current levels, history and closes without commits to main.
//
// The branch holds one commit with data/*.json, replaced on every publish
// (force push), so the repo does not grow. Pushing pages-data triggers the
// Pages workflow, which copies data/ over docs/data before deploying.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "oracle", "state");
const WORK_DIR = path.join(ROOT, "oracle", "cache", "pages-data"); // gitignored scratch repo
const BRANCH = "pages-data";

/// state file -> published name (same mapping as scripts/build-pages.mjs)
export const dataFiles = (season) => ({
  "registry.json": "registry.json",
  [`levels-${season}.json`]: "levels.json",
  [`history-${season}.json`]: "history.json",
  [`close-${season}.json`]: "close.json",
  [`pushlog-${season}.json`]: "pushlog.json",
});

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "pipe", ...opts }).toString().trim();
const gitValue = (key) => {
  try { return run("git", ["-C", ROOT, "config", "--get", key]); } catch { return ""; }
};

export function publishPagesData(season) {
  const remote = run("git", ["-C", ROOT, "remote", "get-url", "origin"]);
  const name = gitValue("user.name") || "Courtline Oracle";
  const email = gitValue("user.email") || "oracle@courtline.local";
  const sshCommand = gitValue("core.sshCommand");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    ...(sshCommand ? { GIT_SSH_COMMAND: sshCommand } : {}),
  };
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK_DIR, "data"), { recursive: true });
  for (const [src, dst] of Object.entries(dataFiles(season))) {
    fs.copyFileSync(path.join(STATE_DIR, src), path.join(WORK_DIR, "data", dst));
  }
  const git = (...a) => run("git", ["-C", WORK_DIR, ...a], { env });
  git("init", "-q", "-b", BRANCH);
  git("add", "data");
  git("commit", "-q", "-m", `Site data ${new Date().toISOString().slice(0, 16)}Z`);
  git("push", "-q", "-f", remote, `HEAD:refs/heads/${BRANCH}`);
  return { repo: remote.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "") };
}
