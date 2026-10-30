# What this script does:
# 1. Checks for Node.js 22 or newer.
# 2. Offers to install Node.js with winget only after asking first.
# 3. Resolves the latest stable GitHub release and installs its immutable commit.
# 4. Runs oasis doctor and opens first-run provider setup.
# It does not request administrator rights, upload files, or send telemetry.
[CmdletBinding()]
param([switch]$Yes, [switch]$SkipSetup)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-resolution.ps1')
$ApiBase = 'https://api.github.com/repos/FAHTHIZ/oasis'
$ApiHeaders = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'oasis-installer' }
$ReleaseTag = ''
$Archive = ''
$ReleaseCommit = ''
$InstallPrefix = Join-Path $env:LOCALAPPDATA 'OASIS'
$OasisCommand = Join-Path $InstallPrefix 'oasis.cmd'

function Confirm-Change([string]$Question) {
    if ($Yes) { Write-Host "$Question [approved by -Yes]"; return $true }
    $answer = Read-Host "$Question [y/N]"
    if ($answer -match '^(y|yes)$') { return $true }
    Write-Host 'Nothing was changed.'
    return $false
}
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user) -join ';'
}

Write-Host 'Checking for Node.js 22 or newer...'
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeMajor = 0
if ($node) {
    try { $nodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim()) } catch { $nodeMajor = 0 }
}
if ($nodeMajor -lt 22) {
    Write-Host 'Node.js 22 or newer was not found. OASIS needs it to run.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        if (-not (Confirm-Change "May I run 'winget install OpenJS.NodeJS.LTS --exact --scope user'?")) { exit 1 }
        & winget install --id OpenJS.NodeJS.LTS --exact --scope user --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'winget could not finish a user-only installation. No administrator command was run.'
            Write-Host 'Install Node.js 22 or newer from https://nodejs.org/en/download, then run this script again.'
            exit 1
        }
        Refresh-Path
    } else {
        Write-Host 'winget was not found, so I have not installed anything.'
        Write-Host 'Install Node.js 22 or newer from https://nodejs.org/en/download, then try again.'
        exit 1
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host 'Node.js is not available in this terminal yet. Close and reopen PowerShell, then try again.'
        exit 1
    }
    try { $nodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim()) } catch { $nodeMajor = 0 }
    if ($nodeMajor -lt 22) {
        Write-Host 'The installed Node.js version is still too old. Install version 22 or newer and try again.'
        exit 1
    }
}
Write-Host ("Node.js is ready: " + (& node --version))
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host 'npm was not found. Install Node.js including npm from https://nodejs.org/en/download, then retry.'
    exit 1
}
Write-Host ("npm is ready: " + (& npm --version))
Write-Host 'Resolving the latest stable OASIS release from GitHub...'
$apiFailure = ''
try {
    $release = Invoke-RestMethod -Uri "$ApiBase/releases/latest" -Headers $ApiHeaders -TimeoutSec 15
    if ($release.draft -or $release.prerelease) { throw 'GitHub did not return a stable release.' }
    $ReleaseTag = [string]$release.tag_name
    if (-not [regex]::IsMatch($ReleaseTag, '\Av[0-9]+\.[0-9]+\.[0-9]+\z')) { throw 'The latest stable release has an unsupported tag.' }
    $encodedTag = [uri]::EscapeDataString($ReleaseTag)
    $releaseCommit = Invoke-RestMethod -Uri "$ApiBase/commits/$encodedTag" -Headers $ApiHeaders -TimeoutSec 15
    $ReleaseCommit = ([string]$releaseCommit.sha).ToLowerInvariant()
    if ($ReleaseCommit -notmatch '^[0-9a-f]{40}\z') { throw 'GitHub did not return a valid release commit.' }
} catch {
    $apiFailure = $_.Exception.Message
}

if (-not $ReleaseCommit) {
    Write-Host "GitHub API unavailable ($apiFailure); trying the official public release page..."
    try {
        $releasePage = Invoke-WebRequest -Uri 'https://github.com/FAHTHIZ/oasis/releases/latest' -Headers @{ 'User-Agent' = 'oasis-installer'; Accept = 'text/html' } -TimeoutSec 20 -UseBasicParsing
        $pageHtml = [string]$releasePage.Content

        $ReleaseTag = Resolve-OasisReleaseTagFromResponse -Response $releasePage
        $commitMatch = [regex]::Match($pageHtml, 'data-hovercard-type="commit"[^>]*href="https://github\.com/FAHTHIZ/oasis/commit/([0-9a-f]{40})"')
        if ($commitMatch.Success) {
            $ReleaseCommit = $commitMatch.Groups[1].Value.ToLowerInvariant()
        } else {
            # The release page may omit commit hovercards. Resolve the immutable
            # tag target from GitHub's public Atom feed, which does not use REST API quota.
            $encodedTag = [uri]::EscapeDataString($ReleaseTag)
            $atomPage = Invoke-WebRequest -Uri "https://github.com/FAHTHIZ/oasis/commits/$encodedTag.atom" -Headers @{ 'User-Agent' = 'oasis-installer'; Accept = 'application/atom+xml' } -TimeoutSec 20 -UseBasicParsing
            $ReleaseCommit = Resolve-OasisCommitFromAtom -Content ([string]$atomPage.Content)
        }
    } catch {
        Write-Host ("Could not resolve the latest stable OASIS release. API: " + $apiFailure + "; public release page: " + $_.Exception.Message)
        exit 1
    }
}
$Archive = "https://github.com/FAHTHIZ/oasis/archive/$ReleaseCommit.tar.gz"
Write-Host "Latest stable release: $ReleaseTag ($ReleaseCommit)"
Write-Host 'Git is optional for this archive-based install.'
Write-Host "OASIS will be installed for your user in: $InstallPrefix"
if (-not (Confirm-Change "May I install OASIS $ReleaseTag in that folder using npm?")) { exit 1 }

New-Item -ItemType Directory -Force -Path $InstallPrefix | Out-Null
& npm install --global --prefix $InstallPrefix $Archive
if ($LASTEXITCODE -ne 0) {
    Write-Host 'npm could not complete the OASIS install. No administrator command was run.'
    exit $LASTEXITCODE
}
if (-not (Test-Path $OasisCommand)) {
    Write-Host "The install finished, but OASIS was not found at $OasisCommand."
    exit 1
}
Write-Host 'Checking the installed OASIS version...'
& $OasisCommand --version
if (-not $SkipSetup) {
    try { & $OasisCommand doctor } catch { Write-Host 'The environment check reported a problem. Read the notes above before continuing.' }
    Write-Host 'Opening first-run model setup...'
    & $OasisCommand setup
} else {
    Write-Host 'First-run setup was skipped because -SkipSetup was supplied.'
    & $OasisCommand doctor
}

$pathEntries = @($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') })
if ($pathEntries -notcontains $InstallPrefix.TrimEnd('\')) {
    Write-Host 'The OASIS command folder is not on your permanent user PATH yet.'
    if (Confirm-Change "May I add $InstallPrefix to your user PATH? This affects only your Windows account.") {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $parts = @($userPath -split ';' | Where-Object { $_ })
        if ($parts -notcontains $InstallPrefix) { $parts += $InstallPrefix }
        [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
        $env:Path = "$env:Path;$InstallPrefix"
        Write-Host 'The user PATH entry is saved. Open a new PowerShell window to use oasis by name.'
    } else {
        Write-Host ('For this session, add ' + $InstallPrefix + ' to the front of PATH or call the command by full path.')
        Write-Host 'OASIS was installed; no PATH setting was changed.'
    }
}
Write-Host 'OASIS installation steps are complete.'
