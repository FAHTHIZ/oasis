# Pure GitHub release-page parsing helpers shared by the Windows installer and regression tests.
function Resolve-OasisReleaseTagFromResponse {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Response)

    $finalUrl = ''
    try {
        $baseResponse = $Response.BaseResponse
        if ($baseResponse.RequestMessage -and $baseResponse.RequestMessage.RequestUri) {
            # PowerShell 7 exposes the final redirected URL on HttpResponseMessage.
            $finalUrl = [string]$baseResponse.RequestMessage.RequestUri.AbsoluteUri
        } elseif ($baseResponse.ResponseUri) {
            # Windows PowerShell 5.1 exposes it on HttpWebResponse.
            $finalUrl = [string]$baseResponse.ResponseUri.AbsoluteUri
        }
    } catch { }

    $tagPattern = 'github\.com/FAHTHIZ/oasis/releases/tag/(v[0-9]+\.[0-9]+\.[0-9]+)(?:[/?#]|$)'
    $tagMatch = [regex]::Match($finalUrl, $tagPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $tagMatch.Success) {
        $pageHtml = [string]$Response.Content
        $tagMatch = [regex]::Match(
            $pageHtml,
            'href=["''](?:https://github\.com)?/FAHTHIZ/oasis/releases/tag/(v[0-9]+\.[0-9]+\.[0-9]+)["'']',
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    }

    if (-not $tagMatch.Success) {
        throw 'The public release redirect and page did not contain a stable version tag.'
    }
    return $tagMatch.Groups[1].Value
}

function Resolve-OasisCommitFromAtom {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Content)

    $entry = [regex]::Match($Content, '<entry\b[^>]*>([\s\S]*?)</entry>', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $entry.Success) {
        throw 'The public tag Atom feed did not contain a commit entry.'
    }

    $commit = [regex]::Match($entry.Groups[1].Value, '<id>tag:github\.com,2008:Grit::Commit/([0-9a-f]{40})</id>', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $commit.Success) {
        throw 'The public tag Atom feed did not include an exact commit SHA.'
    }
    return $commit.Groups[1].Value.ToLowerInvariant()
}
