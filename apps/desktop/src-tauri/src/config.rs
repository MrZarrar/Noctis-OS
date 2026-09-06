use url::Url;

/// Noctis-only default. The core's own `DEFAULT_PORT`, and a port neither the
/// donor nor any common tool uses.
pub const DEFAULT_CORE_URL: &str = "http://127.0.0.1:7717";
pub const CORE_URL_VAR: &str = "NOCTIS_CORE_URL";
pub const CORE_TOKEN_VAR: &str = "NOCTIS_CORE_TOKEN";

/// Mirrors the core's `MIN_TOKEN_LENGTH`. A shorter value is not a credential.
const MIN_TOKEN_LENGTH: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    MissingToken,
    ShortToken,
    UnusableUrl(String),
    NotAnOrigin(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingToken => write!(f, "{CORE_TOKEN_VAR} is required"),
            Self::ShortToken => {
                write!(
                    f,
                    "{CORE_TOKEN_VAR} must be at least {MIN_TOKEN_LENGTH} characters"
                )
            }
            Self::UnusableUrl(value) => write!(f, "{CORE_URL_VAR} is not a usable URL: {value}"),
            Self::NotAnOrigin(value) => write!(f, "{CORE_URL_VAR} must be a bare origin: {value}"),
        }
    }
}

/// Where the core is and how to prove we may talk to it.
///
/// The token lives here, in the shell process, and is never handed to the
/// WebView or written to the frontend in any form (Section 9.2).
#[derive(Clone)]
pub struct CoreConfig {
    pub base: Url,
    token: String,
}

/// Redacting, and hand-written for that reason. A derived `Debug` would print
/// the token into any log line, panic message, or error chain that formats the
/// configuration — which is how a secret held correctly still escapes.
impl std::fmt::Debug for CoreConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreConfig")
            .field("base", &self.base.as_str())
            .field("token", &"<redacted>")
            .finish()
    }
}

impl CoreConfig {
    pub fn new(url: Option<&str>, token: Option<&str>) -> Result<Self, ConfigError> {
        let token = token
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(ConfigError::MissingToken)?;

        if token.len() < MIN_TOKEN_LENGTH {
            return Err(ConfigError::ShortToken);
        }

        let raw = url
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_CORE_URL);
        let base = Url::parse(raw).map_err(|_| ConfigError::UnusableUrl(raw.to_owned()))?;

        if !matches!(base.scheme(), "http" | "https") {
            return Err(ConfigError::UnusableUrl(raw.to_owned()));
        }

        // Scheme, host, and port; nothing else. A base carrying a path, a query,
        // or credentials would make the origin comparison every request is
        // checked against mean something other than what it reads as.
        if base.host().is_none()
            || base.path() != "/"
            || base.query().is_some()
            || base.fragment().is_some()
            || !base.username().is_empty()
            || base.password().is_some()
        {
            return Err(ConfigError::NotAnOrigin(raw.to_owned()));
        }

        Ok(Self {
            base,
            token: token.to_owned(),
        })
    }

    pub fn from_env() -> Result<Self, ConfigError> {
        Self::new(
            std::env::var(CORE_URL_VAR).ok().as_deref(),
            std::env::var(CORE_TOKEN_VAR).ok().as_deref(),
        )
    }

    /// Deliberately a method rather than a public field: the one place the token
    /// is readable is where a request is signed.
    pub fn bearer(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn defaults_to_the_noctis_loopback_core() {
        let config = CoreConfig::new(None, Some(TOKEN)).expect("configuration");

        assert_eq!(config.base.as_str(), "http://127.0.0.1:7717/");
    }

    #[test]
    fn refuses_a_missing_token() {
        assert_eq!(
            CoreConfig::new(None, None).unwrap_err(),
            ConfigError::MissingToken
        );
        assert_eq!(
            CoreConfig::new(None, Some("   ")).unwrap_err(),
            ConfigError::MissingToken
        );
    }

    #[test]
    fn refuses_a_token_too_short_to_be_a_credential() {
        assert_eq!(
            CoreConfig::new(None, Some("short")).unwrap_err(),
            ConfigError::ShortToken
        );
    }

    #[test]
    fn refuses_a_url_that_is_not_a_bare_origin() {
        assert_eq!(
            CoreConfig::new(Some("http://127.0.0.1:7717/api"), Some(TOKEN)).unwrap_err(),
            ConfigError::NotAnOrigin("http://127.0.0.1:7717/api".to_owned())
        );
        assert_eq!(
            CoreConfig::new(Some("http://user:pass@127.0.0.1:7717"), Some(TOKEN)).unwrap_err(),
            ConfigError::NotAnOrigin("http://user:pass@127.0.0.1:7717".to_owned())
        );
    }

    #[test]
    fn refuses_a_scheme_that_is_not_http() {
        assert_eq!(
            CoreConfig::new(Some("file:///c:/noctis"), Some(TOKEN)).unwrap_err(),
            ConfigError::UnusableUrl("file:///c:/noctis".to_owned())
        );
        assert!(CoreConfig::new(Some("not a url"), Some(TOKEN)).is_err());
    }

    #[test]
    fn never_prints_the_token() {
        let config = CoreConfig::new(None, Some(TOKEN)).expect("configuration");

        assert!(!format!("{config:?}").contains(TOKEN));
        assert!(format!("{config:?}").contains("redacted"));
        assert_eq!(config.bearer(), format!("Bearer {TOKEN}"));
    }
}
