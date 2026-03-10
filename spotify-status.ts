import chalk from "chalk";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { z } from "zod";
import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
  type MatchPayload,
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
const WHOLE_WORD_CHARACTER_PATTERN = /[\p{L}\p{N}\p{M}]/u;

function getPreviousCodePoint(text: string, index: number) {
  return Array.from(text.slice(0, index)).at(-1) ?? "";
}

function getNextCodePoint(text: string, index: number) {
  return Array.from(text.slice(index)).at(0) ?? "";
}

function isWholeWordBoundary(character: string) {
  return character === "" || !WHOLE_WORD_CHARACTER_PATTERN.test(character);
}

function isWholeWordMatch(text: string, match: MatchPayload) {
  const characterBefore = getPreviousCodePoint(text, match.startIndex);
  const characterAfter = getNextCodePoint(text, match.endIndex + 1);

  return (
    isWholeWordBoundary(characterBefore) &&
    isWholeWordBoundary(characterAfter)
  );
}

function censorText(text: string): string {
  // Only censor standalone words so names like "Pinegrove" stay untouched.
  const matches = profanityMatcher
    .getAllMatches(text, true)
    .filter((match) => isWholeWordMatch(text, match));
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

type PlayerName = "spotify" | "ncspot";
type PlayerState = "playing" | "paused" | "stopped" | "unknown";
type PlayerSnapshot = {
  name: PlayerName;
  running: boolean;
  state: PlayerState;
  track: string | null;
  detectionError?: string;
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

const ncspotPlaybackSchema = z
  .object({
    mode: z.union([z.record(z.unknown()), z.string()]).optional(),
    playable: z
      .object({
        title: z.string().optional(),
        artists: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

const SCRIPT_VERSION = "ts-bun-v2";
const SLACK_STATUS_TEXT_MAX_LENGTH = 100;
const STATUS_TRUNCATION_SUFFIX = "...";
const PLAYER_PRIORITY: PlayerName[] = ["ncspot", "spotify"];
const DEFAULT_NCSPOT_EXECUTABLE_PATHS = [
  "/opt/homebrew/bin/ncspot",
  "/usr/local/bin/ncspot",
  "/opt/local/bin/ncspot",
];

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
  const writer =
    level === "WARN" || level === "ERROR" ? console.error : console.log;
  if (metadata && Object.keys(metadata).length > 0) {
    // Avoid dumping secrets.
    const sanitized = JSON.stringify(metadata, (_key, value) =>
      typeof value === "string" ? redactSlackToken(value) : value
    );
    writer(`${line} ${chalk.gray(sanitized)}`);
  } else {
    writer(line);
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

async function isProcessRunning(processName: string): Promise<boolean> {
  try {
    await executeFileAsync("/usr/bin/pgrep", [processName], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function isSpotifyRunning(): Promise<boolean> {
  return isProcessRunning("Spotify");
}

async function isNcspotRunning(): Promise<boolean> {
  return isProcessRunning("ncspot");
}

async function getSpotifyState(): Promise<PlayerState> {
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

function parseNcspotInfo(output: string) {
  const info: {
    userCachePath?: string;
    userRuntimePath?: string;
  } = {};

  for (const line of output.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine === "") continue;

    const separatorIndex = trimmedLine.indexOf(" ");
    if (separatorIndex < 0) continue;

    const key = trimmedLine.slice(0, separatorIndex);
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (key === "USER_CACHE_PATH" && value !== "") {
      info.userCachePath = value;
    }
    if (key === "USER_RUNTIME_PATH" && value !== "") {
      info.userRuntimePath = value;
    }
  }

  return info;
}

function getDefaultNcspotSocketPaths() {
  const userId =
    typeof process.getuid === "function" ? String(process.getuid()) : undefined;
  const candidates = [
    userId ? path.join("/tmp", `ncspot-${userId}`, "ncspot.sock") : undefined,
    path.join(os.homedir(), ".cache", "ncspot", "ncspot.sock"),
  ];

  return candidates.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate !== ""
  );
}

function resolveExecutablePath(
  executableName: string,
  configuredPath: string | undefined,
  fallbackAbsolutePaths: string[]
) {
  const pathDirectories = (Bun.env.PATH ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter((directory) => directory !== "");

  const candidates = [
    configuredPath,
    ...pathDirectories.map((directory) => path.join(directory, executableName)),
    ...fallbackAbsolutePaths,
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate !== ""
  );

  return candidates.find((candidate) => existsSync(candidate)) ?? executableName;
}

async function getNcspotSocketPaths(): Promise<string[]> {
  const defaultSocketPaths = getDefaultNcspotSocketPaths();
  const ncspotExecutablePath = resolveExecutablePath(
    "ncspot",
    Bun.env.NCSPOT_PATH ?? process.env.NCSPOT_PATH,
    DEFAULT_NCSPOT_EXECUTABLE_PATHS
  );

  try {
    const { stdout } = await executeFileAsync(ncspotExecutablePath, ["info"], {
      timeout: 3_000,
    });
    const info = parseNcspotInfo(stdout);
    const directories = [info.userRuntimePath, info.userCachePath].filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate !== ""
    );

    return Array.from(
      new Set([
        ...defaultSocketPaths,
        ...directories.map((directory) => path.join(directory, "ncspot.sock")),
      ])
    );
  } catch {
    return defaultSocketPaths;
  }
}

async function readNcspotSocketPayload(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let isSettled = false;

    const timeoutId = setTimeout(() => {
      finishWithError(
        new Error(`Timed out waiting for ncspot IPC response from ${socketPath}.`)
      );
    }, 2_000);

    function cleanup() {
      clearTimeout(timeoutId);
      if (!socket.destroyed) {
        socket.destroy();
      }
    }

    function finishWithValue(payload: string) {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      resolve(payload);
    }

    function finishWithError(error: Error) {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(error);
    }

    function tryResolveBuffer() {
      const trimmedBuffer = buffer.trim();
      if (trimmedBuffer === "") return false;

      try {
        JSON.parse(trimmedBuffer);
        finishWithValue(trimmedBuffer);
        return true;
      } catch {
        return false;
      }
    }

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      tryResolveBuffer();
    });
    socket.on("end", () => {
      if (!tryResolveBuffer()) {
        finishWithError(
          new Error(
            `ncspot IPC connection closed before a complete payload was received from ${socketPath}.`
          )
        );
      }
    });
    socket.on("error", (error) => {
      finishWithError(
        error instanceof Error ? error : new Error(String(error))
      );
    });
  });
}

function getNcspotState(
  mode: Record<string, unknown> | string | undefined
): PlayerState {
  if (!mode) return "unknown";
  if (typeof mode === "string") {
    const normalizedMode = mode.toLowerCase();
    if (normalizedMode === "playing") return "playing";
    if (normalizedMode === "paused") return "paused";
    if (normalizedMode === "stopped") return "stopped";
    return "unknown";
  }
  if (Object.hasOwn(mode, "Playing")) return "playing";
  if (Object.hasOwn(mode, "Paused")) return "paused";
  if (Object.hasOwn(mode, "Stopped")) return "stopped";
  return "unknown";
}

function formatTrackName(artists: string[] | undefined, title: string | undefined) {
  const normalizedArtists =
    artists
      ?.map((artist) => artist.trim())
      .filter((artist) => artist !== "") ?? [];
  const normalizedTitle = title?.trim() ?? "";

  if (normalizedArtists.length > 0 && normalizedTitle !== "") {
    return `${normalizedArtists.join(", ")} - ${normalizedTitle}`;
  }
  if (normalizedTitle !== "") return normalizedTitle;
  if (normalizedArtists.length > 0) return normalizedArtists.join(", ");
  return "";
}

async function getSpotifySnapshot(): Promise<PlayerSnapshot> {
  const running = await isSpotifyRunning();
  if (!running) {
    return {
      name: "spotify",
      running: false,
      state: "unknown",
      track: null,
    };
  }

  const state = await getSpotifyState();
  if (state !== "playing") {
    return {
      name: "spotify",
      running: true,
      state,
      track: null,
    };
  }

  try {
    return {
      name: "spotify",
      running: true,
      state,
      track: await getSpotifyTrack(),
    };
  } catch (error) {
    return {
      name: "spotify",
      running: true,
      state,
      track: null,
      detectionError:
        error instanceof Error ? error.message : `Failed to read track: ${String(error)}`,
    };
  }
}

async function getNcspotSnapshot(): Promise<PlayerSnapshot> {
  const running = await isNcspotRunning();
  if (!running) {
    return {
      name: "ncspot",
      running: false,
      state: "unknown",
      track: null,
    };
  }

  try {
    const socketPaths = await getNcspotSocketPaths();
    const socketPath = socketPaths.find((candidate) => existsSync(candidate));

    if (!socketPath) {
      return {
        name: "ncspot",
        running: true,
        state: "unknown",
        track: null,
        detectionError: "ncspot is running but no IPC socket was found.",
      };
    }

    const payload = await readNcspotSocketPayload(socketPath);
    const parsedPayload = ncspotPlaybackSchema.safeParse(JSON.parse(payload));
    if (!parsedPayload.success) {
      return {
        name: "ncspot",
        running: true,
        state: "unknown",
        track: null,
        detectionError: "ncspot IPC payload was invalid.",
      };
    }

    return {
      name: "ncspot",
      running: true,
      state: getNcspotState(parsedPayload.data.mode),
      track: formatTrackName(
        parsedPayload.data.playable?.artists,
        parsedPayload.data.playable?.title
      ),
    };
  } catch (error) {
    return {
      name: "ncspot",
      running: true,
      state: "unknown",
      track: null,
      detectionError:
        error instanceof Error
          ? error.message
          : `Failed to query ncspot: ${String(error)}`,
    };
  }
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

function truncateForSlackStatusText(text: string) {
  const normalizedText = normalizeText(text);
  const characters = Array.from(normalizedText);

  if (characters.length <= SLACK_STATUS_TEXT_MAX_LENGTH) {
    return normalizedText;
  }

  const prefixLength = Math.max(
    0,
    SLACK_STATUS_TEXT_MAX_LENGTH - STATUS_TRUNCATION_SUFFIX.length
  );
  return (
    characters.slice(0, prefixLength).join("") + STATUS_TRUNCATION_SUFFIX
  );
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

function comparePlayerSnapshots(a: PlayerSnapshot, b: PlayerSnapshot) {
  const runningDifference = Number(b.running) - Number(a.running);
  if (runningDifference !== 0) return runningDifference;

  const stateOrder: Record<PlayerState, number> = {
    playing: 0,
    paused: 1,
    stopped: 2,
    unknown: 3,
  };
  const stateDifference = stateOrder[a.state] - stateOrder[b.state];
  if (stateDifference !== 0) return stateDifference;

  return PLAYER_PRIORITY.indexOf(a.name) - PLAYER_PRIORITY.indexOf(b.name);
}

function getPlayerDisplayName(playerName: PlayerName) {
  return playerName === "spotify" ? "Spotify" : "ncspot";
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

  const playerSnapshots = await Promise.all([
    getSpotifySnapshot(),
    getNcspotSnapshot(),
  ]);
  for (const snapshot of playerSnapshots) {
    log("DEBUG", "Player detection snapshot", {
      player: snapshot.name,
      running: snapshot.running,
      state: snapshot.state,
      hasTrack: snapshot.track !== null && snapshot.track !== "",
      error: snapshot.detectionError,
    });
  }

  const selectedPlayer = [...playerSnapshots].sort(comparePlayerSnapshots)[0];
  if (!selectedPlayer || !selectedPlayer.running) {
    log("INFO", "No supported player is running; exiting (no status change).");
    return;
  }

  const activePlayers = playerSnapshots.filter(
    (snapshot) => snapshot.running && snapshot.state === "playing"
  );
  if (activePlayers.length > 1) {
    log("WARN", "Multiple supported players report active playback; using priority order.", {
      players: activePlayers.map((snapshot) => snapshot.name),
      selectedPlayer: selectedPlayer.name,
    });
  }

  const selectedPlayerLabel = getPlayerDisplayName(selectedPlayer.name);
  log("INFO", "Selected player", {
    player: selectedPlayer.name,
    state: selectedPlayer.state,
  });

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

  if (selectedPlayer.state !== "playing") {
    log(
      "INFO",
      `${selectedPlayerLabel} is not playing; exiting (status will expire if previously set).`
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

  const rawTrackName = selectedPlayer.track?.trim() ?? "";
  if (rawTrackName === "") {
    log(
      "WARN",
      `${selectedPlayerLabel} is playing but track metadata is unavailable; skipping update.`
    );
    return;
  }

  const censoredTrackName = censorText(rawTrackName);
  const truncatedTrackName = truncateForSlackStatusText(censoredTrackName);
  const censoredTrackLength = Array.from(censoredTrackName).length;
  const truncatedTrackLength = Array.from(truncatedTrackName).length;
  const expirationEpoch =
    currentTimestampSeconds() + runtimeConfig.statusTtlSeconds;
  log("INFO", "Updating Slack status to current track", {
    player: selectedPlayer.name,
    rawTrack: rawTrackName,
    track: truncatedTrackName,
    censored: rawTrackName !== censoredTrackName,
    truncated: truncatedTrackLength < censoredTrackLength,
    trackLength: truncatedTrackLength,
    expirationEpoch,
  });

  const setResponse = await callSlackApi<{ ok: boolean; error?: string }>(
    config.slackToken,
    "users.profile.set",
    {
      profile: {
        status_text: truncatedTrackName,
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
    text: truncatedTrackName,
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
