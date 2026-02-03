import chalk from "chalk";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Config = {
  slackToken: string;
  pollIntervalSeconds?: number; // informational; launchd controls interval
  statusEmoji?: string; // default ":headphones:"
  statusEmojiUnicode?: string; // default "🎧"
  statusTtlSeconds?: number; // default 120
  alwaysOverride?: boolean; // default false
  requireTwoEmptyReadsBeforeOverride?: boolean; // default true
  emptyReadConfirmWindowSeconds?: number; // default 600
  cacheMaxAgeSeconds?: number; // default 600
  logMaxLines?: number; // default 5000
  logKeepLines?: number; // default 3000
  stdoutLogPath?: string; // default ./spotify-status.log
  stderrLogPath?: string; // default ./spotify-status.error.log
};

type SlackProfile = {
  status_text?: string;
  status_emoji?: string;
  status_expiration?: number;
};

type SlackProfileGetResponse = {
  ok: boolean;
  error?: string;
  profile?: SlackProfile;
};

type Cache = {
  updatedAt: number; // epoch seconds
  lastNonEmptyNonOwned?: {
    text: string;
    emoji: string;
    expiration: number;
    observedAt: number;
  };
  emptyRead?: {
    lastSeenAt: number;
    consecutiveCount: number;
  };
  lastSetByScript?: {
    text: string;
    emoji: string;
    expiration: number;
    setAt: number;
  };
};

const SCRIPT_VERSION = "ts-bun-v1";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function ts() {
  return new Date().toISOString();
}

function redactToken(s: string) {
  return s.replace(/xox[pbar]-[A-Za-z0-9-]+/g, "xox*-REDACTED");
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
  const prefix =
    level === "DEBUG"
      ? chalk.gray(level)
      : level === "INFO"
      ? chalk.cyan(level)
      : level === "WARN"
      ? chalk.yellow(level)
      : chalk.red(level);

  const line = `${chalk.gray(ts())} ${prefix} ${msg}`;
  if (meta && Object.keys(meta).length > 0) {
    // Avoid dumping secrets.
    const sanitized = JSON.stringify(meta, (_k, v) =>
      typeof v === "string" ? redactToken(v) : v
    );
    console.log(`${line} ${chalk.gray(sanitized)}`);
  } else {
    console.log(line);
  }
}

function configSearchPaths(repoDir: string) {
  const home = os.homedir();
  return [
    path.join(repoDir, "config.local.json"),
    path.join(home, ".config", "spotify-status-on-slack", "config.json"),
  ];
}

async function readJsonFile<T>(p: string): Promise<T> {
  const raw = await readFile(p, "utf8");
  return JSON.parse(raw) as T;
}

async function loadConfig(
  repoDir: string
): Promise<{ config: Config; path: string }> {
  const paths = configSearchPaths(repoDir);
  for (const p of paths) {
    if (existsSync(p)) {
      const config = await readJsonFile<Config>(p);
      if (!config.slackToken || typeof config.slackToken !== "string") {
        throw new Error(`Config at ${p} must include a 'slackToken' string.`);
      }
      return { config, path: p };
    }
  }
  throw new Error(
    `No config found. Create ${paths[0]} (recommended) or ${paths[1]}. See README.`
  );
}

function cachePath(repoDir: string) {
  return path.join(repoDir, ".slack_status_cache.json");
}

async function loadCache(repoDir: string): Promise<Cache> {
  const p = cachePath(repoDir);
  try {
    if (!existsSync(p)) return { updatedAt: nowSec() };
    const c = await readJsonFile<Cache>(p);
    return c && typeof c === "object" ? c : { updatedAt: nowSec() };
  } catch {
    return { updatedAt: nowSec() };
  }
}

async function saveCache(repoDir: string, c: Cache) {
  const p = cachePath(repoDir);
  c.updatedAt = nowSec();
  await writeFile(p, JSON.stringify(c, null, 2), "utf8");
}

