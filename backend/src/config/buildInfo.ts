import { execSync } from "node:child_process";

export interface BuildInfo {
  appVersion: string | null;
  gitSha: string | null;
  gitBranch: string | null;
  renderServiceName: string | null;
  nodeEnv: string | null;
  startedAt: string;
}

function cleanEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function tryReadGitValue(command: string): string | null {
  try {
    const value = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();

    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function shortSha(value: string | null): string | null {
  if (!value) return null;
  return value.length > 12 ? value.slice(0, 12) : value;
}

const fullGitSha =
  cleanEnvValue(process.env.RENDER_GIT_COMMIT) ??
  cleanEnvValue(process.env.VERCEL_GIT_COMMIT_SHA) ??
  cleanEnvValue(process.env.GIT_COMMIT) ??
  cleanEnvValue(process.env.COMMIT_SHA) ??
  tryReadGitValue("git rev-parse HEAD");

const buildInfo: BuildInfo = {
  appVersion: cleanEnvValue(process.env.npm_package_version),
  gitSha: shortSha(fullGitSha),
  gitBranch:
    cleanEnvValue(process.env.RENDER_GIT_BRANCH) ??
    cleanEnvValue(process.env.VERCEL_GIT_COMMIT_REF) ??
    cleanEnvValue(process.env.GIT_BRANCH) ??
    tryReadGitValue("git rev-parse --abbrev-ref HEAD"),
  renderServiceName: cleanEnvValue(process.env.RENDER_SERVICE_NAME),
  nodeEnv: cleanEnvValue(process.env.NODE_ENV),
  startedAt: new Date().toISOString(),
};

export function getBuildInfo(): BuildInfo {
  return buildInfo;
}
