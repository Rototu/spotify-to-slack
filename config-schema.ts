import { z, type ZodError } from "zod";

export type Config = {
  slackToken: string;
  pollIntervalSeconds?: number;
  statusEmoji?: string;
  statusEmojiUnicode?: string;
  statusTtlSeconds?: number;
  alwaysOverride?: boolean;
  requireTwoEmptyReadsBeforeOverride?: boolean;
  emptyReadConfirmWindowSeconds?: number;
  cacheMaxAgeSeconds?: number;
  logMaxLines?: number;
  logKeepLines?: number;
  stdoutLogPath?: string;
  stderrLogPath?: string;
};

const trimmedString = z.string().trim();

const nonEmptyString = trimmedString.min(1, {
  message: "Must be a non-empty string.",
});

const optionalTrimmedString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().optional());

const nonNegativeNumber = z.number().finite().min(0, {
  message: "Must be a non-negative number.",
});

export const configSchema: z.ZodType<Config> = z
  .object({
    slackToken: nonEmptyString,
    pollIntervalSeconds: nonNegativeNumber.optional(),
    statusEmoji: optionalTrimmedString,
    statusEmojiUnicode: optionalTrimmedString,
    statusTtlSeconds: nonNegativeNumber.optional(),
    alwaysOverride: z.boolean().optional(),
    requireTwoEmptyReadsBeforeOverride: z.boolean().optional(),
    emptyReadConfirmWindowSeconds: nonNegativeNumber.optional(),
    cacheMaxAgeSeconds: nonNegativeNumber.optional(),
    logMaxLines: nonNegativeNumber.optional(),
    logKeepLines: nonNegativeNumber.optional(),
    stdoutLogPath: optionalTrimmedString,
    stderrLogPath: optionalTrimmedString,
  })
  .strict();

export const DEFAULT_CONFIG = {
  statusEmoji: ":headphones:",
  statusEmojiUnicode: "\u{1F3A7}",
  statusTtlSeconds: 120,
  alwaysOverride: false,
  requireTwoEmptyReadsBeforeOverride: true,
  emptyReadConfirmWindowSeconds: 600,
  cacheMaxAgeSeconds: 600,
  logMaxLines: 5000,
  logKeepLines: 3000,
  stdoutLogPath: "./spotify-status.log",
  stderrLogPath: "./spotify-status.error.log",
} satisfies Partial<Config>;

type DefaultedKeys = keyof typeof DEFAULT_CONFIG;

export type ConfigDraft = Partial<Config> & {
  slackToken?: string;
};

export type ConfigWithDefaults = Config & Required<Pick<Config, DefaultedKeys>>;

export function applyDefaults(config: ConfigDraft): ConfigWithDefaults {
  return {
    slackToken: config.slackToken ?? "",
    pollIntervalSeconds: config.pollIntervalSeconds,
    statusEmoji: config.statusEmoji ?? DEFAULT_CONFIG.statusEmoji,
    statusEmojiUnicode:
      config.statusEmojiUnicode ?? DEFAULT_CONFIG.statusEmojiUnicode,
    statusTtlSeconds:
      config.statusTtlSeconds ?? DEFAULT_CONFIG.statusTtlSeconds,
    alwaysOverride: config.alwaysOverride ?? DEFAULT_CONFIG.alwaysOverride,
    requireTwoEmptyReadsBeforeOverride:
      config.requireTwoEmptyReadsBeforeOverride ??
      DEFAULT_CONFIG.requireTwoEmptyReadsBeforeOverride,
    emptyReadConfirmWindowSeconds:
      config.emptyReadConfirmWindowSeconds ??
      DEFAULT_CONFIG.emptyReadConfirmWindowSeconds,
    cacheMaxAgeSeconds:
      config.cacheMaxAgeSeconds ?? DEFAULT_CONFIG.cacheMaxAgeSeconds,
    logMaxLines: config.logMaxLines ?? DEFAULT_CONFIG.logMaxLines,
    logKeepLines: config.logKeepLines ?? DEFAULT_CONFIG.logKeepLines,
    stdoutLogPath: config.stdoutLogPath ?? DEFAULT_CONFIG.stdoutLogPath,
    stderrLogPath: config.stderrLogPath ?? DEFAULT_CONFIG.stderrLogPath,
  };
}

function formatZodError(error: ZodError): string {
  return error.errors
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseConfig(payload: unknown): Config {
  const parsed = configSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error));
  }
  return parsed.data;
}
