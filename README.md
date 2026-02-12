# spotify-to-slack

Set your Slack status to the currently playing Spotify track. macOS only.

## Setup

1. Create a Slack app at https://api.slack.com/apps
2. Add User Token Scopes: `users.profile:write` and `users.profile:read`
3. Install to workspace and copy the User OAuth Token (`xoxp-...`)

```bash
bun install
cp config.example.json config.local.json
# Edit config.local.json and add your slackToken
```

## Run

```bash
bun run start
```

## Config UI

A lightweight Bun server serves a static UI to edit your config. It uses Basic
Auth with a single password stored in `CONFIG_UI_PASSWORD` when that value is
non-empty. If `CONFIG_UI_PASSWORD` is explicitly set to an empty string, auth
is disabled.

### Quick start

Build and serve the UI in one command:

```bash
CONFIG_UI_PASSWORD=your-password bun serve
```

### Dev mode

Watches for file changes and auto-rebuilds with hot reload:

```bash
CONFIG_UI_PASSWORD=your-password bun dev
```

By default the server runs on port `3999`. Optional environment variables:

- `CONFIG_UI_PORT`: override port
- `CONFIG_UI_PUBLIC_DIR`: override static directory (default `dist`)
- `CONFIG_PATH`: override config file path
- `CONFIG_UI_PASSWORD`: Basic Auth password (set to empty string to disable auth)

See `package.json` for additional scripts (e.g. `ui:build`, `ui:watch`, `ui:serve`).

## Local-only runtime

This project is intentionally local-only. The updater script reads config from
`config.local.json` (or the fallback path under `~/.config`) and runs on your
machine where Spotify is available.

For automatic execution, use the included `com.spotify-status-on-slack.plist` with launchd:

```bash
cp com.spotify-status-on-slack.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.spotify-status-on-slack.plist
```

## Config

| Variable | Default | Description |
|----------|---------|-------------|
| `slackToken` | — | **Required.** Your Slack User OAuth Token (`xoxp-...`) |
| `statusTtlSeconds` | `120` | Status auto-expires after this many seconds |
| `statusEmoji` | `:headphones:` | Slack emoji code for status |
| `statusEmojiUnicode` | `🎧` | Unicode version (for detection) |
| `alwaysOverride` | `false` | Override existing status even if set by another app |
| `requireTwoEmptyReadsBeforeOverride` | `true` | Require two empty reads before overriding |
| `emptyReadConfirmWindowSeconds` | `600` | Time window for double empty checks |
| `cacheMaxAgeSeconds` | `600` | Cache lifetime in seconds |
| `logMaxLines` | `5000` | Trim log when it exceeds this |
| `logKeepLines` | `3000` | Keep this many lines after trim |
| `stdoutLogPath` | `./spotify-status.log` | Log file path |
| `stderrLogPath` | `./spotify-status.error.log` | Error log file path |

## License

MIT © 2026 Emanuel Farauanu

Inspired by [work](https://github.com/mpangrazzi/spotify-status-on-slack) done by [mpangrazzi](https://github.com/mpangrazzi)
