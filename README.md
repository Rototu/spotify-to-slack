spotify-status-on-slack
===

A vibe coded Bun + TypeScript script to set Slack status to your currently playing track on Spotify.

# How to use

## 1. Set up Slack OAuth Token

This script uses Slack's OAuth 2.0 standard (legacy tokens are no longer supported).

1. Go to https://api.slack.com/apps and create a new app (or select an existing one)
2. In the left sidebar, click **"OAuth & Permissions"** (under Features)
3. Scroll to **"Scopes"** → **"User Token Scopes"** section
4. Click **"Add an OAuth Scope"** and add:
   - `users.profile:write`
   - `users.profile:read` (required so the script can detect/avoid overriding other statuses)
5. Scroll up and click **"Install App to Workspace"** (or **"Reinstall App to Workspace"** if already installed)
6. After installation, scroll down to **"OAuth Tokens for Your Workspace"**
7. Copy the **"User OAuth Token"** (starts with `xoxp-`) - NOT the Bot User OAuth Token
   - **Note:** Do NOT use App-Level Tokens - those are for different purposes

## 2. Configure the Script

- Clone this repo somewhere
- Install dependencies:

```bash
bun install
```

- Create a local config (do not commit it):

```bash
cp config.example.json config.local.json
```

- Edit `config.local.json` and set:
  - `slackToken`: your `xoxp-...` token

## 3. Set up launchd (macOS)

On macOS, use `launchd` to run the script automatically every 30 seconds.

### Install the launchd service:

```bash
# Copy the plist to LaunchAgents directory
cp com.spotify-status-on-slack.plist ~/Library/LaunchAgents/

# Load the service (starts immediately and on login)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.spotify-status-on-slack.plist
```

### Manage the service:

**Check if it's running:**
```bash
launchctl list | grep spotify-status-on-slack
```

**Stop the service:**
```bash
launchctl bootout gui/$(id -u)/com.spotify-status-on-slack
```

**Reload after making changes:**
```bash
launchctl bootout gui/$(id -u)/com.spotify-status-on-slack
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.spotify-status-on-slack.plist
```

**View logs:**
```bash
# Standard output
tail -f ~/CODE/spotify-status-on-slack/spotify-status.log

# Errors
tail -f ~/CODE/spotify-status-on-slack/spotify-status.error.log
```

### Alternative: Using crontab

If you prefer crontab instead of launchd, you can set it up like this:

```bash
* 9-18 * * 1-5 cd /path/to/spotify-status-on-slack && /opt/homebrew/bin/bun run /path/to/spotify-status-on-slack/spotify-status.ts >/dev/null 2>&1
```

However, `launchd` is recommended on macOS as it's more reliable and provides better logging.

## 4. Usage

- Listen to a song on Spotify :) You'll see that your Slack status will be updated, e.g.:

  ![Status](docs/status.png "Status")

- If someone hovers your status the track currently played by Spotify will appear on tooltip

  ![Status hover](docs/status-hover.png "Status hover")

- When you quit Spotify, stop playing tracks or simply pause playing, your current Slack status will be cleared

- The script runs every 30 seconds automatically (if using launchd)

## Status override behavior

This script is designed to be "polite" and avoid overriding important statuses set by other apps (meetings, OOO, lunch, etc).

- **If BOTH your current Slack status text and emoji are non-empty and the status was not set by this script**, the script will **not** update it.
- **If EITHER the status text OR emoji is empty**, the script will update it while Spotify is playing.
- **If the current Slack status appears to be set by this script** (headphones emoji + `Artist - Track`), the script will keep it updated while Spotify is playing.
- When the script sets the Spotify status, it also sets `status_expiration` so Slack will clear it automatically shortly after playback stops.

### Always override mode

If you want the script to always update your Slack status regardless of what's currently set, add to your `config.local.json`:

```json
"alwaysOverride": true
```

This will override any existing status (including meeting statuses, OOO, etc.) whenever Spotify is playing.

## Log retention + status expiration tuning

Tune these in `config.local.json`:

- **Logs**:
  - `logMaxLines` (default `5000`)
  - `logKeepLines` (default `3000`)
- **Auto-clear**:
  - `statusTtlSeconds` (default `120`)
- **Override protection cache** (records last protected status seen):
  - `cacheMaxAgeSeconds` (default `600`)

## Why?

I was thinking about a simple way to let your colleagues/teammates know that you're listening to some songs on (head|ear)phones, so maybe you can't hear them if they will try to call you.

Also, could be a way to let other people know your musical tastes :)

## Note

- It runs only on Mac OS X since it uses `osascript`.
- It's the result of a 30-min spike at ~10PM

Copyright 2018 Michele Pangrazzi <xmikex83@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
