# Builds everything friends need into dist\share:
#   Underline-Chrome.zip   Chrome, Edge, Brave, Opera, Vivaldi, Arc (any Chromium browser)
#   Underline-Firefox.zip  Firefox (same code, Firefox-style manifest)
#   Underline.exe          Windows app: Ctrl+Shift+U in any app
# All three include config.js, so share them privately.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$share = Join-Path $root "dist\share"
New-Item -ItemType Directory -Force $share | Out-Null

if (-not (Test-Path (Join-Path $root "config.js"))) { throw "config.js not found. Copy config.example.js to config.js and fill it in first." }

$extensionFiles = "background.js", "config.js", "editor.js", "newtab.html", "newtab.css", "newtab.js",
  "options.html", "options.css", "options.js", "theme.css", "theme.js"

function New-ExtensionZip($name, $manifestJson) {
  $stage = Join-Path ([IO.Path]::GetTempPath()) ("underline-" + [guid]::NewGuid())
  New-Item -ItemType Directory $stage | Out-Null
  try {
    foreach ($f in $extensionFiles) { Copy-Item (Join-Path $root $f) (Join-Path $stage $f) }
    # Write without a BOM; some browsers reject a manifest that starts with one
    [IO.File]::WriteAllText((Join-Path $stage "manifest.json"), $manifestJson, (New-Object Text.UTF8Encoding $false))
    $paths = Get-ChildItem -LiteralPath $stage | ForEach-Object { $_.FullName }
    Compress-Archive -LiteralPath $paths -DestinationPath (Join-Path $share $name) -Force
  }
  finally {
    Get-ChildItem -LiteralPath $stage | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    Remove-Item -LiteralPath $stage -Force
  }
  Write-Host "Built $name"
}

$manifestText = Get-Content -Raw (Join-Path $root "manifest.json")

# Chromium browsers use manifest.json as it is
New-ExtensionZip "Underline-Chrome.zip" $manifestText

# Firefox: background scripts instead of a service worker, plus an add-on id
$firefox = $manifestText | ConvertFrom-Json
$firefox.background = [ordered]@{ scripts = @("config.js", "editor.js", "background.js") }
$firefox | Add-Member -NotePropertyName browser_specific_settings -NotePropertyValue ([ordered]@{
  gecko = [ordered]@{
    id = "underline@dhivya1109.github.io"
    strict_min_version = "142.0"
    data_collection_permissions = [ordered]@{
      required = @("websiteContent", "browsingActivity", "personallyIdentifyingInfo")
    }
  }
})
New-ExtensionZip "Underline-Firefox.zip" ($firefox | ConvertTo-Json -Depth 10)

# Windows app
& (Join-Path $root "desktop\build.ps1")
Copy-Item (Join-Path $root "desktop\build\Underline.exe") (Join-Path $share "Underline.exe") -Force
Write-Host "Copied Underline.exe"
