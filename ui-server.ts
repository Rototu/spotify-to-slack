import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { z, type ZodError } from "zod";
import {
  type Config,
  type ConfigWithDefaults,
  applyDefaults,
  parseConfig,
} from "./config-schema";
import { readConfigFile, resolveConfigPath, writeConfigFile } from "./config";

const repositoryDirectory = process.cwd();
const configUiPasswordFromEnvironment =
  Bun.env.CONFIG_UI_PASSWORD ?? process.env.CONFIG_UI_PASSWORD;
const configUiPasswordIsDefined =
  Bun.env.CONFIG_UI_PASSWORD !== undefined ||
  process.env.CONFIG_UI_PASSWORD !== undefined;
if (!configUiPasswordIsDefined) {
  console.error(
    "Missing CONFIG_UI_PASSWORD. Set it to enable Basic Auth for the Config UI, or set it to an empty string to disable auth."
  );
  process.exit(1);
}
const configUiPassword = configUiPasswordFromEnvironment ?? "";
const isAuthRequired = configUiPassword.length > 0;

const serverPort = Number(
  Bun.env.CONFIG_UI_PORT ?? process.env.CONFIG_UI_PORT ?? 3999
);
const publicDirectory = path.resolve(
  repositoryDirectory,
  Bun.env.CONFIG_UI_PUBLIC_DIR ?? process.env.CONFIG_UI_PUBLIC_DIR ?? "dist"
);
const configFilePath = resolveConfigPath(
  repositoryDirectory,
  Bun.env.CONFIG_PATH ?? process.env.CONFIG_PATH
);

const uiConfigSchema = z
  .object({
    statusTtlSeconds: z.number().finite().min(0),
    alwaysOverride: z.boolean(),
    cacheMaxAgeSeconds: z.number().finite().min(0),
    emptyReadConfirmWindowSeconds: z.number().finite().min(0),
  })
  .strict();

type UiConfig = z.infer<typeof uiConfigSchema>;

const logsQuerySchema = z
  .object({
    stream: z.enum(["stdout", "stderr"]).optional().default("stdout"),
    limit: z.coerce.number().int().min(100).max(10000).optional().default(2500),
  })
  .strict();

const logsStreamQuerySchema = z
  .object({
    stream: z.enum(["stdout", "stderr"]).optional().default("stdout"),
  })
  .strict();

function formatZodError(error: ZodError) {
  return error.errors
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function selectUiConfig(config: ConfigWithDefaults): UiConfig {
  return {
    statusTtlSeconds: config.statusTtlSeconds,
    alwaysOverride: config.alwaysOverride,
    cacheMaxAgeSeconds: config.cacheMaxAgeSeconds,
    emptyReadConfirmWindowSeconds: config.emptyReadConfirmWindowSeconds,
  };
}

function unauthorizedResponse() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Spotify Status Config"',
    },
  });
}

