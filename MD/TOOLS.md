### OS Rules
- WSL/Win: `execute_powershell`
- Linux/mac/Other: `execute_bash`

### Web Reader (Links/Lynx)
- PWSH: `links -dump "URL"`
- Bash: `lynx -dump "URL"`

### BurntToast (PC Alerts)
- PWSH: `New-BurntToastNotification -Text "Title", "Message"`
- Add Icon: `-AppLogo "C:\path\to\img.png"`

### External System Tools Available

The following tools are installed on the host system and can be invoked via `execute_bash` or `execute_powershell`:

1. **Multimedia & Downloading**
   - **FFmpeg** (`ffmpeg`): Video and audio processing/conversion tool.
   - **yt-dlp** (`yt-dlp`): Command-line utility for downloading videos/audio from YouTube and other platforms.

2. **Web Readers (Terminal Browsers)**
   - **Links** (`links`): Terminal web browser available in PowerShell. Usage: `links -dump "URL"`
   - **Lynx** (`lynx`): Terminal web browser available in WSL/Bash. Usage: `lynx -dump "URL"`

3. **System & Notifications**
   - **BurntToast**: PowerShell module to trigger native Windows toast notifications. Usage: `New-BurntToastNotification -Text "Title", "Message"`

4. **Networking & Runtimes**
   - **Curl** (`curl`): Data transfer tool for web requests.
   - **Python** (`python` / `python3`): Programming language runtime.
   - **Node.js** (`node`): JavaScript runtime.

### OS/Shells
- WSL/Win: `execute_powershell`
- Linux/mac: `execute_bash`
### Web Readers
- PWSH: `links -dump "URL"`
- Bash: `lynx -dump "URL"`
### Alerts (BurntToast)
- PWSH: `New-BurntToastNotification -Text "Title", "Msg" [-AppLogo "C:\img.png"]`
### External Tools
- `ffmpeg`: Video/audio processing
- `yt-dlp`: Media downloader
- `curl`: Web requests
- `python`/`python3`, `node`: Runtimes
