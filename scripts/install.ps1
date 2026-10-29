# What this script does:
# 1. Checks for Node.js 22 or newer.
# 2. Offers to install Node.js with winget only after asking first.
# 3. Offers to install the pinned OASIS v0.3.0 release under your user profile.
# 4. Runs the environment check and opens first-run provider setup.
# It does not request administrator rights, upload files, or send telemetry.
[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$SkipSetup
)
$ErrorActionPreference = 'Stop'
$ReleaseTag = 'v0.3.0'
$Archive = "https://github.com/FAHTHIZ/oasis/archive/refs/tags/$ReleaseTag.tar.gz"
$InstallPrefix = Join-Path $env:LOCALAPPDATA 'OASIS'
$OasisCommand = Join-Path $InstallPrefix 'oasis.cmd'

function Say([string]$Message) {
    Write-Host $Message
}
function Confirm-Change([string]$Question) {
    if ($Yes) {
        Say "$Question [approved by -Yes]"
        return $true
    }
    $answer = Read-Host "$Question [y/N]"
    if ($answer -match '^(y|yes)$') { return $true }
    Say 'Nothing was changed.'
    return $false
}
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user) -join ';'
}

Say 'Checking for Node.js 22 or newer...'
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeMajor = 0
if ($node) {
    try { $nodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim()) } catch { $nodeMajor = 0 }
}
if ($nodeMajor -lt 22) {
    Say 'Node.js 22 or newer was not found. OASIS needs it to run.'
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        if (Confirm-Change "May I run 'winget install OpenJS.NodeJS.LTS --exact --scope user'?") {
            & winget install --id OpenJS.NodeJS.LTS --exact --scope user --accept-source-agreements --accept-package-agreements
            if ($LASTEXITCODE -ne 0) {
                Say 'winget could not complete the install without further system help.'
                Say 'You can install Node.js 22 or newer from https://nodejs.org/en/download and run this script again.'
                exit 1
            }
            Refresh-Path
        } else {
            exit 1
        }
    } else {
        Say 'winget was not found, so I have not installed anything.'
        Say 'Install Node.js 22 or newer from https://nodejs.org/en/download, then run this script again.'
        exit 1
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Say 'Node.js is not available in this terminal yet. Close and reopen PowerShell, then try again.'
        exit 1
    }
    try { $nodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim()) } catch { $nodeMajor = 0 }
    if ($nodeMajor -lt 22) {
        Say 'The installed Node.js version is still too old. Install version 22 or newer and try again.'
        exit 1
    }
}
Say ("Node.js is ready: " + (& node --version))
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Say 'npm was not found. Install a Node.js package that includes npm from https://nodejs.org/en/download, then try again.'
    exit 1
}
Say ("npm is ready: " + (& npm --version))
Say 'Git is optional for this archive-based installation.'
Say "OASIS will be installed for your user in: $InstallPrefix"
Say "The installer uses the fixed release $ReleaseTag; it does not download the moving main branch."

if (-not (Confirm-Change "May I install OASIS $ReleaseTag in that folder using npm?")) { exit 1 }
New-Item -ItemType Directory -Force -Path $InstallPrefix | Out-Null
& npm install --global --prefix $InstallPrefix $Archive
if ($LASTEXITCODE -ne 0) {
    Say 'npm could not complete the OASIS install. No administrator command was run.'
    exit $LASTEXITCODE
}
if (-not (Test-Path $OasisCommand)) {
    Say "The install finished, but the OASIS command was not found at $OasisCommand."
    exit 1
}
Say 'Checking the installed OASIS version...'
& $OasisCommand --version

if (-not $SkipSetup) {
    try { & $OasisCommand doctor } catch { Say 'The environment check reported a problem. Read the notes above before continuing.' }
    Say 'Opening first-run model setup...'
    & $OasisCommand setup
    Say "Setup finished. Open a new PowerShell window and type 'oasis' to start again."
} else {
    Say 'First-run setup was skipped because -SkipSetup was supplied.'
    & $OasisCommand doctor
}

$pathEntries = @($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') })
if ($pathEntries -notcontains $InstallPrefix.TrimEnd('\')) {
    Say 'The OASIS command folder is not on your permanent user PATH yet.'
    if (Confirm-Change "May I add $InstallPrefix to your user PATH? This affects only your Windows account.") {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $parts = @($userPath -split ';' | Where-Object { $_ })
        if ($parts -notcontains $InstallPrefix) { $parts += $InstallPrefix }
        [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
        $env:Path = "$env:Path;$InstallPrefix"
        Say 'The user PATH entry is saved. Open a new PowerShell window to use oasis by name.'
    } else {
        Say ('For this PowerShell window only, run: $env:Path = "' + $InstallPrefix + ';$env:Path"')
        Say 'OASIS was installed; no PATH setting was changed.'
    }
}
Say 'OASIS installation steps are complete.'
