param([string]$ArchivePath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $OutputPath -Force
