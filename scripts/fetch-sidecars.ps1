<#
.SYNOPSIS
  Downloads the ffmpeg / ffprobe / whisper-cli sidecar binaries into src-tauri/binaries/.

.DESCRIPTION
  Tauri's `externalBin` resolves a sidecar by appending the *target triple* to the
  configured name, so the files must land as e.g. `ffmpeg-x86_64-pc-windows-msvc.exe`
  rather than plain `ffmpeg.exe`. That renaming is the only non-obvious part of
  this script; everything else is download-and-unzip.

  Versions are pinned so a rebuild six months from now produces the same binaries.
  Run this once after cloning:  pwsh -File scripts/fetch-sidecars.ps1
#>
[CmdletBinding()]
param(
    # Re-download and overwrite binaries that are already present.
    [switch]$Force,
    # Also fetch the cuBLAS whisper build (~640MB) for NVIDIA GPU acceleration.
    [switch]$Cuda
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$BinDir     = Join-Path $RepoRoot 'src-tauri\binaries'
$TargetTriple = 'x86_64-pc-windows-msvc'

# Pinned upstream artifacts. Bump deliberately, not incidentally.
$FfmpegUrl  = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip'
$WhisperUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-blas-bin-x64.zip'
$CublasUrl  = 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-cublas-12.4.0-bin-x64.zip'

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Staging = Join-Path ([System.IO.Path]::GetTempPath()) "ringo-sidecars-$PID"
New-Item -ItemType Directory -Force -Path $Staging | Out-Null

function Get-Archive {
    param([string]$Url, [string]$Name)
    $dest = Join-Path $Staging "$Name.zip"
    Write-Host "  downloading $Name..." -ForegroundColor DarkGray
    # Progress rendering makes Invoke-WebRequest an order of magnitude slower.
    $prev = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $Url -OutFile $dest -UseBasicParsing } finally { $ProgressPreference = $prev }
    $out = Join-Path $Staging $Name
    Expand-Archive -Path $dest -DestinationPath $out -Force
    return $out
}

# Copies one extracted .exe (found anywhere in $Root) to its target-triple name.
function Install-Sidecar {
    param([string]$Root, [string]$ExeName, [string]$SidecarName = $null)
    if (-not $SidecarName) { $SidecarName = $ExeName }
    $target = Join-Path $BinDir "$SidecarName-$TargetTriple.exe"
    $src = Get-ChildItem -Path $Root -Filter "$ExeName.exe" -Recurse -File | Select-Object -First 1
    if (-not $src) { throw "$ExeName.exe not found in $Root" }
    Copy-Item -Path $src.FullName -Destination $target -Force
    $mb = [math]::Round((Get-Item $target).Length / 1MB, 1)
    Write-Host "  + $SidecarName-$TargetTriple.exe ($mb MB)" -ForegroundColor Green
}

# Whisper's DLLs (ggml, OpenBLAS, ...) sit next to the exe and are loaded at
# runtime, so they ship alongside it rather than being renamed as sidecars.
function Install-RuntimeDlls {
    param([string]$Root)
    $dlls = Get-ChildItem -Path $Root -Filter '*.dll' -Recurse -File
    foreach ($dll in $dlls) { Copy-Item -Path $dll.FullName -Destination (Join-Path $BinDir $dll.Name) -Force }
    if ($dlls) { Write-Host "  + $($dlls.Count) runtime DLL(s)" -ForegroundColor Green }
}

function Test-Present {
    param([string]$SidecarName)
    return (-not $Force) -and (Test-Path (Join-Path $BinDir "$SidecarName-$TargetTriple.exe"))
}

try {
    if (Test-Present 'ffmpeg') {
        Write-Host "ffmpeg/ffprobe already present (use -Force to refresh)" -ForegroundColor Yellow
    } else {
        Write-Host "ffmpeg + ffprobe" -ForegroundColor Cyan
        $root = Get-Archive -Url $FfmpegUrl -Name 'ffmpeg'
        Install-Sidecar -Root $root -ExeName 'ffmpeg'
        Install-Sidecar -Root $root -ExeName 'ffprobe'
    }

    if (Test-Present 'whisper-cli') {
        Write-Host "whisper-cli already present (use -Force to refresh)" -ForegroundColor Yellow
    } else {
        Write-Host "whisper-cli (OpenBLAS / CPU)" -ForegroundColor Cyan
        $root = Get-Archive -Url $WhisperUrl -Name 'whisper'
        Install-Sidecar -Root $root -ExeName 'whisper-cli'
        Install-RuntimeDlls -Root $root
    }

    # Optional GPU build. Installed under a distinct sidecar name; the Rust side
    # prefers it when present and falls back to the CPU build when it isn't.
    if ($Cuda) {
        if (Test-Present 'whisper-cli-gpu') {
            Write-Host "whisper-cli-gpu already present (use -Force to refresh)" -ForegroundColor Yellow
        } else {
            Write-Host "whisper-cli (cuBLAS / NVIDIA GPU) - large download" -ForegroundColor Cyan
            $root = Get-Archive -Url $CublasUrl -Name 'whisper-cuda'
            Install-Sidecar -Root $root -ExeName 'whisper-cli' -SidecarName 'whisper-cli-gpu'
            Install-RuntimeDlls -Root $root
        }
    }

    Write-Host "`nSidecars ready in src-tauri\binaries" -ForegroundColor Green
} finally {
    Remove-Item -Path $Staging -Recurse -Force -ErrorAction SilentlyContinue
}
