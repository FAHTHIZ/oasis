# Runs scripts/install.ps1 against fake node, npm and winget commands to check
# PATH handling and safe failures (issue #42). Windows only. It saves and
# restores the user PATH, and fails if the machine-wide PATH changes.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { Write-Host 'Skipped: Windows only.'; exit 0 }

$installer = Join-Path $PSScriptRoot '..\scripts\install.ps1'
$pwshExe = (Get-Process -Id $PID).Path
$commit = '0123456789abcdef0123456789abcdef01234567'
$failures = @()

function New-FakeTools([string]$Root, [string[]]$Tools, [int]$NpmExit = 0, [int]$WingetExit = 0) {
    $bin = Join-Path $Root 'bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $log = Join-Path $Root 'calls.log'
    # PowerShell scripts, not .cmd files, so arguments arrive unmangled.
    if ($Tools -contains 'node') {
        Set-Content -Path (Join-Path $bin 'node.ps1') -Value @(
            'if ($args[0] -eq "-p") { "2215" } else { "v22.15.0" }'
        )
    }
    if ($Tools -contains 'npm') {
        Set-Content -Path (Join-Path $bin 'npm.ps1') -Value @(
            "Add-Content -Path '$log' -Value ('npm ' + (`$args -join ' '))",
            'if ($args[0] -eq "--version") { "10.0.0"; exit 0 }',
            "if ($NpmExit -ne 0) { exit $NpmExit }",
            '$prefix = $args[[array]::IndexOf($args, "--prefix") + 1]',
            'New-Item -ItemType Directory -Force -Path $prefix | Out-Null',
            'Set-Content -Path (Join-Path $prefix "oasis.cmd") -Encoding ascii -Value "@echo oasis-fake %*"',
            'exit 0'
        )
    }
    if ($Tools -contains 'winget') {
        Set-Content -Path (Join-Path $bin 'winget.ps1') -Value @(
            "Add-Content -Path '$log' -Value ('winget ' + (`$args -join ' '))",
            "exit $WingetExit"
        )
    }
    return @{ Bin = $bin; Log = $log }
}

function Invoke-Installer([string]$Name, [string[]]$Tools, [string[]]$Arguments, [string]$InputText = '', [int]$NpmExit = 0, [int]$WingetExit = 0) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('oasis-ps-' + $Name + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $fake = New-FakeTools -Root $root -Tools $Tools -NpmExit $NpmExit -WingetExit $WingetExit
    $psi = [System.Diagnostics.ProcessStartInfo]::new($pwshExe)
    foreach ($arg in @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer) + $Arguments) { $psi.ArgumentList.Add($arg) }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    # Only the fake tools, PowerShell itself and System32 are on PATH, so the
    # runner's real node, npm and winget are invisible to the installer.
    $psi.Environment['Path'] = @($fake.Bin, (Split-Path $pwshExe), (Join-Path $env:SystemRoot 'System32')) -join ';'
    $psi.Environment['LOCALAPPDATA'] = $root
    $psi.Environment['OASIS_INSTALL_COMMIT'] = $commit
    $process = [System.Diagnostics.Process]::Start($psi)
    if ($InputText) { $process.StandardInput.Write($InputText) }
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(120000)) { $process.Kill($true); throw "$Name timed out" }
    $calls = if (Test-Path $fake.Log) { Get-Content -Raw $fake.Log } else { '' }
    return [pscustomobject]@{ Name = $Name; Exit = $process.ExitCode; Output = $stdout.Result + $stderr.Result; Calls = $calls; Prefix = (Join-Path $root 'OASIS'); Root = $root }
}

function Check([bool]$Condition, [string]$Label, $Result) {
    if ($Condition) { Write-Host "ok - $Label" }
    else {
        Write-Host "not ok - $Label"
        if ($Result) { Write-Host ($Result.Output | Out-String) }
        $script:failures += $Label
    }
}

