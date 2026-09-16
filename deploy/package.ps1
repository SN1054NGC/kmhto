# Build an archive for upload: dist/kmhto-deploy-<date>.zip
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\package.ps1
# ASCII only: Windows PowerShell reads .ps1 as ANSI unless a BOM is present.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $outDir | Out-Null

$stage = Join-Path $env:TEMP ('kmhto_stage_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $stage | Out-Null

Copy-Item (Join-Path $root 'app_kmhto.html') $stage
Copy-Item (Join-Path $root 'app.js') $stage
Copy-Item (Join-Path $root 'vendor') (Join-Path $stage 'vendor') -Recurse
Copy-Item (Join-Path $root 'README.md') $stage
Copy-Item (Join-Path $root 'TZ.md') $stage
Copy-Item (Join-Path $root 'server') (Join-Path $stage 'server') -Recurse
Copy-Item (Join-Path $root 'deploy') (Join-Path $stage 'deploy') -Recurse
Remove-Item (Join-Path $stage 'deploy\package.ps1') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage 'server\node_modules') -Recurse -Force -ErrorAction SilentlyContinue

$zip = Join-Path $outDir ('kmhto-deploy-' + (Get-Date -Format 'yyyyMMdd_HHmm') + '.zip')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Remove-Item $stage -Recurse -Force
Write-Output ('done: ' + $zip)
