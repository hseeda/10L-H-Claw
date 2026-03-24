## Tool Usage Guide

- On Windows or WSL-hosted environments, prefer `execute_powershell`.
- On Linux or macOS, prefer `execute_bash`.
- For web page text, use terminal readers:
  - PowerShell: `links -dump "URL"`
  - Bash: `lynx -dump "URL"`
- For local notifications on Windows, use:
  - `New-BurntToastNotification -Text "Title", "Message"`
  - optional icon: `-AppLogo "C:\path\to\img.png"`

## Notable Host Tools

- `curl` for web requests
- `python` / `python3` and `node` for scripting
- `yt-dlp` for media downloading
- `ffmpeg` for audio or video conversion when needed

## Weather

- Prefer Open-Meteo over `wttr.in`.
- Use coordinates and request current weather with `curl`.
- Return temperature, wind speed, wind direction, condition, and timestamp.
