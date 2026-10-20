param(
  [int]$Port = 8123
)

$serverPath = Join-Path $PSScriptRoot "server.ps1"
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  throw "server.ps1 was not found beside this launcher."
}

& $serverPath -Port $Port