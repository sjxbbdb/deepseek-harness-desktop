# auto-update-exe.ps1 — waits for desktop app to exit, then replaces exe
$srcExe = 'C:\Users\24763\Desktop\DeepSeek\dsh-desktop\dist\win-unpacked\DeepSeek Harness.exe'
$dstExe = 'D:\DevTools\DeepSeek Harness\DeepSeek Harness.exe'
$log = 'C:\Users\24763\Desktop\DeepSeek\dsh-desktop\auto-update.log'
Set-Content -Path $log -Value ('watcher start ' + (Get-Date -Format o))
$deadline = (Get-Date).AddMinutes(10)
while ((Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) {
  if ((Get-Date) -gt $deadline) { Add-Content $log 'TIMEOUT waiting for exit'; exit 2 }
  Start-Sleep -Seconds 3
}
Add-Content $log ('app exited at ' + (Get-Date -Format o) + ', copying exe...')
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    Copy-Item -LiteralPath $srcExe -Destination $dstExe -Force -ErrorAction Stop
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 5
  }
}
if ($ok) { Add-Content $log 'EXE UPDATED OK' } else { Add-Content $log ('COPY FAILED: ' + $_.Exception.Message) }
