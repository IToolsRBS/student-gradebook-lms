# Mirror this repo to the local student_support_gradebook copy used for exports.
$ErrorActionPreference = "Stop"

$Source = Resolve-Path (Join-Path $PSScriptRoot "..")
$Dest = "C:\Users\Zaheera.Ganie\OneDrive - regent.ac.za\data warehouse\gradebook project\Student-Support-Gradebook-Report\student_support_gradebook"

if (-not (Test-Path $Dest)) {
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
}

$excludeDirs = @("node_modules", ".git", "__pycache__", "target", ".cursor", "terminals")
$excludeFiles = @("*.xlsx")

function Should-SkipPath {
    param([string]$RelativePath)
    foreach ($part in $RelativePath.Split([char[]]@('\', '/'))) {
        if ($excludeDirs -contains $part) {
            return $true
        }
    }
    foreach ($pattern in $excludeFiles) {
        if ($RelativePath -like $pattern) {
            return $true
        }
    }
    if ($RelativePath -eq ".env" -or $RelativePath -eq ".env.txt") {
        return $true
    }
    return $false
}

$copied = 0
Get-ChildItem -Path $Source -Recurse -Force -File | ForEach-Object {
    $relative = $_.FullName.Substring($Source.Path.Length).TrimStart('\')
    if (Should-SkipPath $relative) {
        return
    }
    $target = Join-Path $Dest $relative
    $parent = Split-Path $target -Parent
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Copy-Item -Path $_.FullName -Destination $target -Force
    $script:copied++
}

Write-Host "Synced $copied file(s) to student_support_gradebook."
