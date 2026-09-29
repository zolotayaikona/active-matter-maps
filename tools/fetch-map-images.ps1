# Downloads the official Active Matter map images and point-of-interest photos
# from the Active Matter Wiki (Fandom) into public/maps and public/poi.
#
# The Fandom CDN (static.wikia.nocookie.net) is protected by Cloudflare and
# returns a "Just a moment..." challenge to plain HTTP clients such as
# Invoke-WebRequest / node fetch. curl.exe with browser-like headers passes,
# so we use curl here. Files are served by the CDN as WebP regardless of the
# original extension, hence the .webp names.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools/fetch-map-images.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$mapsDir = Join-Path $root "public\maps"
$poiDir = Join-Path $root "public\poi"
New-Item -ItemType Directory -Force -Path $mapsDir | Out-Null
New-Item -ItemType Directory -Force -Path $poiDir | Out-Null

$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

$cdn = "https://static.wikia.nocookie.net/active-matter/images"

$targets = @(
  @{ url = "$cdn/2/25/Damba.png/revision/latest?cb=20251225011908&path-prefix=ru"; out = (Join-Path $mapsDir "damba.webp") },
  @{ url = "$cdn/9/96/Dogorsk_map.png/revision/latest?cb=20251225221429&path-prefix=ru"; out = (Join-Path $mapsDir "dogorsk.webp") },
  @{ url = "$cdn/2/2f/Ozernoe_map.png/revision/latest?cb=20251225222207&path-prefix=ru"; out = (Join-Path $mapsDir "ozernoe.webp") },
  @{ url = "$cdn/2/20/Port_HD_map_2.jpg/revision/latest?cb=20250927175311&path-prefix=ru"; out = (Join-Path $mapsDir "port.webp") },
  @{ url = "$cdn/f/f1/Map_shcegolskoe_interactive.png/revision/latest?cb=20250923190342&path-prefix=ru"; out = (Join-Path $mapsDir "shchegolskoe.webp") },
  # additional top-down map images from the same wiki
  @{ url = "https://active-matter.fandom.com/ru/wiki/Special:Redirect/file/Dalnii_island_closed.png"; out = (Join-Path $mapsDir "dalnii.webp") },
  @{ url = "https://active-matter.fandom.com/ru/wiki/Special:Redirect/file/Ozernoe.png"; out = (Join-Path $mapsDir "ozernoe_sat.webp") },
  @{ url = "https://active-matter.fandom.com/ru/wiki/Special:Redirect/file/Dogorsk_draft_map.png"; out = (Join-Path $mapsDir "dogorsk_plan.webp") },
  @{ url = "https://active-matter.fandom.com/ru/wiki/Special:Redirect/file/Map_Schegolskoe.png"; out = (Join-Path $mapsDir "shchegolskoe_plan.webp") },
  @{ url = "https://active-matter.fandom.com/ru/wiki/Special:Redirect/file/Map_Schegolskoe_portal_9.jpg"; out = (Join-Path $poiDir "map-schegolskoe-portal-9.webp") },
  @{ url = "https://active-matter.fandom.com/ru/wiki/Special:Redirect/file/Map_Schegolskoe_exit_1.jpg"; out = (Join-Path $poiDir "map-schegolskoe-exit-1.webp") },
  @{ url = "https://active-matter.fandom.com/ru/wiki/Special:Redirect/file/Map_Schegolskoe_portal_8.jpg"; out = (Join-Path $poiDir "map-schegolskoe-portal-8.webp") }
)

foreach ($t in $targets) {
  $result = & curl.exe -sSL -o $t.out -w "%{http_code} %{content_type} %{size_download}" `
    -H "User-Agent: $ua" `
    -H "Accept: image/png,image/jpeg,image/*;q=0.8" `
    -H "Accept-Language: en-US,en;q=0.9" `
    -H "Referer: https://active-matter.fandom.com/" `
    -H "Sec-Fetch-Dest: image" -H "Sec-Fetch-Mode: no-cors" -H "Sec-Fetch-Site: cross-site" `
    $t.url
  Write-Host ("{0,-40} {1}" -f (Split-Path -Leaf $t.out), $result)
}

Write-Host "`nDone. Run 'npm run convert' to rebuild public/data/maps.json." -ForegroundColor Green