function isAuthorizedRequest(request: Request) {
  const authorizationHeader = request.headers.get("authorization") ?? "";
  if (!authorizationHeader.startsWith("Basic ")) return false;
  const encodedToken = authorizationHeader.slice(6);
  const decodedCredentials = Buffer.from(encodedToken, "base64").toString(
    "utf8"
  );
  const separatorIndex = decodedCredentials.indexOf(":");
  const providedPassword =
    separatorIndex >= 0 ? decodedCredentials.slice(separatorIndex + 1) : "";
  const received = Buffer.from(providedPassword, "utf8");
  const expected = Buffer.from(configUiPassword, "utf8");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function loadConfigForUi(): Promise<{
  config: ConfigWithDefaults;
  exists: boolean;
  error?: string;
}> {
  if (!existsSync(configFilePath)) {
    return { config: applyDefaults({ slackToken: "" }), exists: false };
  }
  try {
    const config = await readConfigFile(configFilePath);
    return { config: applyDefaults(config), exists: true };
  } catch (error) {
    return {
      config: applyDefaults({ slackToken: "" }),
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseIncomingConfig(requestPayload: unknown) {
  return parseConfig(requestPayload);
}

async function loadConfigForUpdate(): Promise<{
  config?: Config;
  exists: boolean;
  error?: string;
}> {
  if (!existsSync(configFilePath)) {
    return { exists: false };
  }

  try {
    const config = await readConfigFile(configFilePath);
    return { config, exists: true };
  } catch (error) {
    return {
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveLogPath(logPath: string) {
  return path.isAbsolute(logPath)
    ? logPath
    : path.resolve(repositoryDirectory, logPath);
}

async function readLogTail(
  filePath: string,
  lineLimit: number
): Promise<{
  lines: string[];
  totalLines: number;
  truncated: boolean;
  missing: boolean;
}> {
  if (!existsSync(filePath)) {
    return {
      lines: [],
      totalLines: 0,
      truncated: false,
      missing: true,
    };
  }

  const rawContent = await readFile(filePath, "utf8");
  const normalizedContent = rawContent.replace(/\r\n/g, "\n");
  const allLines = normalizedContent.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  const totalLines = allLines.length;
  const lines =
    totalLines > lineLimit ? allLines.slice(totalLines - lineLimit) : allLines;

  return {
    lines,
    totalLines,
    truncated: totalLines > lines.length,
    missing: false,
  };
}

async function clearLogFile(filePath: string): Promise<{ missing: boolean }> {
  if (!existsSync(filePath)) {
    return { missing: true };
  }
  await writeFile(filePath, "", "utf8");
  return { missing: false };
}

async function handleApiRequest(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname === "/api/config" && request.method === "GET") {
    const { config, exists, error } = await loadConfigForUi();
    if (error) {
      return createJsonResponse({ ok: false, error }, 500);
    }
    return createJsonResponse({
      config,
      meta: {
        path: configFilePath,
        exists,
      },
    });
  }

  if (requestUrl.pathname === "/api/ui-config" && request.method === "GET") {
    const { config, exists, error } = await loadConfigForUi();
    if (error) {
      return createJsonResponse({ ok: false, error }, 500);
    }
    return createJsonResponse({
      config: selectUiConfig(config),
      meta: {
        path: configFilePath,
        exists,
      },
    });
  }

  if (requestUrl.pathname === "/api/config" && request.method === "PUT") {
    try {
      const requestPayload = await request.json();
      const config = parseIncomingConfig(requestPayload);
      await writeConfigFile(configFilePath, config);
      return createJsonResponse({
        ok: true,
        config: applyDefaults(config),
        meta: {
          path: configFilePath,
          exists: true,
        },
      });
    } catch (error) {
      return createJsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400
      );
    }
  }

  if (requestUrl.pathname === "/api/ui-config" && request.method === "PUT") {
    try {
      const requestPayload = await request.json();
      const parsedUiConfig = uiConfigSchema.safeParse(requestPayload);
      if (!parsedUiConfig.success) {
        return createJsonResponse(
          { ok: false, error: formatZodError(parsedUiConfig.error) },
          400
        );
      }

      const existingConfig = await loadConfigForUpdate();
      if (existingConfig.error) {
        return createJsonResponse(
          { ok: false, error: existingConfig.error },
          400
        );
      }
      if (!existingConfig.exists || !existingConfig.config) {
        return createJsonResponse(
          {
            ok: false,
            error: `Config file not found at ${configFilePath}. Create it first with a Slack token.`,
          },
          400
        );
      }

      const updatedConfig = parseConfig({
        ...existingConfig.config,
        ...parsedUiConfig.data,
      });

      await writeConfigFile(configFilePath, updatedConfig);
      return createJsonResponse({
        ok: true,
        config: selectUiConfig(applyDefaults(updatedConfig)),
        meta: {
          path: configFilePath,
          exists: true,
        },
      });
    } catch (error) {
      return createJsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400
      );
    }
  }

  if (requestUrl.pathname === "/api/logs" && request.method === "GET") {
    const parsedQuery = logsQuerySchema.safeParse(
      Object.fromEntries(requestUrl.searchParams.entries())
    );
    if (!parsedQuery.success) {
      return createJsonResponse(
        { ok: false, error: formatZodError(parsedQuery.error) },
        400
      );
    }

    const { config, error } = await loadConfigForUi();
    const stream = parsedQuery.data.stream;
    const lineLimit = parsedQuery.data.limit;
    const configuredPath =
      stream === "stdout" ? config.stdoutLogPath : config.stderrLogPath;
    const filePath = resolveLogPath(configuredPath);

    try {
      const logData = await readLogTail(filePath, lineLimit);
      return createJsonResponse({
        ok: true,
        stream,
        path: filePath,
        lines: logData.lines,
        totalLines: logData.totalLines,
        truncated: logData.truncated,
        missing: logData.missing,
        configError: error,
      });
    } catch (logReadError) {
      return createJsonResponse(
        {
          ok: false,
          error:
            logReadError instanceof Error
              ? logReadError.message
              : String(logReadError),
        },
        500
      );
    }
  }

  if (requestUrl.pathname === "/api/logs" && request.method === "DELETE") {
    const parsedQuery = logsStreamQuerySchema.safeParse(
      Object.fromEntries(requestUrl.searchParams.entries())
    );
    if (!parsedQuery.success) {
      return createJsonResponse(
        { ok: false, error: formatZodError(parsedQuery.error) },
        400
      );
    }

    const { config, error } = await loadConfigForUi();
    if (error) {
      return createJsonResponse(
        { ok: false, error: `Config error: ${error}` },
        400
      );
    }
    const stream = parsedQuery.data.stream;
    const configuredPath =
      stream === "stdout" ? config.stdoutLogPath : config.stderrLogPath;
    const filePath = resolveLogPath(configuredPath);

    try {
      const clearResult = await clearLogFile(filePath);
      return createJsonResponse({
        ok: true,
        stream,
        path: filePath,
        missing: clearResult.missing,
      });
    } catch (logClearError) {
      return createJsonResponse(
        {
          ok: false,
          error:
            logClearError instanceof Error
              ? logClearError.message
              : String(logClearError),
        },
        500
      );
    }
  }

  if (requestUrl.pathname === "/api/config" && request.method === "POST") {
    return createJsonResponse(
      { ok: false, error: "Use PUT /api/config to update the config." },
      405
    );
  }

  return new Response("Not Found", { status: 404 });
}

async function serveStaticFile(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(publicDirectory, relativePath);
  if (!filePath.startsWith(publicDirectory)) {
    return new Response("Not Found", { status: 404 });
  }
  if (existsSync(filePath)) {
    return new Response(Bun.file(filePath));
  }

  const indexPath = path.join(publicDirectory, "index.html");
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath));
  }

  return new Response("UI build not found. Run `bun run ui:build` first.", {
    status: 500,
  });
}

const server = Bun.serve({
  port: serverPort,
  fetch: async (request) => {
    if (isAuthRequired && !isAuthorizedRequest(request)) {
      return unauthorizedResponse();
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname.startsWith("/api/")) {
      return handleApiRequest(request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    return serveStaticFile(requestUrl.pathname);
  },
});

console.log(`Config UI listening on http://localhost:${server.port}`);
