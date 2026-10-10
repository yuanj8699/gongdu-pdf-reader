[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string[]]$PdfPath,
    [string[]]$LibraryPath
)

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$entryPath = Join-Path $projectPath 'dist\index.js'
$sourcePath = Join-Path $projectPath 'plugins\gongdu'
$marketplacePath = Join-Path $projectPath '.local-plugin'
$pluginPath = Join-Path $marketplacePath 'plugins\gongdu'
$nodePath = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
$codexPath = @(Get-Command codex.exe -CommandType Application -ErrorAction Stop)[0].Source

if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw 'Build the reader first: npm ci; npm run build (from the project directory).'
}
if (-not $PdfPath -or $PdfPath.Count -eq 0) {
    $PdfPath = @(Join-Path $projectPath 'tests\fixtures\reader-smoke.pdf')
}
$readerArgs = @($entryPath, '--stdio')
foreach ($pdf in $PdfPath) {
    $item = Get-Item -LiteralPath $pdf
    if ($item.PSIsContainer -or $item.Extension -ine '.pdf') {
        throw "Pass an existing PDF file, not a folder: $pdf"
    }
    $readerArgs += $item.FullName
}
foreach ($directory in $LibraryPath) {
    $item = Get-Item -LiteralPath $directory
    if (-not $item.PSIsContainer) { throw "Pass an existing library folder: $directory" }
    $readerArgs += "--library-dir=$($item.FullName)"
}

if (-not $PSCmdlet.ShouldProcess('gongdu@gongdu-local', 'Generate and install the local Gongdu plugin')) {
    return
}

# The generated package holds metadata and local paths, not a second reader runtime.
New-Item -ItemType Directory -Path $pluginPath -Force | Out-Null
Get-ChildItem -LiteralPath $sourcePath -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $pluginPath -Recurse -Force
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$server = [ordered]@{
    type = 'stdio'
    command = 'node'
    args = $readerArgs
}
$portableMcp = [ordered]@{
    '$schema' = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
    mcpServers = [ordered]@{ gongdu = $server }
}
[System.IO.File]::WriteAllText((Join-Path $pluginPath 'mcp.json'), ($portableMcp | ConvertTo-Json -Depth 10), $utf8)
# Codex's compatibility loader expects the same command without portable type metadata.
$compatServer = [ordered]@{ command = $nodePath; args = $readerArgs; cwd = $projectPath }
$compatMcp = [ordered]@{ mcpServers = [ordered]@{ gongdu = $compatServer } }
[System.IO.File]::WriteAllText((Join-Path $pluginPath '.mcp.json'), ($compatMcp | ConvertTo-Json -Depth 10), $utf8)
$catalog = [ordered]@{
    name = 'gongdu-local'
    interface = [ordered]@{ displayName = '共读 · 本机插件' }
    plugins = @([ordered]@{
        name = 'gongdu'
        source = [ordered]@{ source = 'local'; path = './plugins/gongdu' }
        policy = [ordered]@{ installation = 'AVAILABLE'; authentication = 'ON_USE' }
        category = 'Productivity'
    })
}
$catalogPath = Join-Path $marketplacePath '.agents\plugins'
New-Item -ItemType Directory -Path $catalogPath -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $catalogPath 'marketplace.json'), ($catalog | ConvertTo-Json -Depth 10), $utf8)

& $codexPath plugin marketplace add $marketplacePath --json
if ($LASTEXITCODE -ne 0) { throw "Plugin marketplace registration failed (exit $LASTEXITCODE)." }
& $codexPath plugin add 'gongdu@gongdu-local' --json
if ($LASTEXITCODE -ne 0) { throw "Plugin installation failed (exit $LASTEXITCODE)." }
Write-Host 'Installed 共读 (gongdu@gongdu-local). Check the Plugins page or codex plugin list --marketplace gongdu-local --json.'
Write-Host 'Keep this project directory and its built runtime. Re-run this script after moving the project or changing authorized paths.'
Write-Host 'Existing standalone pdf_reader registration is preserved until the plugin connection has been verified. See CONNECT.md.'
