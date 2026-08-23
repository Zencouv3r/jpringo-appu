<#
.SYNOPSIS
  Loads the user's Rust environment into the current PowerShell session.

.DESCRIPTION
  Rust is installed here with a non-default RUSTUP_HOME/CARGO_HOME (D:\Tools\...)
  set at the HKCU level. Processes started before those vars existed - and any
  shell that doesn't re-read the user environment - see rustup with no toolchain
  configured and fail with "could not choose a version of cargo to run".

  Dot-source this before running cargo:  . scripts/rust-env.ps1
#>
foreach ($name in @('RUSTUP_HOME', 'CARGO_HOME')) {
    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
        if ($value) { Set-Item -Path "Env:$name" -Value $value }
    }
}

$cargoBin = if ($env:CARGO_HOME) { Join-Path $env:CARGO_HOME 'bin' } else { Join-Path $HOME '.cargo\bin' }
if (($env:PATH -split ';') -notcontains $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }
