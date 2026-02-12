import chalk from "chalk";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";
import { type Config, DEFAULT_CONFIG } from "./config-schema";
import {
  getConfigSearchPaths,
  readConfigFile,
  resolveConfigPath,
} from "./config";

const executeFileAsync = promisify(execFile);

// Profanity filter setup
const profanityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});
const textCensor = new TextCensor();

function censorText(text: string): string {
  const matches = profanityMatcher.getAllMatches(text);
  if (matches.length === 0) return text;
  return textCensor.applyTo(text, matches);
}

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

const cacheSchema: z.ZodType<Cache> = z
  .object({
    updatedAt: z.number().finite().min(0),
    lastNonEmptyNonOwned: z
      .object({
        text: z.string(),
        emoji: z.string(),
        expiration: z.number().finite().min(0),
        observedAt: z.number().finite().min(0),
      })
      .optional(),
    emptyRead: z
      .object({
        lastSeenAt: z.number().finite().min(0),
        consecutiveCount: z.number().int().min(0),
      })
      .optional(),
    lastSetByScript: z
      .object({
        text: z.string(),
        emoji: z.string(),
        expiration: z.number().finite().min(0),
        setAt: z.number().finite().min(0),
      })
      .optional(),
  })
  .passthrough();

const SCRIPT_VERSION = "ts-bun-v1";

function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000);
}

function timestampIso() {
  return new Date().toISOString();
}

