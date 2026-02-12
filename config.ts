import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type Config, parseConfig } from "./config-schema";

export function getConfigSearchPaths(repositoryDirectory: string) {
  const homeDirectory = os.homedir();
  return [
    path.join(repositoryDirectory, "config.local.json"),
    path.join(
      homeDirectory,
      ".config",
      "spotify-status-on-slack",
      "config.json"
    ),
  ];
}

export function resolveConfigPath(
  repositoryDirectory: string,
  overridePath?: string
) {
  if (overridePath) return overridePath;
  const searchPaths = getConfigSearchPaths(repositoryDirectory);
  for (const candidate of searchPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return searchPaths[0];
}

export async function readConfigFile(filePath: string): Promise<Config> {
  const rawConfigContent = await readFile(filePath, "utf8");
  return parseConfig(JSON.parse(rawConfigContent));
}

export async function writeConfigFile(filePath: string, config: Config) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
}
