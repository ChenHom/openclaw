import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: process.cwd() });
  return stdout;
}

export async function loadProgress(progressFile: string): Promise<string[]> {
  try {
    const data = await fs.readFile(progressFile, "utf-8");
    return (JSON.parse(data) as { completed: string[] }).completed || [];
  } catch {
    return [];
  }
}

export async function saveProgress(progressFile: string, completedFile: string) {
  let completed: string[] = [];
  try {
    const data = await fs.readFile(progressFile, "utf-8");
    completed = (JSON.parse(data) as { completed: string[] }).completed || [];
  } catch {}

  if (!completed.includes(completedFile)) {
    completed.push(completedFile);
    await fs.writeFile(progressFile, JSON.stringify({ completed }, null, 2));
  }
}

export async function getPendingFiles(options: {
  docsDir: string;
  isForce: boolean;
  completedFiles: string[];
}): Promise<string[]> {
  const { docsDir, isForce, completedFiles } = options;
  const list: string[] = [];

  if (!isForce) {
    try {
      const remotesRaw = await runGit(["remote"]);
      const remotes = remotesRaw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const hasUpstream = remotes.includes("upstream");
      const compareTarget = hasUpstream ? "upstream/main...HEAD" : "origin/main...HEAD";
      const changedRaw = await runGit(["diff", "--name-only", compareTarget, "--", docsDir]);
      const changedFiles = changedRaw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const file of changedFiles) {
        if (/\.mdx?$/.test(file) && !file.includes("zh-TW")) {
          if (!completedFiles.includes(file)) {
            list.push(file);
          }
        }
      }
    } catch {}
  }

  if (list.length === 0 || isForce) {
    async function scan(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(process.cwd(), fullPath);
        if (entry.isDirectory()) {
          if (![
            "zh-TW",
            "zh-CN",
            "ja-JP",
            ".i18n",
            "assets",
            "images",
          ].includes(entry.name)) {
            await scan(fullPath);
          }
        } else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
          if (isForce) {
            if (!completedFiles.includes(relPath)) {
              list.push(relPath);
            }
          } else {
            const target = relPath.replace(/^docs\//, "docs/zh-TW/");
            try {
              await fs.access(target);
            } catch {
              list.push(relPath);
            }
          }
        }
      }
    }
    await scan(docsDir);
  }

  return Array.from(new Set(list));
}