$machineBefore = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userBefore = [Environment]::GetEnvironmentVariable('Path', 'User')
try {
    # Missing Node.js and missing winget: stop with a clear message, change nothing.
    $r = Invoke-Installer -Name 'no-node-no-winget' -Tools @() -Arguments @('-Yes', '-SkipSetup')
    Check ($r.Exit -eq 1) 'missing Node.js and winget exits 1' $r
    Check ($r.Output -match 'winget was not found, so I have not installed anything') 'missing winget says nothing was installed' $r
    Check (-not (Test-Path $r.Prefix)) 'missing winget creates no install folder' $r

    # Missing Node.js, winget present, user declines: winget never runs.
    $r = Invoke-Installer -Name 'decline-winget' -Tools @('winget') -Arguments @('-SkipSetup') -InputText "n`n"
    Check ($r.Exit -eq 1) 'declining the Node.js install exits 1' $r
    Check ($r.Output -match 'Nothing was changed') 'declining the Node.js install says nothing changed' $r
    Check ($r.Calls -notmatch 'winget') 'declining the Node.js install never runs winget' $r

    # winget fails: user-scope only, no administrator command, safe message.
    $r = Invoke-Installer -Name 'winget-fails' -Tools @('winget') -Arguments @('-Yes', '-SkipSetup') -WingetExit 5
    Check ($r.Exit -eq 1) 'a failed winget install exits 1' $r
    Check ($r.Calls -match '--scope user') 'winget is asked for a user-scope install' $r
    Check ($r.Calls -notmatch 'machine') 'winget is never asked for a machine-scope install' $r
    Check ($r.Output -match 'No administrator command was run') 'a failed winget install says no administrator command ran' $r

    # npm install fails: exit with npm's code and a safe message.
    $r = Invoke-Installer -Name 'npm-fails' -Tools @('node', 'npm') -Arguments @('-Yes', '-SkipSetup') -NpmExit 7
    Check ($r.Exit -eq 7) 'a failed npm install exits with npm''s code' $r
    Check ($r.Output -match 'npm could not complete the OASIS install. No administrator command was run') 'a failed npm install explains what happened' $r
    Check ($r.Calls -match [regex]::Escape('--prefix')) 'npm installs into a user prefix' $r

    # Install approved, PATH change declined: the user PATH is untouched.
    $r = Invoke-Installer -Name 'decline-path' -Tools @('node', 'npm') -Arguments @('-SkipSetup') -InputText "y`nn`n"
    Check ($r.Exit -eq 0) 'declining the PATH change still finishes the install' $r
    Check (Test-Path (Join-Path $r.Prefix 'oasis.cmd')) 'the command is installed when PATH is declined' $r
    Check ($r.Output -match 'no PATH setting was changed') 'declining the PATH change says so' $r
    Check ([Environment]::GetEnvironmentVariable('Path', 'User') -eq $userBefore) 'declining the PATH change leaves the user PATH alone' $r

    # Everything approved: only the user PATH gains the install folder.
    $r = Invoke-Installer -Name 'approve-path' -Tools @('node', 'npm') -Arguments @('-Yes', '-SkipSetup')
    $userAfter = [Environment]::GetEnvironmentVariable('Path', 'User')
    Check ($r.Exit -eq 0) 'an approved install exits 0' $r
    Check (@($userAfter -split ';') -contains $r.Prefix) 'the approved PATH change adds the folder to the user PATH' $r
    Check ($r.Output -match 'affects only your Windows account') 'the PATH prompt says it is user-only' $r
    $kept = @($userBefore -split ';' | Where-Object { $_ })
    Check (@($kept | Where-Object { @($userAfter -split ';') -notcontains $_ }).Count -eq 0) 'the approved PATH change keeps every existing user PATH entry' $r
} finally {
    [Environment]::SetEnvironmentVariable('Path', $userBefore, 'User')
}
Check ([Environment]::GetEnvironmentVariable('Path', 'Machine') -eq $machineBefore) 'the machine-wide PATH never changes' $null

if ($failures.Count) { throw ("PowerShell installer checks failed: " + ($failures -join '; ')) }
Write-Host 'All PowerShell installer PATH checks passed.'