async function trimLogFile(
  filePath: string,
  maxLines: number,
  keepLines: number
) {
  try {
    if (!existsSync(filePath)) return;
    const contents = await readFile(filePath, "utf8");
    const lines = contents.split("\n");
    // If file ends with newline, split gives trailing empty.
    const lineCount =
      lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    if (lineCount <= maxLines) return;

    const tail =
      lines.slice(Math.max(0, lineCount - keepLines), lineCount).join("\n") +
      "\n";
    await writeFile(filePath, tail, "utf8");
  } catch (e) {
    log("WARN", "Log trimming failed (non-fatal)", {
      filePath,
      error: String(e),
    });
  }
}

async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
    timeout: 10_000,
  });
  return stdout.trim();
}

async function isSpotifyRunning(): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/pgrep", ["Spotify"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function getSpotifyState(): Promise<
  "playing" | "paused" | "stopped" | "unknown"
> {
  try {
    const state = await osascript('tell application "Spotify" to player state');
    if (state === "playing" || state === "paused" || state === "stopped")
      return state;
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function getSpotifyTrack(): Promise<string> {
  const song = await osascript(
    'tell application "Spotify" to artist of current track & " - " & name of current track'
  );
  return song;
}

async function slackApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(
      `Slack API ${method} returned non-JSON: ${String(e)} body=${text.slice(
        0,
        500
      )}`
    );
  }
}

