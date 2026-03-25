# H-ClaW Tools
### OS & Shell
- Win/WSL: `execute_powershell` | Linux/mac: `execute_bash`
- Web Reader: PWSH `links -dump "URL"` | Bash `lynx -dump "URL"`
- Alerts (Win): `New-BurntToastNotification -Text "Title", "Msg" [-AppLogo "path"]`
### External (via Bash/PWSH)
- `ffmpeg`: Media processing | `yt-dlp`: Media downloader
- `curl`/`wget`: Network requests | `pdftotext`: PDF to text
- `python3`, `node`, `git`: Runtimes/Dev
- **Weather**: `curl "https://api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}&current_weather=true"` (Open-Meteo)
Always be concise in responses. Do not suggest further actions after the main response if not heartbeat.