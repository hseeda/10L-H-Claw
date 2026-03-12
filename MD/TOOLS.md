### OS Rules
- WSL/Win: `execute_powershell`
- Linux/mac/Other: `execute_bash`

### Web Reader (Links/Lynx)
- PWSH: `links -dump "URL"`
- Bash: `lynx -dump "URL"`

### BurntToast (PC Alerts)
- PWSH: `New-BurntToastNotification -Text "Title", "Message"`
- Add Icon: `-AppLogo "C:\path\to\img.png"`
