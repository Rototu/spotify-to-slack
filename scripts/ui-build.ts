import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";

const repositoryDirectory = process.cwd();
const uiDirectory = path.join(repositoryDirectory, "ui");
const distDirectory = path.join(repositoryDirectory, "dist");
const entryFilePath = path.join(uiDirectory, "app.ts");
const isWatchMode = process.argv.includes("--watch");

const staticAssets = ["index.html", "styles.css"];

async function copyStaticAssets() {
  await mkdir(distDirectory, { recursive: true });
  await Promise.all(
    staticAssets.map((file) =>
      copyFile(path.join(uiDirectory, file), path.join(distDirectory, file))
    )
  );
}

async function buildUiOnce() {
  await mkdir(distDirectory, { recursive: true });
  const buildResult = await Bun.build({
    entrypoints: [entryFilePath],
    outdir: distDirectory,
    target: "browser",
    format: "esm",
    splitting: false,
    sourcemap: isWatchMode ? "inline" : "none",
    minify: !isWatchMode,
  });

  if (!buildResult.success) {
    for (const buildLog of buildResult.logs) {
      console.error(buildLog);
    }
    throw new Error("UI build failed.");
  }

  await copyStaticAssets();
}

async function watchUi() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleBuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      buildUiOnce().catch((error) => console.error(error));
    }, 120);
  };

  await buildUiOnce();
  console.log("Watching ui/ for changes...");

  const watcher = watch(uiDirectory, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (!/\.(ts|css|html)$/.test(filename)) return;
    scheduleBuild();
  });

  process.on("SIGINT", () => watcher.close());
}

if (isWatchMode) {
  watchUi().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  buildUiOnce().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
