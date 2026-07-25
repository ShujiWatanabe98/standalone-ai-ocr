$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$output = Join-Path $repo 'dist'
$stage = Join-Path $output 'Standalone-AI-OCR'
$zip = Join-Path $output 'Standalone-AI-OCR.zip'
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'standalone') -Destination $stage -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repo 'start-standalone-ai-ocr.ps1') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $repo 'start-standalone-ai-ocr-production.ps1') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $repo 'docs\standalone-ai-ocr') -Destination (Join-Path $stage 'docs') -Recurse -Force
Get-ChildItem -LiteralPath $stage -Recurse -Directory -Filter data | Remove-Item -Recurse -Force
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Created: $zip"
