[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string[]]$PdfPath,
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$ServerName = 'pdf_reader'
)

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$entryPath = Join-Path $projectPath 'dist\index.js'

if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw 'Build the reader first: npm ci; npm run build (from the project directory).'
}
if (-not $PdfPath -or $PdfPath.Count -eq 0) {
    $PdfPath = @(Join-Path $projectPath 'tests\fixtures\reader-smoke.pdf')
}

# A list of individual PDFs grants exactly those files, never an entire vault.
$resolvedPdfs = @(
    foreach ($pdf in $PdfPath) {
        $item = Get-Item -LiteralPath $pdf
        if ($item.PSIsContainer -or $item.Extension -ine '.pdf') {
            throw "Pass an existing PDF file, not a folder: $pdf"
        }
        $item.FullName
    }
)
$nodePath = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
$codexPath = @(Get-Command codex.exe -CommandType Application -ErrorAction Stop)[0].Source
$serverArgs = @('mcp', 'add', $ServerName, '--', $nodePath, $entryPath, '--stdio') + $resolvedPdfs

if ($PSCmdlet.ShouldProcess("Codex MCP server '$ServerName'", 'Add or update the local PDF reader')) {
    & $codexPath @serverArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Codex MCP registration failed (exit $LASTEXITCODE)."
    }
    Write-Host "Registered $ServerName with $($resolvedPdfs.Count) PDF file(s)."
    Write-Host 'The host starts the stdio process when it connects; no separate server window is needed.'
    Write-Host 'See CONNECT.md for refreshing the current task and verifying the embedded reader.'
}
