$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\release-resolution.ps1')

function Assert-Equal([string]$Expected, [string]$Actual, [string]$Label) {
    if ($Expected -cne $Actual) {
        throw "$Label failed. Expected '$Expected', got '$Actual'."
    }
}

$sha = '0123456789abcdef0123456789abcdef01234567'

# PowerShell 7 HttpResponseMessage shape.
$ps7 = [pscustomobject]@{
    Content = ''
    BaseResponse = [pscustomobject]@{
        RequestMessage = [pscustomobject]@{
            RequestUri = [uri]'https://github.com/FAHTHIZ/oasis/releases/tag/v9.8.7'
        }
        ResponseUri = $null
    }
}
Assert-Equal 'v9.8.7' (Resolve-OasisReleaseTagFromResponse -Response $ps7) 'PowerShell 7 redirect target'

# Windows PowerShell 5.1 HttpWebResponse shape.
$ps51 = [pscustomobject]@{
    Content = ''
    BaseResponse = [pscustomobject]@{
        RequestMessage = $null
        ResponseUri = [uri]'https://github.com/FAHTHIZ/oasis/releases/tag/v8.7.6'
    }
}
Assert-Equal 'v8.7.6' (Resolve-OasisReleaseTagFromResponse -Response $ps51) 'Windows PowerShell 5.1 redirect target'

# HTML page fallback supports absolute and relative release links.
$absoluteLink = [pscustomobject]@{
    Content = '<a href="https://github.com/FAHTHIZ/oasis/releases/tag/v7.6.5">release</a>'
    BaseResponse = $null
}
Assert-Equal 'v7.6.5' (Resolve-OasisReleaseTagFromResponse -Response $absoluteLink) 'absolute release link'

$relativeLink = [pscustomobject]@{
    Content = '<a href="/FAHTHIZ/oasis/releases/tag/v6.5.4">release</a>'
    BaseResponse = $null
}
Assert-Equal 'v6.5.4' (Resolve-OasisReleaseTagFromResponse -Response $relativeLink) 'relative release link'

$stableTags = @(
    [pscustomobject]@{ name = 'v9.9.9'; commit = [pscustomobject]@{ sha = '1111111111111111111111111111111111111111' } },
    [pscustomobject]@{ name = 'v9.10.0'; commit = [pscustomobject]@{ sha = '2222222222222222222222222222222222222222' } },
    [pscustomobject]@{ name = 'v10.0.0-beta.1'; commit = [pscustomobject]@{ sha = '3333333333333333333333333333333333333333' } }
)
$stableTag = Resolve-OasisStableTagFromList -Tags $stableTags
Assert-Equal 'v9.10.0' $stableTag.Tag 'newest stable semantic version tag'
Assert-Equal '2222222222222222222222222222222222222222' $stableTag.CommitSha 'stable tag commit SHA'

$rejected = $false
try {
    Resolve-OasisStableTagFromList -Tags @([pscustomobject]@{ name = 'v10.0.0-beta.1'; commit = [pscustomobject]@{ sha = '3333333333333333333333333333333333333333' } })
} catch {
    $rejected = $_.Exception.Message -match 'stable version tag'
}
if (-not $rejected) { throw 'The tag resolver accepted a prerelease-only tag list.' }

$gitTagOutput = @"
1111111111111111111111111111111111111111 refs/tags/v9.9.9
2222222222222222222222222222222222222222 refs/tags/v9.10.0
3333333333333333333333333333333333333333 refs/tags/v10.0.0-beta.1
4444444444444444444444444444444444444444 refs/tags/v10.0.0
5555555555555555555555555555555555555555 refs/tags/v10.0.0^{}
"@
$gitStable = Resolve-OasisStableTagFromGitOutput -Output $gitTagOutput
Assert-Equal 'v10.0.0' $gitStable.Tag 'newest Git stable semantic version tag'
Assert-Equal '5555555555555555555555555555555555555555' $gitStable.CommitSha 'peeled annotated tag commit SHA'

$atom = "<?xml version='1.0'?><feed><entry><id>tag:github.com,2008:Grit::Commit/$sha</id></entry></feed>"
Assert-Equal $sha (Resolve-OasisCommitFromAtom -Content $atom) 'Atom commit SHA'

$rejected = $false
try {
    Resolve-OasisReleaseTagFromResponse -Response ([pscustomobject]@{ Content = '<html>no release</html>'; BaseResponse = $null })
} catch {
    $rejected = $_.Exception.Message -match 'stable version tag'
}
if (-not $rejected) { throw 'Invalid release page was not rejected.' }

$rejected = $false
try {
    Resolve-OasisCommitFromAtom -Content '<feed><entry><id>not-a-commit</id></entry></feed>'
} catch {
    $rejected = $_.Exception.Message -match 'exact commit SHA'
}
if (-not $rejected) { throw 'Invalid Atom feed was not rejected.' }

Write-Host 'PowerShell release fallback tests passed: redirects, absolute/relative links, Atom SHA, and fail-closed parsing.'
