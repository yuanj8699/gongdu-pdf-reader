[CmdletBinding()]
param(
    [string[]]$PdfPath,
    [switch]$Stdio,
    [ValidateRange(1, 65535)]
    [int]$Port = 3001
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

if ($Stdio) {
    # stdout belongs entirely to the MCP transport.
    & $nodePath $entryPath --stdio @resolvedPdfs
    exit $LASTEXITCODE
}

$previousPort = [Environment]::GetEnvironmentVariable('PORT', 'Process')
try {
    $env:PORT = [string]$Port
    Write-Host "MCP endpoint: http://127.0.0.1:$Port/mcp"
    Write-Host 'Use an MCP Apps host or Inspector to connect. This is not a standalone reader page.'
    & $nodePath $entryPath --enable-interact @resolvedPdfs
    if ($LASTEXITCODE -ne 0) {
        throw "PDF server exited with code $LASTEXITCODE."
    }
} finally {
    [Environment]::SetEnvironmentVariable('PORT', $previousPort, 'Process')
}
