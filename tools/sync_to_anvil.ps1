<#
.SYNOPSIS
  Sync the canonical public/ frontend into the anvil-app checkout.

.DESCRIPTION
  Transitional tooling for the Anvil decommission (see MIGRATION_PLAN.md).

  public/ is now the single source of truth for the frontend. Anvil remains
  production until Phase 4, and Anvil serves a FLAT asset directory
  (theme/assets/) rather than the nested public/assets/{js,css,...} layout, so
  the two cannot simply be the same directory. This script flattens public/
  into the shapes Anvil expects:

      public/assets/**/<file>      -> anvil-app/theme/assets/<file>
      public/standard-page.html    -> anvil-app/theme/assets/standard-page.html
      public/index.html            -> anvil-app/client_code/FrontEnd/form_template.html
      serviceworker.py             -> anvil-app/server_code/serviceworker.py

  Run this before every Anvil deploy while the migration is in flight. After
  Phase 4 removes anvil-app, delete this script.

  Note: module URLs inside the sources still point at /_/theme/. That is
  deliberate -- the rewrite to /assets/js/ lands with the Cloudflare Pages
  cutover in Phase 3, at which point Anvil is on its way out anyway.

.PARAMETER Check
  Report what would change and exit non-zero if anything is out of sync.
  Does not write. Intended for CI or a pre-deploy sanity check.
#>
[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'anvil-app\theme\assets'
$formTemplate = Join-Path $root 'anvil-app\client_code\FrontEnd\form_template.html'
$serverSw = Join-Path $root 'anvil-app\server_code\serviceworker.py'

foreach ($required in @($assets, (Split-Path $formTemplate), (Split-Path $serverSw))) {
    if (-not (Test-Path $required)) {
        throw "anvil-app checkout is incomplete -- missing: $required"
    }
}

# Compare on normalised content so CRLF/LF differences between the Windows
# working tree and the Anvil checkout are not reported as drift.
function Test-SameContent {
    param([string]$Source, [string]$Target)
    if (-not (Test-Path $Target)) { return $false }
    $isText = [IO.Path]::GetExtension($Source) -in @('.js', '.css', '.html', '.py', '.txt', '.svg')
    if (-not $isText) {
        return (Get-FileHash $Source).Hash -eq (Get-FileHash $Target).Hash
    }
    $a = ([IO.File]::ReadAllText($Source) -replace "`r`n", "`n").TrimEnd()
    $b = ([IO.File]::ReadAllText($Target) -replace "`r`n", "`n").TrimEnd()
    return $a -eq $b
}

$pairs = [System.Collections.Generic.List[object]]::new()

# Every asset under public/assets/** flattens into theme/assets/
Get-ChildItem (Join-Path $root 'public\assets') -Recurse -File | ForEach-Object {
    $pairs.Add([pscustomobject]@{ Source = $_.FullName; Target = Join-Path $assets $_.Name })
}
$pairs.Add([pscustomobject]@{
    Source = Join-Path $root 'public\standard-page.html'
    Target = Join-Path $assets 'standard-page.html'
})
$pairs.Add([pscustomobject]@{
    Source = Join-Path $root 'public\index.html'
    Target = $formTemplate
})
$pairs.Add([pscustomobject]@{
    Source = Join-Path $root 'serviceworker.py'
    Target = $serverSw
})

# Guard against two public/ files flattening onto the same Anvil filename.
$collisions = $pairs | Group-Object Target | Where-Object { $_.Count -gt 1 }
if ($collisions) {
    foreach ($c in $collisions) {
        Write-Host "COLLISION -> $($c.Name)" -ForegroundColor Red
        $c.Group | ForEach-Object { Write-Host "    from: $($_.Source)" }
    }
    throw 'Two or more public/ files flatten to the same anvil-app target.'
}

$drift = @()
foreach ($p in $pairs) {
    if (-not (Test-SameContent -Source $p.Source -Target $p.Target)) {
        $drift += $p
    }
}

if ($Check) {
    if ($drift) {
        Write-Host "Out of sync ($($drift.Count) of $($pairs.Count)):" -ForegroundColor Yellow
        $drift | ForEach-Object { Write-Host "  $($_.Source.Replace("$root\", ''))" }
        exit 1
    }
    Write-Host "anvil-app is in sync with public/ ($($pairs.Count) files)." -ForegroundColor Green
    exit 0
}

foreach ($p in $drift) {
    Copy-Item -LiteralPath $p.Source -Destination $p.Target -Force
    Write-Host "  synced: $($p.Source.Replace("$root\", ''))"
}

if ($drift) {
    Write-Host "Synced $($drift.Count) file(s) into anvil-app." -ForegroundColor Green
    Write-Host "Commit and push anvil-app separately -- it is its own git remote." -ForegroundColor DarkGray
} else {
    Write-Host "Already in sync ($($pairs.Count) files)." -ForegroundColor Green
}
