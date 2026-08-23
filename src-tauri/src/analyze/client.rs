//! One request to the chat-completions endpoint, retried sensibly.
//!
//! Both analysis passes — the per-line breakdown and the dictionary lookup —
//! want the same thing: a prompt in, JSON matching a strict schema out, with
//! retries on the failures that are worth retrying. That shape lives here so
//! the two passes differ only in their prompt and their schema, which is the
//! only place they should differ.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::settings::Settings;

const API_URL: &str = "https://api.openai.com/v1/chat/completions";

/// A large batch on a slow model genuinely can take minutes; the default
/// timeout would abort work that was about to succeed.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

const MAX_ATTEMPTS: u32 = 4;

#[derive(Debug, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Message,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Message {
    #[serde(default)]
    content: String,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    #[serde(default)]
    message: String,
}

pub fn build() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| AppError::OpenAi(format!("could not create an HTTP client: {e}")))
}

/// Sends one prompt and returns the model's raw JSON content.
///
/// 4xx other than 429 are not retried — a bad key or a malformed request will
/// fail identically every time, and retrying only delays the error the user
/// needs to see.
pub async fn json(
    client: &reqwest::Client,
    settings: &Settings,
    api_key: &str,
    prompt: &str,
    schema_name: &str,
    schema: Value,
) -> Result<String> {
    let mut body = json!({
        "model": settings.openai_model,
        "messages": [{ "role": "user", "content": prompt }],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": schema_name, "strict": true, "schema": schema }
        }
    });

    // Only sent when set, because it is a GPT-5-family parameter and older
    // models reject the field outright rather than ignoring it.
    let effort = settings.reasoning_effort.trim();
    if !effort.is_empty() {
        body["reasoning_effort"] = json!(effort);
    }

    let mut last_error = AppError::OpenAi("request was never attempted".into());

    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            // 1s, 2s, 4s.
            tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
        }

        let response = match client.post(API_URL).bearer_auth(api_key).json(&body).send().await {
            Ok(response) => response,
            Err(err) => {
                last_error = AppError::OpenAi(format!("network error: {err}"));
                continue;
            }
        };

        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AppError::OpenAi(
                "The OpenAI API key was rejected. Check it in Settings.".into(),
            ));
        }
        if status.is_client_error() && status != reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AppError::OpenAi(describe_error(status, &text)));
        }
        if !status.is_success() {
            last_error = AppError::OpenAi(describe_error(status, &text));
            continue;
        }

        let parsed: ChatResponse = match serde_json::from_str(&text) {
            Ok(parsed) => parsed,
            Err(err) => {
                last_error = AppError::OpenAi(format!("unreadable response: {err}"));
                continue;
            }
        };
        if let Some(err) = parsed.error {
            last_error = AppError::OpenAi(err.message);
            continue;
        }
        let Some(choice) = parsed.choices.into_iter().next() else {
            last_error = AppError::OpenAi("the response contained no choices".into());
            continue;
        };
        // A truncated response is still schema-valid but is missing entries;
        // retrying is more useful than merging half a batch.
        if choice.finish_reason.as_deref() == Some("length") {
            last_error = AppError::OpenAi("the response hit the output token limit".into());
            continue;
        }

        return Ok(choice.message.content);
    }

    Err(last_error)
}

/// Pulls the human-readable reason out of an OpenAI error body.
fn describe_error(status: reqwest::StatusCode, body: &str) -> String {
    serde_json::from_str::<ChatResponse>(body)
        .ok()
        .and_then(|r| r.error)
        .map(|e| e.message)
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| format!("OpenAI returned {status}"))
}
