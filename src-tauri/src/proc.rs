//! Spawning bundled sidecar binaries.
//!
//! Every ffmpeg/ffprobe/whisper invocation goes through here so that three
//! easily-forgotten details are handled in exactly one place: locating the
//! binary for the current build layout, making the ggml/OpenBLAS DLLs
//! loadable, and suppressing the console window Windows would otherwise flash
//! on every spawn.

use std::process::Stdio;

use tauri::AppHandle;
use tokio::process::Command;

use crate::error::{AppError, Result};
use crate::paths;

/// `CREATE_NO_WINDOW`. Without it every ffmpeg call pops a console window in
/// front of the app — dozens of times during a single analysis.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Builds a [`Command`] for a bundled sidecar, with stdio piped and the
/// environment prepared.
pub fn command(app: &AppHandle, name: &str) -> Result<Command> {
    let exe = paths::sidecar(name)?;
    let mut cmd = Command::new(&exe);

    // whisper-cli finds its compute backends — `ggml-cpu-*.dll`,
    // `ggml-blas.dll` — by *scanning directories*, not by asking Windows to
    // resolve a name, so `PATH` cannot reach them however it is set. ggml looks
    // in exactly two places: the directory holding the running executable, and
    // the working directory. Nothing else.
    //
    // Bundling used to put those DLLs in a `binaries/` subfolder, which is
    // neither, so ggml registered zero devices and the first transcription died
    // on an assertion inside upstream's own code. The DLLs now ship beside the
    // sidecar (`resources` in tauri.conf.json) to satisfy the first location;
    // pointing the working directory at the same folder satisfies the second,
    // so the backends stay reachable even if that packaging changes again.
    //
    // Safe because every path this crate passes to a sidecar is absolute.
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }

    // The *implicit* imports are a separate problem with a separate answer:
    // whisper-cli links whisper.dll -> ggml.dll -> ggml-base.dll by name, and
    // those do go through the usual search order, as does libopenblas.dll
    // behind ggml-blas.dll. Prepending every plausible directory keeps the
    // development and bundled layouts both working.
    let extra: Vec<String> = paths::sidecar_dirs(app)
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if !extra.is_empty() {
        let existing = std::env::var("PATH").unwrap_or_default();
        let sep = if cfg!(windows) { ";" } else { ":" };
        cmd.env("PATH", format!("{}{sep}{existing}", extra.join(sep)));
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Orphaned ffmpeg processes are the classic failure mode of a
        // streaming server; killing on drop makes cancellation reliable.
        .kill_on_drop(true);

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    Ok(cmd)
}

/// Runs a sidecar to completion and returns its stdout.
///
/// On a non-zero exit the error carries the *tail* of stderr rather than the
/// whole thing: ffmpeg writes its full build configuration on startup, and the
/// line that explains the failure is always the last one.
pub async fn run_capture(mut cmd: Command, tool: &str) -> Result<Vec<u8>> {
    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Sidecar { tool: tool.into(), message: format!("could not start: {e}") })?;

    if !output.status.success() {
        return Err(AppError::Sidecar {
            tool: tool.into(),
            message: stderr_tail(&output.stderr),
        });
    }
    Ok(output.stdout)
}

/// How much of a failing sidecar's stderr to quote back. Enough that a cause
/// printed a few lines above the final symptom still survives into the error.
const TAIL_LINES: usize = 12;

/// Last few meaningful lines of a sidecar's stderr, for error messages.
pub fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let tail = lines
        .iter()
        .rev()
        .take(TAIL_LINES)
        .rev()
        .copied()
        .collect::<Vec<_>>();
    if tail.is_empty() {
        "no diagnostic output".to_string()
    } else {
        tail.join("; ")
    }
}
