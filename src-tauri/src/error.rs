use std::fmt::Display;

/// Every fallible operation in the app funnels into this type.
///
/// It implements `Serialize` because Tauri requires command errors to cross the
/// IPC boundary as JSON. The frontend receives `{ kind, message }` so it can
/// branch on `kind` (e.g. show the settings dialog when the key is missing)
/// without string-matching on human-readable text.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    InvalidInput(String),

    /// Another run already holds this video. Distinct from `InvalidInput`
    /// because it is the one refusal that is worth retrying: switching
    /// subtitle tracks quickly can land a request while the previous one is
    /// still finishing, and a second later it would succeed.
    #[error("{0}")]
    Busy(String),

    /// The whisper model file is absent or unreadable.
    #[error("{0}")]
    MissingModel(String),

    /// A bundled sidecar (ffmpeg/ffprobe/whisper-cli) could not be located.
    #[error("{0}")]
    MissingSidecar(String),

    /// A sidecar ran but exited non-zero. Carries the tail of its stderr,
    /// which is the only genuinely diagnostic part of an ffmpeg failure.
    #[error("{tool} failed: {message}")]
    Sidecar { tool: String, message: String },

    #[error("OpenAI request failed: {0}")]
    OpenAi(String),

    #[error("This operation was cancelled.")]
    Cancelled,

    #[error("{0}")]
    Io(String),

    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// Stable machine-readable discriminant for the frontend to branch on.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "notFound",
            Self::InvalidInput(_) => "invalidInput",
            Self::Busy(_) => "busy",
            Self::MissingModel(_) => "missingModel",
            Self::MissingSidecar(_) => "missingSidecar",
            Self::Sidecar { .. } => "sidecar",
            Self::OpenAi(_) => "openai",
            Self::Cancelled => "cancelled",
            Self::Io(_) => "io",
            Self::Other(_) => "other",
        }
    }

    pub fn other(message: impl Display) -> Self {
        Self::Other(message.to_string())
    }
}

impl serde::Serialize for AppError {
    // Fully qualified: the `Result<T>` alias at the bottom of this module
    // shadows the two-parameter form the trait requires.
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::Other(format!("malformed JSON: {err}"))
    }
}

impl From<tauri::Error> for AppError {
    fn from(err: tauri::Error) -> Self {
        Self::Other(err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
