# Set up links so .claude/commands and .claude/skills are available in each IDE.
# Run from repository root. See SKILL.md (factory-engineering skill) for full workflow.
#
# Usage:
#   .\Setup-Symlinks.ps1 -Detect
#   .\Setup-Symlinks.ps1 -Ide "cursor,windsurf,kilocode,antigravity"
#   .\Setup-Symlinks.ps1 -Type all -Ide cursor
#   .\Setup-Symlinks.ps1 -Ide cursor -CopyExisting
#   .\Setup-Symlinks.ps1 -RepoRoot C:\path\to\repo -Ide cursor
#   .\Setup-Symlinks.ps1 -Ide "cursor,kilocode" -Plan
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$RepoRoot = (Get-Location).Path,
    [Parameter(Mandatory = $false)]
    [ValidateSet('commands', 'skills', 'all')]
    [string]$Type = 'all',
    [Parameter(Mandatory = $false)]
    [switch]$Detect,
    [Parameter(Mandatory = $false)]
    [string[]]$Ide,
    [Parameter(Mandatory = $false)]
    [switch]$CopyExisting,
    [Parameter(Mandatory = $false)]
    [switch]$Plan,
    [Parameter(Mandatory = $false)]
    [switch]$NoJunctionFallback
)

$ErrorActionPreference = 'Stop'

$canonicalCommands = '.claude/commands'
$canonicalSkills = '.claude/skills'
$targetsCommands = @{
    cursor     = '.cursor/commands'
    windsurf   = '.windsurf/workflows'
    kilocode   = '.kilocode/workflows'
    antigravity = '.agent/workflows'
}
# Cursor reads .claude/skills directly; no skills symlink for cursor
$targetsSkills = @{
    windsurf   = '.windsurf/skills'
    kilocode   = '.kilocode/skills'
    antigravity = '.agent/skills'
}

function Get-DetectedIdes {
    param([string]$root)
    $detected = @()
    if (Test-Path -LiteralPath (Join-Path $root '.cursor')) { $detected += 'cursor' }
    if (Test-Path -LiteralPath (Join-Path $root '.windsurf')) { $detected += 'windsurf' }
    if (Test-Path -LiteralPath (Join-Path $root '.kilocode')) { $detected += 'kilocode' }
    if (Test-Path -LiteralPath (Join-Path $root '.agent')) { $detected += 'antigravity' }
    return $detected
}