async function slackProfileGetWithRetry(token: string) {
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await slackApi<SlackProfileGetResponse>(
        token,
        "users.profile.get"
      );
      return resp;
    } catch (e) {
      lastErr = e;
      log("WARN", "Slack profile.get failed, retrying", {
        attempt: i,
        error: String(e),
      });
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function normalizeEmoji(emoji: string | undefined) {
  return (emoji ?? "").trim();
}

function normalizeText(text: string | undefined) {
  return (text ?? "").trim();
}

function isScriptOwnedStatus(text: string, emoji: string, cfg: RequiredPick) {
  const e = normalizeEmoji(emoji);
  if (e === cfg.statusEmoji || e === cfg.statusEmojiUnicode) {
    if (text === "" || text.includes(" - ")) return true;
  }
  return false;
}

type RequiredPick = {
  statusEmoji: string;
  statusEmojiUnicode: string;
};

type RuntimeCfg = RequiredPick & {
  statusTtlSeconds: number;
  alwaysOverride: boolean;
  logMaxLines: number;
  logKeepLines: number;
  stdoutLogPath: string;
  stderrLogPath: string;
  cacheMaxAgeSeconds: number;
  requireTwoEmptyReadsBeforeOverride: boolean;
  emptyReadConfirmWindowSeconds: number;
};

function isEmptyStatus(text: string, emoji: string) {
  return normalizeText(text) === "" && normalizeEmoji(emoji) === "";
}

function isSafeToOverrideWhenPlaying(statusText: string, statusEmoji: string) {
  // User rule: If either the status text OR status emoji is empty, it is safe to update
  // and we should not skip.
  return statusText === "" || statusEmoji === "";
}

async function main() {
  const repoDir = process.cwd();
  const { config, path: configPath } = await loadConfig(repoDir);

  const cfg: RuntimeCfg = {
    statusEmoji: config.statusEmoji ?? ":headphones:",
    statusEmojiUnicode: config.statusEmojiUnicode ?? "🎧",
    statusTtlSeconds: config.statusTtlSeconds ?? 120,
    alwaysOverride: config.alwaysOverride ?? false,
    logMaxLines: config.logMaxLines ?? 5000,
    logKeepLines: config.logKeepLines ?? 3000,
    stdoutLogPath:
      config.stdoutLogPath ?? path.join(repoDir, "spotify-status.log"),
    stderrLogPath:
      config.stderrLogPath ?? path.join(repoDir, "spotify-status.error.log"),
    cacheMaxAgeSeconds: config.cacheMaxAgeSeconds ?? 600,
    requireTwoEmptyReadsBeforeOverride:
      config.requireTwoEmptyReadsBeforeOverride ?? true,
    emptyReadConfirmWindowSeconds: config.emptyReadConfirmWindowSeconds ?? 600,
  };

  await trimLogFile(cfg.stdoutLogPath, cfg.logMaxLines, cfg.logKeepLines);
  await trimLogFile(cfg.stderrLogPath, cfg.logMaxLines, cfg.logKeepLines);

  log("INFO", chalk.bold("spotify-status-on-slack"), {
    version: SCRIPT_VERSION,
    pid: process.pid,
    cwd: repoDir,
    configPath,
  });

  const cache = await loadCache(repoDir);

  const running = await isSpotifyRunning();
  log("DEBUG", "Spotify running check", { running });
  if (!running) {
    log("INFO", "Spotify is not running; exiting (no status change).");
    return;
  }

  const state = await getSpotifyState();
  log("INFO", "Spotify player state", { state });

  // Always read Slack status first to decide if we can touch it.
  const prof = await slackProfileGetWithRetry(config.slackToken);
  if (!prof.ok) {
    log(
      "WARN",
      "Slack users.profile.get returned ok=false; skipping to avoid overrides",
      {
        error: prof.error,
      }
    );
    return;
  }

  const statusText = normalizeText(prof.profile?.status_text);
  const statusEmoji = normalizeEmoji(prof.profile?.status_emoji);
  const statusExp = prof.profile?.status_expiration ?? 0;

  const owned = isScriptOwnedStatus(statusText, statusEmoji, cfg);
  const empty = isEmptyStatus(statusText, statusEmoji);
  const safeToOverride =
    isSafeToOverrideWhenPlaying(statusText, statusEmoji) || owned;

  log("INFO", "Slack current status snapshot", {
    statusText,
    statusEmoji,
    statusExpiration: statusExp,
    ownedByScript: owned,
    empty,
    safeToOverrideWhenPlaying: safeToOverride,
  });

  // Cache only "protected" statuses: those that are clearly not ours (not owned) and fully set (both text + emoji).
  if (!owned && statusText !== "" && statusEmoji !== "") {
    cache.lastNonEmptyNonOwned = {
      text: statusText,
      emoji: statusEmoji,
      expiration: statusExp,
      observedAt: nowSec(),
    };
  }
  await saveCache(repoDir, cache);

  if (state !== "playing") {
    log(
      "INFO",
      "Spotify not playing; exiting (status will expire if previously set)."
    );
    return;
  }

  // Guard: only override when it is safe (either field empty) OR the status is owned by this script.
  // If BOTH fields are non-empty and it's not owned, do not override (unless alwaysOverride is enabled).
  if (!safeToOverride && !cfg.alwaysOverride) {
    log(
      "WARN",
      "Skipping update because Slack status appears set by another app/user (both text and emoji are non-empty)."
    );
    return;
  }

  const track = await getSpotifyTrack();
  const exp = nowSec() + cfg.statusTtlSeconds;
  log("INFO", "Updating Slack status to current track", {
    track,
    expirationEpoch: exp,
  });

  const setResp = await slackApi<{ ok: boolean; error?: string }>(
    config.slackToken,
    "users.profile.set",
    {
      profile: {
        status_text: track,
        status_emoji: cfg.statusEmoji,
        status_expiration: exp,
      },
    }
  );

  if (!setResp.ok) {
    log("ERROR", "Slack users.profile.set failed", { error: setResp.error });
    return;
  }

  cache.lastSetByScript = {
    text: track,
    emoji: cfg.statusEmoji,
    expiration: exp,
    setAt: nowSec(),
  };
  await saveCache(repoDir, cache);
  log("INFO", chalk.green("Done"));
}

main().catch(async (e) => {
  log("ERROR", "Fatal error", {
    error: String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
  process.exitCode = 1;
});
