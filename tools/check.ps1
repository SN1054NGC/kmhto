<#
  Проверка проекта KMHTO: целостность приложения, синтаксис и все тесты.
  Запуск:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\check.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'app_kmhto.html'
$tools = Join-Path $root 'tools'

Write-Host '=== Целостность app_kmhto.html ===' -ForegroundColor Cyan
if (-not (Test-Path $app)) { Write-Host '  ФАЙЛ НЕ НАЙДЕН' -ForegroundColor Red; exit 1 }
$text = [System.IO.File]::ReadAllText($app)
$bytes = [System.IO.File]::ReadAllBytes($app)
$open = ([regex]::Matches($text, '<script')).Count
$close = ([regex]::Matches($text, '</script>')).Count
$ends = $text.TrimEnd().EndsWith('</html>')
$bareLf = 0; $crlf = 0
for ($i = 0; $i -lt $bytes.Length; $i++) {
  if ($bytes[$i] -eq 10) { if ($i -gt 0 -and $bytes[$i - 1] -eq 13) { $crlf++ } else { $bareLf++ } }
}
Write-Host ("  размер: {0} байт, строк CRLF: {1}" -f $bytes.Length, $crlf)
Write-Host ("  теги script: {0}/{1}; заканчивается </html>: {2}; одиночных LF: {3}" -f $open, $close, $ends, $bareLf)

Write-Host '=== Синтаксис JS приложения ===' -ForegroundColor Cyan
$m = [regex]::Match($text, '(?s)<script>(.*?)</script>')
$tmp = Join-Path $env:TEMP ('kmhto_check_' + [guid]::NewGuid().ToString('N') + '.js')
[System.IO.File]::WriteAllText($tmp, $m.Groups[1].Value, (New-Object System.Text.UTF8Encoding($false)))
& node --check $tmp 2>&1 | Out-String | Write-Host
$jsOk = ($LASTEXITCODE -eq 0)
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
if ($jsOk) { Write-Host '  node --check: OK' } else { Write-Host '  node --check: ОШИБКА' -ForegroundColor Red }

Write-Host '=== Синтаксис сервера ===' -ForegroundColor Cyan
$srvOk = $true; $srvCount = 0
foreach ($f in Get-ChildItem (Join-Path $root 'server') -Filter '*.js' | Sort-Object Name) {
  $srvCount++
  & node --check $f.FullName 2>&1 | Out-String | Write-Host
  if ($LASTEXITCODE -ne 0) { $srvOk = $false; Write-Host ("  {0}: ОШИБКА" -f $f.Name) -ForegroundColor Red }
}
if ($srvOk) { Write-Host ("  модулей: {0} -> OK" -f $srvCount) } else { Write-Host '  есть ошибки' -ForegroundColor Red }

Write-Host '=== Тесты ===' -ForegroundColor Cyan
$failed = 0; $passed = 0
foreach ($t in Get-ChildItem $tools -Filter 'test_*.js' | Sort-Object Name) {
  $out = & node $t.FullName 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) {
    $passed++
    $line = ($out -split '\r?\n' | Where-Object { $_ -match '^!!!' } | Select-Object -Last 1)
    Write-Host ("  OK     {0,-24} {1}" -f $t.Name, ([string]$line).Trim()) -ForegroundColor Green
  } else {
    $failed++
    Write-Host ("  ПРОВАЛ {0}" -f $t.Name) -ForegroundColor Red
    Write-Host $out
  }
}

Get-ChildItem $tools -Filter '_*.js' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($ends -and $open -eq 4 -and $close -eq 4 -and $bareLf -eq 0 -and $jsOk -and $srvOk -and $failed -eq 0) {
  Write-Host ("ВСЁ В ПОРЯДКЕ: файл цел, тестов пройдено {0}" -f $passed) -ForegroundColor Green
  exit 0
}
Write-Host 'ЕСТЬ ПРОБЛЕМЫ — см. вывод выше' -ForegroundColor Red
exit 1
