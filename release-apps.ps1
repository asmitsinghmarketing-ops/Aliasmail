# Release the Nextspace Android and Windows desktop apps together, then commit and push.
#
#   .\release-apps.ps1                    bump both versions, build, ask before pushing
#   .\release-apps.ps1 -Push              bump, build, commit and push without asking
#   .\release-apps.ps1 -NoPush            bump and build only
#   .\release-apps.ps1 -AndroidVersion 2.0 -DesktopVersion 1.1.0
#   .\release-apps.ps1 -SkipDesktop       (or -SkipAndroid) release just one app
#
# Stops at the first failure; the release scripts put their version back when a build fails,
# and nothing is committed or pushed unless every selected build succeeded.
[CmdletBinding()]
param(
    [string]$AndroidVersion,
    [string]$DesktopVersion,
    [switch]$SkipAndroid,
    [switch]$SkipDesktop,
    [switch]$Push,
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
if ($Push -and $NoPush) { throw 'Use either -Push or -NoPush, not both.' }
if ($SkipAndroid -and $SkipDesktop) { throw 'Nothing to release: both apps are skipped.' }

$repoRoot = $PSScriptRoot
$gradleFile = Join-Path $repoRoot 'client\android\app\build.gradle'
$desktopPackage = Join-Path $repoRoot 'client\desktop\package.json'

function Invoke-Checked {
    param([Parameter(Mandatory)] [string]$Command, [string[]]$CommandArguments = @())
    # Windows PowerShell 5.1 turns a native tool's stderr (npm/node warnings) into a terminating
    # error under 'Stop' when output is redirected; judge success by the exit code instead.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command @CommandArguments } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$Command $($CommandArguments -join ' ') failed with exit code $LASTEXITCODE." }
}

function Invoke-Release {
    param([string]$Script, [string]$Version)
    $arguments = @('run', $Script)
    if ($Version) { $arguments += @('--', '--version', $Version) }
    Invoke-Checked -Command 'npm.cmd' -CommandArguments $arguments
}

Push-Location $repoRoot
try {
    $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
    $released = @()

    if (-not $SkipAndroid) {
        Write-Host "`n=== Android ===" -ForegroundColor Cyan
        Invoke-Release -Script 'release:android' -Version $AndroidVersion
        $name = [regex]::Match((Get-Content -Raw -LiteralPath $gradleFile), 'versionName\s+"([^"]+)"').Groups[1].Value
        $released += "Android $name"
    }

    if (-not $SkipDesktop) {
        Write-Host "`n=== Desktop ===" -ForegroundColor Cyan
        Invoke-Release -Script 'release:desktop' -Version $DesktopVersion
        $version = (Get-Content -Raw -LiteralPath $desktopPackage | ConvertFrom-Json).version
        $released += "desktop $version"
    }

    $summary = $released -join ' and '
    $shouldPush = $Push
    if (-not $Push -and -not $NoPush) {
        $answer = Read-Host "Commit and push $summary to origin/$branch? [y/N]"
        $shouldPush = $answer -match '^(?i:y|yes)$'
    }

    if (-not $shouldPush) {
        Write-Host "`nBuilt $summary locally; nothing was committed or pushed." -ForegroundColor Yellow
        exit 0
    }

    # App source plus release artifacts only; server and unrelated root files stay untouched.
    $paths = @('client/src')
    if (-not $SkipAndroid) { $paths += @('client/android/app/build.gradle', 'downloads/nextspace-android.apk') }
    if (-not $SkipDesktop) { $paths += @('client/desktop/package.json', 'client/desktop/latest.json', 'client/desktop/Nextspace-Desktop-Setup.exe') }
    Invoke-Checked -Command 'git' -CommandArguments (@('add', '-A', '--') + $paths)

    & git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'No staged changes to commit.' -ForegroundColor Yellow
    } elseif ($LASTEXITCODE -eq 1) {
        Invoke-Checked -Command 'git' -CommandArguments @('commit', '-m', "Release $summary")
        Invoke-Checked -Command 'git' -CommandArguments @('push', 'origin', $branch)
        Write-Host "`nReleased and pushed $summary." -ForegroundColor Green
    } else {
        throw "git diff failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
