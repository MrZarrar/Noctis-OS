use serde::Serialize;
use url::Url;

/// Noctis-only, and registered as such with the OS.
pub const SCHEME: &str = "noctis";

/// Fail closed, like the event-name registry in `@noctis/contracts`: a link this
/// build does not recognise is refused rather than forwarded to the WebView for
/// it to puzzle over.
const ROUTES: [&str; 4] = ["objective", "mission", "node", "command"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeepLink {
    pub route: String,
    pub target: Option<String>,
}

/// A target is an identifier or it is nothing. Without this a link could hand
/// the WebView any string it liked in a field the page will treat as an id.
fn is_identifier(value: &str) -> bool {
    value.len() == 36
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == char::from(45))
}

pub fn parse(raw: &str) -> Option<DeepLink> {
    let url = Url::parse(raw).ok()?;

    if url.scheme() != SCHEME {
        return None;
    }

    let route = url.host_str()?;

    if !ROUTES.contains(&route) {
        return None;
    }

    let segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();

    match segments.as_slice() {
        [] => Some(DeepLink {
            route: route.to_owned(),
            target: None,
        }),
        [target] if is_identifier(target) => Some(DeepLink {
            route: route.to_owned(),
            target: Some((*target).to_owned()),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_route_with_a_target() {
        assert_eq!(
            parse("noctis://objective/0199a000-0000-7000-8000-0000000000ff"),
            Some(DeepLink {
                route: "objective".to_owned(),
                target: Some("0199a000-0000-7000-8000-0000000000ff".to_owned()),
            })
        );
    }

    #[test]
    fn reads_a_route_without_a_target() {
        assert_eq!(
            parse("noctis://command"),
            Some(DeepLink {
                route: "command".to_owned(),
                target: None
            })
        );
    }

    #[test]
    fn refuses_another_scheme() {
        assert_eq!(parse("https://evil.example/objective"), None);
        assert_eq!(parse("file:///c:/windows"), None);
        assert_eq!(parse("not a url"), None);
        // A link that would be valid in every respect but its scheme. Without
        // this case the scheme check is redundant with the route allowlist, and
        // a sabotage that removes it passes.
        assert_eq!(
            parse("https://objective/0199a000-0000-7000-8000-0000000000ff"),
            None
        );
    }

    #[test]
    fn refuses_a_route_this_build_does_not_serve() {
        assert_eq!(parse("noctis://shell/cmd.exe"), None);
        // Same shape as the accepted cases, differing only in the route, so the
        // allowlist is what refuses these rather than the target rule.
        assert_eq!(parse("noctis://shell"), None);
        assert_eq!(
            parse("noctis://shell/0199a000-0000-7000-8000-0000000000ff"),
            None
        );
    }

    #[test]
    fn refuses_a_target_that_is_not_an_identifier() {
        assert_eq!(parse("noctis://objective/..%2f..%2fetc"), None);
        assert_eq!(parse("noctis://objective/a/b"), None);
    }
}