function redactSlackToken(value: string) {
  return value.replace(/xox[pbar]-[A-Za-z0-9-]+/g, "xox*-REDACTED");
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function log(
  level: LogLevel,
  message: string,
  metadata?: Record<string, unknown>
) {
  const prefix =
    level === "DEBUG"
      ? chalk.gray(level)
      : level === "INFO"
      ? chalk.cyan(level)
      : level === "WARN"
      ? chalk.yellow(level)
      : chalk.red(level);

  const line = `${chalk.gray(timestampIso())} ${prefix} ${message}`;
  if (metadata && Object.keys(metadata).length > 0) {
    // Avoid dumping secrets.
    const sanitized = JSON.stringify(metadata, (_key, value) =>
      typeof value === "string" ? redactSlackToken(value) : value
    );
    console.log(`${line} ${chalk.gray(sanitized)}`);
  } else {
    console.log(line);
  }
}

async function loadConfiguration(
  repositoryDirectory: string
): Promise<{ config: Config; path: string }> {
  const configPath = resolveConfigPath(
    repositoryDirectory,
    Bun.env.CONFIG_PATH ?? process.env.CONFIG_PATH
  );
  if (!existsSync(configPath)) {
    const paths = getConfigSearchPaths(repositoryDirectory);
    throw new Error(
      `No config found. Create ${paths[0]} (recommended) or ${paths[1]}. See README.`
    );
  }
  const config = await readConfigFile(configPath);
  return { config, path: configPath };
}

function getCacheFilePath(repositoryDirectory: string) {
  return path.join(repositoryDirectory, ".slack_status_cache.json");
}

function parseCache(cachePayload: unknown): Cache {
  const parsed = cacheSchema.safeParse(cachePayload);
  if (!parsed.success) {
    throw new Error("Cache file is corrupted or invalid.");
  }
  return parsed.data;
}

async function loadCache(repositoryDirectory: string): Promise<Cache> {
  const filePath = getCacheFilePath(repositoryDirectory);
  try {
    if (!existsSync(filePath)) {
      return { updatedAt: currentTimestampSeconds() };
    }
    const rawCacheContent = await readFile(filePath, "utf8");
    return parseCache(JSON.parse(rawCacheContent));
  } catch (error) {
    log("WARN", "Cache read failed; starting fresh.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { updatedAt: currentTimestampSeconds() };
  }
}

async function saveCache(repositoryDirectory: string, cache: Cache) {
  const filePath = getCacheFilePath(repositoryDirectory);
  cache.updatedAt = currentTimestampSeconds();
  await writeFile(filePath, JSON.stringify(cache, null, 2), "utf8");
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
  } catch (error) {
    log("WARN", "Log trimming failed (non-fatal)", {
      filePath,
      error: String(error),
    });
  }
}

async function osascript(script: string): Promise<string> {
  const { stdout } = await executeFileAsync(
    "/usr/bin/osascript",
    ["-e", script],
    {
      timeout: 10_000,
    }
  );
  return stdout.trim();
}

async function isSpotifyRunning(): Promise<boolean> {
  try {
    await executeFileAsync("/usr/bin/pgrep", ["Spotify"], { timeout: 3_000 });
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

async function callSlackApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseText = await response.text();
  try {
    return JSON.parse(responseText) as T;
  } catch (error) {
    throw new Error(
      `Slack API ${method} returned non-JSON: ${String(
        error
      )} body=${responseText.slice(0, 500)}`
    );
  }
}

async function getSlackProfileWithRetry(token: string) {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await callSlackApi<SlackProfileGetResponse>(
        token,
        "users.profile.get"
      );
      return response;
    } catch (error) {
      lastError = error;
      log("WARN", "Slack profile.get failed, retrying", {
        attempt,
        error: String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function normalizeEmoji(emoji: string | undefined) {
  return (emoji ?? "").trim();
}

function normalizeText(text: string | undefined) {
  return (text ?? "").trim();
}

function isStatusOwnedByScript(
  text: string,
  emoji: string,
  config: StatusEmojiConfig
) {
  const normalizedEmoji = normalizeEmoji(emoji);
  if (
    normalizedEmoji === config.statusEmoji ||
    normalizedEmoji === config.statusEmojiUnicode
  ) {
    if (text === "" || text.includes(" - ")) return true;
  }
  return false;
}

type StatusEmojiConfig = {
  statusEmoji: string;
  statusEmojiUnicode: string;
};

type RuntimeConfig = StatusEmojiConfig & {
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

function isEmptySlackStatus(text: string, emoji: string) {
  return normalizeText(text) === "" && normalizeEmoji(emoji) === "";
}

function isSafeToOverrideWhenPlayingTrack(
  statusText: string,
  statusEmoji: string
) {
  // User rule: If either the status text OR status emoji is empty, it is safe to update
  // and we should not skip.
  return statusText === "" || statusEmoji === "";
}

async function main() {
  const repositoryDirectory = process.cwd();
  const { config, path: configPath } =
    await loadConfiguration(repositoryDirectory);

  const runtimeConfig: RuntimeConfig = {
    statusEmoji: config.statusEmoji ?? DEFAULT_CONFIG.statusEmoji,
    statusEmojiUnicode:
      config.statusEmojiUnicode ?? DEFAULT_CONFIG.statusEmojiUnicode,
    statusTtlSeconds:
      config.statusTtlSeconds ?? DEFAULT_CONFIG.statusTtlSeconds,
    alwaysOverride: config.alwaysOverride ?? DEFAULT_CONFIG.alwaysOverride,
    logMaxLines: config.logMaxLines ?? DEFAULT_CONFIG.logMaxLines,
    logKeepLines: config.logKeepLines ?? DEFAULT_CONFIG.logKeepLines,
    stdoutLogPath:
      config.stdoutLogPath ??
      path.join(repositoryDirectory, "spotify-status.log"),
    stderrLogPath:
      config.stderrLogPath ??
      path.join(repositoryDirectory, "spotify-status.error.log"),
    cacheMaxAgeSeconds:
      config.cacheMaxAgeSeconds ?? DEFAULT_CONFIG.cacheMaxAgeSeconds,
    requireTwoEmptyReadsBeforeOverride:
      config.requireTwoEmptyReadsBeforeOverride ??
      DEFAULT_CONFIG.requireTwoEmptyReadsBeforeOverride,
    emptyReadConfirmWindowSeconds:
      config.emptyReadConfirmWindowSeconds ??
      DEFAULT_CONFIG.emptyReadConfirmWindowSeconds,
  };

  await trimLogFile(
    runtimeConfig.stdoutLogPath,
    runtimeConfig.logMaxLines,
    runtimeConfig.logKeepLines
  );
  await trimLogFile(
    runtimeConfig.stderrLogPath,
    runtimeConfig.logMaxLines,
    runtimeConfig.logKeepLines
  );

  log("INFO", chalk.bold("spotify-status-on-slack"), {
    version: SCRIPT_VERSION,
    pid: process.pid,
    cwd: repositoryDirectory,
    configPath,
  });

  const cache = await loadCache(repositoryDirectory);

  const spotifyRunning = await isSpotifyRunning();
  log("DEBUG", "Spotify running check", { running: spotifyRunning });
  if (!spotifyRunning) {
    log("INFO", "Spotify is not running; exiting (no status change).");
    return;
  }

  const playerState = await getSpotifyState();
  log("INFO", "Spotify player state", { state: playerState });

  // Always read Slack status first to decide if we can touch it.
  const profileResponse = await getSlackProfileWithRetry(config.slackToken);
  if (!profileResponse.ok) {
    log(
      "WARN",
      "Slack users.profile.get returned ok=false; skipping to avoid overrides",
      {
        error: profileResponse.error,
      }
    );
    return;
  }

  const statusText = normalizeText(profileResponse.profile?.status_text);
  const statusEmoji = normalizeEmoji(profileResponse.profile?.status_emoji);
  const statusExpiration = profileResponse.profile?.status_expiration ?? 0;

  const isOwnedByScript = isStatusOwnedByScript(
    statusText,
    statusEmoji,
    runtimeConfig
  );
  const isStatusEmpty = isEmptySlackStatus(statusText, statusEmoji);
  const isSafeToOverride =
    isSafeToOverrideWhenPlayingTrack(statusText, statusEmoji) ||
    isOwnedByScript;

  log("INFO", "Slack current status snapshot", {
    statusText,
    statusEmoji,
    statusExpiration,
    ownedByScript: isOwnedByScript,
    empty: isStatusEmpty,
    safeToOverrideWhenPlaying: isSafeToOverride,
  });

  // Cache only "protected" statuses: those that are clearly not ours (not owned) and fully set (both text + emoji).
  if (!isOwnedByScript && statusText !== "" && statusEmoji !== "") {
    cache.lastNonEmptyNonOwned = {
      text: statusText,
      emoji: statusEmoji,
      expiration: statusExpiration,
      observedAt: currentTimestampSeconds(),
    };
  }
  await saveCache(repositoryDirectory, cache);

  if (playerState !== "playing") {
    log(
      "INFO",
      "Spotify not playing; exiting (status will expire if previously set)."
    );
    return;
  }

  // Guard: only override when it is safe (either field empty) OR the status is owned by this script.
  // If BOTH fields are non-empty and it's not owned, do not override (unless alwaysOverride is enabled).
  if (!isSafeToOverride && !runtimeConfig.alwaysOverride) {
    log(
      "WARN",
      "Skipping update because Slack status appears set by another app/user (both text and emoji are non-empty)."
    );
    return;
  }

  const rawTrackName = await getSpotifyTrack();
  const censoredTrackName = censorText(rawTrackName);
  const expirationEpoch =
    currentTimestampSeconds() + runtimeConfig.statusTtlSeconds;
  log("INFO", "Updating Slack status to current track", {
    rawTrack: rawTrackName,
    track: censoredTrackName,
    censored: rawTrackName !== censoredTrackName,
    expirationEpoch,
  });

  const setResponse = await callSlackApi<{ ok: boolean; error?: string }>(
    config.slackToken,
    "users.profile.set",
    {
      profile: {
        status_text: censoredTrackName,
        status_emoji: runtimeConfig.statusEmoji,
        status_expiration: expirationEpoch,
      },
    }
  );

  if (!setResponse.ok) {
    log("ERROR", "Slack users.profile.set failed", {
      error: setResponse.error,
    });
    return;
  }

  cache.lastSetByScript = {
    text: censoredTrackName,
    emoji: runtimeConfig.statusEmoji,
    expiration: expirationEpoch,
    setAt: currentTimestampSeconds(),
  };
  await saveCache(repositoryDirectory, cache);
  log("INFO", chalk.green("Done"));
}

main().catch(async (e) => {
  log("ERROR", "Fatal error", {
    error: String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
  process.exitCode = 1;
});
