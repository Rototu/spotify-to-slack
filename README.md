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
| `logMaxLines` | `5000` | Trim log when it exceeds this |
| `logKeepLines` | `3000` | Keep this many lines after trim |
| `stdoutLogPath` | `./spotify-status.log` | Log file path |
| `stderrLogPath` | `./spotify-status.error.log` | Error log file path |

## License

MIT © 2026 Emanuel Farauanu
