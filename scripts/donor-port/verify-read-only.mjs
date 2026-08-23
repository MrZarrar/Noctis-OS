import { execFileSync } from "node:child_process";
import path from "node:path";

function normalizeWindowsPath(value) {
  return path.win32.resolve(value).replace(/[\\/]+$/, "");
}

export function assertSafeRepositoryBoundary(targetPath, donorPath) {
  const target = normalizeWindowsPath(targetPath);
  const donor = normalizeWindowsPath(donorPath);
  const targetKey = target.toLocaleLowerCase("en-US");
  const donorKey = donor.toLocaleLowerCase("en-US");

  if (targetKey === donorKey || targetKey.startsWith(`${donorKey}\\`)) {
    throw new Error("Noctis target must be a sibling of the donor repository.");
  }

  const targetParent = path.win32.dirname(target).toLocaleLowerCase("en-US");
  const donorParent = path.win32.dirname(donor).toLocaleLowerCase("en-US");
  if (targetParent !== donorParent) {
    throw new Error("Noctis target and donor must use the same parent directory.");
  }

  return { target, donor };
}

function git(repository, ...args) {
  return execFileSync("git", ["-c", `safe.directory=${repository}`, "-C", repository, ...args], {
    encoding: "utf8",
    windowsHide: true,
  })
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

export function captureGitSnapshot(repositoryPath) {
  const repository = path.win32.resolve(repositoryPath);

  return {
    repository,
    head: git(repository, "rev-parse", "HEAD"),
    branch: git(repository, "branch", "--show-current"),
    status: git(repository, "status", "--short"),
  };
}