function New-SymlinkForTarget {
    param(
        [string]$root,
        [string]$ideName,
        [string]$targetRelativePath,
        [string]$canonicalDir,
        [bool]$copyExisting,
        [bool]$planOnly,
        [bool]$allowJunctionFallback
    )
    $targetPath = Join-Path $root $targetRelativePath
    $parentDir = Split-Path -Parent $targetPath
    $existingMsg = "Target $targetPath already exists. Use -CopyExisting to copy its contents to $canonicalDir and then create the symlink."
    $canonicalFull = Join-Path $root $canonicalDir

    if ($planOnly) {
        if (Test-Path -LiteralPath $targetPath) {
            $existing = Get-Item -LiteralPath $targetPath -Force
            $isLink = [bool]($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
            $existingType = if ($isLink) { "link ($($existing.LinkType)) -> $($existing.Target)" } elseif ($existing.PSIsContainer) { "directory" } else { "file" }
            Write-Host "[PLAN][$ideName] $targetRelativePath exists as $existingType"
        } else {
            Write-Host "[PLAN][$ideName] $targetRelativePath will be created"
        }
        Write-Host "[PLAN][$ideName] link target: $canonicalFull"
        return 0
    }

    if (Test-Path -LiteralPath $targetPath) {
        $item = Get-Item -LiteralPath $targetPath -Force
        if ([bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            $linkTarget = $item.Target
            if ($linkTarget -and ($linkTarget -match "\.claude[\\/](commands|skills)$")) {
                Write-Host "Already a symlink: $targetPath"
                return 0
            }
            Write-Error "$targetPath is a symlink but not to $canonicalDir."
        }
        if ($item.PSIsContainer) {
            if ($copyExisting) {
                Write-Host "Copying existing $targetPath into $canonicalDir ..."
                Get-ChildItem -LiteralPath $targetPath -Force | Copy-Item -Destination $canonicalFull -Recurse -Force
                Remove-Item -LiteralPath $targetPath -Recurse -Force
            } else {
                Write-Error $existingMsg
            }
        } else {
            Write-Error "Target $targetPath already exists as a file. Remove it first."
        }
    }

    if (-not (Test-Path -LiteralPath $canonicalFull)) {
        New-Item -ItemType Directory -Path $canonicalFull -Force | Out-Null
    }
    $canonicalFull = (Resolve-Path -LiteralPath $canonicalFull).Path

    if (-not (Test-Path -LiteralPath $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }

    try {
        New-Item -ItemType SymbolicLink -Path $targetPath -Target $canonicalFull -Force | Out-Null
        Write-Host "Created symbolic link: $targetPath -> $canonicalFull"
    } catch {
        if (-not $allowJunctionFallback) {
            throw
        }
        Write-Host "Symbolic link creation failed for $targetPath. Falling back to junction."
        $cmd = "mklink /J `"$targetPath`" `"$canonicalFull`""
        $null = cmd /c $cmd
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create junction: $targetPath -> $canonicalFull"
        }
        Write-Host "Created junction: $targetPath -> $canonicalFull"
    }

    $createdItem = Get-Item -LiteralPath $targetPath -Force
    Write-Host ("Verified: {0} | LinkType={1} | Target={2}" -f $targetPath, $createdItem.LinkType, $createdItem.Target)
    return 0
}

$repoFull = (Resolve-Path -LiteralPath $RepoRoot).Path
Set-Location $repoFull

if ($Detect) {
    $detected = Get-DetectedIdes -root $repoFull
    if ($detected.Count -eq 0) {
        Write-Host "No IDE directories (.cursor, .windsurf, .kilocode, .agent) found in $repoFull"
    } else {
        $detected | ForEach-Object { Write-Host $_ }
    }
    exit 0
}

if (-not $Ide) {
    Write-Error "Specify -Ide cursor,windsurf,kilocode,antigravity or run with -Detect first."
}

$ideList = @(
    $Ide |
        ForEach-Object { $_ -split '[,;\s]+' } |
        ForEach-Object { $_.Trim().ToLowerInvariant() } |
        Where-Object { $_ }
)
$validIdes = @('cursor', 'windsurf', 'kilocode', 'antigravity')
foreach ($ide in $ideList) {
    if ($ide -notin $validIdes) {
        Write-Error "Unknown IDE: $ide. Use cursor, windsurf, kilocode, antigravity."
    }
}

$exitCode = 0
foreach ($ide in $ideList) {
    try {
        if ($Type -eq 'commands' -or $Type -eq 'all') {
            $null = New-SymlinkForTarget -root $repoFull -ideName $ide -targetRelativePath $targetsCommands[$ide] -canonicalDir $canonicalCommands -copyExisting $CopyExisting.IsPresent -planOnly $Plan.IsPresent -allowJunctionFallback (-not $NoJunctionFallback.IsPresent)
        }
        if ($Type -eq 'skills' -or $Type -eq 'all') {
            $skillsTarget = $targetsSkills[$ide]
            if ($skillsTarget) {
                $null = New-SymlinkForTarget -root $repoFull -ideName $ide -targetRelativePath $skillsTarget -canonicalDir $canonicalSkills -copyExisting $CopyExisting.IsPresent -planOnly $Plan.IsPresent -allowJunctionFallback (-not $NoJunctionFallback.IsPresent)
            }
        }
    } catch {
        Write-Host $_.Exception.Message
        $exitCode = 2
        break
    }
}
exit $exitCode
