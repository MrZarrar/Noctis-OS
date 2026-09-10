//! What tools Noctis may reach, and how.
//!
//! A tool is a row, not an adapter. Nothing in this file knows what Suno or
//! Vinted *is* — it knows that a descriptor names routes, and that a route names
//! the facts it needs. Adding a tool is an edit to `tools.json`; if adding one
//! ever needs code, the router was not general.
//!
//! The descriptors live in the shell for the same reason the window grant list
//! does: they hold executable paths and origin allowlists, and a page that held
//! those could disagree with the allowlist rather than merely name a tool in it.
//! The page sends a tool id and a verb id, and nothing else.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One thing a tool can be asked to do, and what it costs.
///
/// `operation_class` sits on the verb because the consequence of running a
/// command is a property of the command. `gh pr list` and `gh pr merge` travel
/// the same route and are not the same act.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVerb {
    pub id: String,
    pub label: String,
    /// The complete argument list, declared. A caller sends a verb id and never
    /// an argument, so there is no string for a model to extend.
    pub args: Vec<String>,
    pub operation_class: String,
}

/// What a tool offers, one entry per route.
///
/// A tagged enum rather than a struct of options, so a route and the facts it
/// needs arrive together: a handoff cannot exist without an origin allowlist and
/// a command route cannot exist without an executable. The executor therefore
/// never asks "and what if this is missing", which is exactly where an
/// unconstrained URL would get in.
///
/// `rename_all_fields` as well as `rename_all`, because they do different jobs:
/// the first renames the *variants* and the second the struct-variant *fields*.
/// Without the second, `operationClass` goes out as `operation_class`, the
/// payload fails its schema, and the Surface silently renders a fallback — with
/// no compile error and no runtime error. That cost Phase 9 a defect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "route"
)]
pub enum ToolRoute {
    OfficialCli {
        executable: String,
        verbs: Vec<ToolVerb>,
        /// Start it and leave it running, rather than run it and read its
        /// output. The launch case — an editor, an emulator — and the thing that
        /// finally writes the launch correlation Phase 9 left plumbed and empty.
        #[serde(default)]
        detached: bool,
    },
    IsolatedBrowser {
        url: String,
        origins: Vec<String>,
    },
    VisibleHandoff {
        url: String,
        /// Every origin this tool may reach in the person's own browser. The
        /// executor refuses a URL outside it, which is what makes a per-tool
        /// grant narrow in fact rather than only in name.
        origins: Vec<String>,
    },
    Manual {
        steps: Vec<String>,
    },
}

impl ToolRoute {
    /// The wire name, matching `RouteNameSchema` in `@noctis/contracts`.
    pub fn name(&self) -> &'static str {
        match self {
            Self::OfficialCli { .. } => "official_cli",
            Self::IsolatedBrowser { .. } => "isolated_browser",
            Self::VisibleHandoff { .. } => "visible_handoff",
            Self::Manual { .. } => "manual",
        }
    }
}

/// One tool, as data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub id: String,
    pub display_name: String,
    /// What to do by hand. Always present, because `manual` is the terminal
    /// fallback and a fallback with nothing to say is not a fallback.
    pub instructions: String,
    pub routes: Vec<ToolRoute>,
}

impl ToolDescriptor {
    pub fn route(&self, name: &str) -> Option<&ToolRoute> {
        self.routes.iter().find(|route| route.name() == name)
    }

    /// Every verb this tool declares, across its routes.
    pub fn verbs(&self) -> &[ToolVerb] {
        for route in &self.routes {
            if let ToolRoute::OfficialCli { verbs, .. } = route {
                return verbs;
            }
        }

        &[]
    }

    pub fn verb(&self, id: &str) -> Option<&ToolVerb> {
        self.verbs().iter().find(|verb| verb.id == id)
    }

    /// The steps for the terminal fallback: the declared ones, or the
    /// descriptor's own instructions when no `manual` route was written.
    ///
    /// Never empty, which is what makes the fallback total.
    pub fn manual_steps(&self) -> Vec<String> {
        match self.route("manual") {
            Some(ToolRoute::Manual { steps }) if !steps.is_empty() => steps.clone(),
            _ => vec![self.instructions.clone()],
        }
    }
}

/// Why a descriptor was not accepted.
///
/// Separate variants rather than one string, because each is a different thing
/// somebody got wrong and the message that helps is different for each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invalid {
    Id(String),
    Empty(&'static str),
    DuplicateRoute(String),
    DuplicateTool(String),
    NotHttp(String),
    OriginNotAllowed(String),
    BadOrigin(String),
    UnsafeArgument(String),
    NoVerbs,
    UnknownOperationClass(String),
}

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Id(id) => write!(f, "{id} is not a usable tool id"),
            Self::Empty(what) => write!(f, "{what} may not be empty"),
            Self::DuplicateRoute(route) => write!(f, "{route} is declared more than once"),
            Self::DuplicateTool(id) => write!(f, "{id} is declared more than once"),
            Self::NotHttp(url) => write!(f, "{url} is not an http or https URL"),
            Self::OriginNotAllowed(url) => {
                write!(f, "{url} is not covered by its own route's origins")
            }
            Self::BadOrigin(origin) => write!(f, "{origin} is not a bare http or https origin"),
            Self::UnsafeArgument(argument) => {
                write!(f, "{argument} could extend the command line")
            }
            Self::NoVerbs => write!(f, "a command route with no verbs can do nothing"),
            Self::UnknownOperationClass(class) => write!(f, "{class} is not an operation class"),
        }
    }
}

/// The operation classes a verb may name, matching `OperationClassSchema`.
const OPERATION_CLASSES: [&str; 9] = [
    "read_inspect",
    "local_reversible_edit",
    "external_write",
    "message_send",
    "publish",
    "spend",
    "destructive",
    "production_deploy",
    "credential_security",
];

/// Characters that would turn a declared argument into a second command.
const SHELL_METACHARACTERS: [char; 8] = ['&', '|', ';', '`', '$', '<', '>', '\n'];

/// The scheme and host of a URL, without a path — `https://example.com`.
///
/// Hand-rolled rather than pulled in with a URL crate: the shell needs to answer
/// one question about strings it already refuses to accept in any other shape,
/// and a dependency for that is a dependency to keep patched.
///
/// ponytail: prefix parsing, no punycode or default-port normalisation. A URL
/// crate is the upgrade if descriptors ever come from somewhere less trusted
/// than a file only a typed confirmation can write.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;

    if scheme != "http" && scheme != "https" {
        return None;
    }

    let authority = rest.split(['/', '?', '#']).next()?;

    if authority.is_empty() {
        return None;
    }

    Some(format!("{scheme}://{authority}"))
}

/// Whether a URL is one this route is allowed to open.
///
/// The check that makes a per-tool grant narrow in fact. A grant reading "drive
/// my signed-in browser on Vinted" is only true if the executor refuses
/// everything that is not Vinted.
pub fn origin_allows(origins: &[String], url: &str) -> bool {
    origin_of(url).is_some_and(|origin| origins.iter().any(|allowed| allowed == &origin))
}

fn validate_origins(url: &str, origins: &[String]) -> Result<(), Invalid> {
    if origins.is_empty() {
        return Err(Invalid::Empty("a route's origins"));
    }

    for origin in origins {
        if origin_of(origin).as_deref() != Some(origin.as_str()) {
            return Err(Invalid::BadOrigin(origin.clone()));
        }
    }

    if origin_of(url).is_none() {
        return Err(Invalid::NotHttp(url.to_owned()));
    }

    if !origin_allows(origins, url) {
        return Err(Invalid::OriginNotAllowed(url.to_owned()));
    }

    Ok(())
}

/// Everything a descriptor has to satisfy before it is allowed to exist.
///
/// Run on the built-in defaults as well as on the file, so a default cannot be
/// held to a lower standard than something a person wrote — the built-ins are
/// exactly where a mistake would go unnoticed longest.
pub fn validate(descriptor: &ToolDescriptor) -> Result<(), Invalid> {
    if descriptor.id.is_empty()
        || !descriptor
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        || !descriptor
            .id
            .starts_with(|c: char| c.is_ascii_alphanumeric())
    {
        return Err(Invalid::Id(descriptor.id.clone()));
    }

    if descriptor.display_name.trim().is_empty() {
        return Err(Invalid::Empty("displayName"));
    }

    if descriptor.instructions.trim().is_empty() {
        return Err(Invalid::Empty("instructions"));
    }

    let mut seen: HashSet<&str> = HashSet::new();

    for route in &descriptor.routes {
        if !seen.insert(route.name()) {
            return Err(Invalid::DuplicateRoute(route.name().to_owned()));
        }

        match route {
            ToolRoute::OfficialCli {
                executable, verbs, ..
            } => {
                if executable.trim().is_empty() {
                    return Err(Invalid::Empty("executable"));
                }

                if verbs.is_empty() {
                    return Err(Invalid::NoVerbs);
                }

                for verb in verbs {
                    if verb.id.trim().is_empty() || verb.label.trim().is_empty() {
                        return Err(Invalid::Empty("a verb's id or label"));
                    }

                    if !OPERATION_CLASSES.contains(&verb.operation_class.as_str()) {
                        return Err(Invalid::UnknownOperationClass(verb.operation_class.clone()));
                    }

                    for argument in &verb.args {
                        if argument.contains(SHELL_METACHARACTERS) {
                            return Err(Invalid::UnsafeArgument(argument.clone()));
                        }
                    }
                }
            }
            ToolRoute::IsolatedBrowser { url, origins }
            | ToolRoute::VisibleHandoff { url, origins } => validate_origins(url, origins)?,
            ToolRoute::Manual { steps } => {
                if steps.is_empty() {
                    return Err(Invalid::Empty("a manual route's steps"));
                }
            }
        }
    }

    Ok(())
}

/// The file descriptors are read from, beside the window overrides.
pub const TOOLS_FILE: &str = "tools.json";

/// The tools Noctis ships knowing about.
///
/// These exist to prove the routes, not to enumerate the product. Section 12.3's
/// adapters are Phase 11's business, and if adding one needs anything but a row
/// here or in `tools.json`, the router is not general enough. A person may
/// replace any of them by declaring the same id in the file.
pub fn built_in() -> Vec<ToolDescriptor> {
    vec![
        ToolDescriptor {
            id: "vscode".to_owned(),
            display_name: "Visual Studio Code".to_owned(),
            instructions: "Open Visual Studio Code and load the project folder.".to_owned(),
            routes: vec![ToolRoute::OfficialCli {
                executable: "Code.exe".to_owned(),
                detached: true,
                verbs: vec![ToolVerb {
                    id: "open".to_owned(),
                    label: "Open the editor".to_owned(),
                    args: Vec::new(),
                    // Starting an editor writes to nothing and closing it undoes
                    // it, which is the same reading that makes placing a window
                    // reversible. Under an active Objective it therefore opens
                    // without a prompt, which is what focus mode wants.
                    operation_class: "local_reversible_edit".to_owned(),
                }],
            }],
        },
        ToolDescriptor {
            id: "suno".to_owned(),
            display_name: "Suno".to_owned(),
            instructions: "Open Suno and start a new song from the prompt Noctis prepared."
                .to_owned(),
            routes: vec![ToolRoute::VisibleHandoff {
                url: "https://suno.com/create".to_owned(),
                origins: vec!["https://suno.com".to_owned()],
            }],
        },
        ToolDescriptor {
            id: "vinted".to_owned(),
            display_name: "Vinted".to_owned(),
            instructions: "Open Vinted, start a new listing, and paste the draft Noctis prepared."
                .to_owned(),
            routes: vec![ToolRoute::VisibleHandoff {
                url: "https://www.vinted.co.uk/items/new".to_owned(),
                origins: vec!["https://www.vinted.co.uk".to_owned()],
            }],
        },
    ]
}

/// The built-in descriptors, overlaid with whatever `tools.json` holds.
///
/// A file entry with the same id replaces the built-in one entirely rather than
/// merging into it: a half-overridden descriptor would be a descriptor nobody
/// wrote. An invalid entry is dropped with a line in the log and the rest are
/// kept, because one bad row should cost its own tool and not every other.
pub fn load(path: &Path) -> Vec<ToolDescriptor> {
    let mut tools = built_in();

    // The built-ins are validated too. A mistake in one of these would otherwise
    // be the mistake nobody ever looks for.
    tools.retain(|descriptor| match validate(descriptor) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "noctis: built-in tool {} is invalid: {error}",
                descriptor.id
            );
            false
        }
    });

    let Some(declared) = crate::placement::load::<Vec<ToolDescriptor>>(path) else {
        return tools;
    };

    let mut seen: HashSet<String> = HashSet::new();

    for descriptor in declared {
        if let Err(error) = validate(&descriptor) {
            eprintln!("noctis: tool {} was refused: {error}", descriptor.id);
            continue;
        }

        if !seen.insert(descriptor.id.clone()) {
            eprintln!("noctis: {}", Invalid::DuplicateTool(descriptor.id.clone()));
            continue;
        }

        tools.retain(|existing| existing.id != descriptor.id);
        tools.push(descriptor);
    }

    tools.sort_by(|a, b| a.id.cmp(&b.id));
    tools
}

pub fn tools_path(config_dir: &Path) -> PathBuf {
    config_dir.join(TOOLS_FILE)
}

/// Where an executable actually is, or nothing.
///
/// Answers the availability question for the command route: a route naming a
/// program that is not installed must be passed over rather than attempted. It
/// also pins the path, so the process that gets started is the one that was
/// found rather than whatever `PATH` resolves to a moment later.
pub fn resolve_executable(
    name: &str,
    path_var: Option<&str>,
    pathext: Option<&str>,
) -> Option<PathBuf> {
    let candidate = Path::new(name);

    if candidate.components().count() > 1 {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }

    // An extension list, because `Code` and `Code.exe` are the same request on
    // Windows and only one of them is a filename.
    let extensions: Vec<String> = std::iter::once(String::new())
        .chain(
            pathext
                .unwrap_or(".COM;.EXE;.BAT;.CMD")
                .split(';')
                .filter(|part| !part.is_empty())
                .map(str::to_owned),
        )
        .collect();

    for directory in path_var.unwrap_or_default().split(';') {
        if directory.is_empty() {
            continue;
        }

        for extension in &extensions {
            let full = Path::new(directory).join(format!("{name}{extension}"));

            if full.is_file() {
                return Some(full);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(routes: Vec<ToolRoute>) -> ToolDescriptor {
        ToolDescriptor {
            id: "vinted".to_owned(),
            display_name: "Vinted".to_owned(),
            instructions: "Open Vinted by hand.".to_owned(),
            routes,
        }
    }

    fn handoff(url: &str, origins: &[&str]) -> ToolRoute {
        ToolRoute::VisibleHandoff {
            url: url.to_owned(),
            origins: origins.iter().map(|o| (*o).to_owned()).collect(),
        }
    }

    #[test]
    fn accepts_a_tool_that_offers_nothing_but_instructions() {
        assert_eq!(validate(&descriptor(Vec::new())), Ok(()));
    }

    /// THE GATE: the origin allowlist is what makes a per-tool grant narrow in
    /// fact. "Drive my signed-in browser on Vinted" is only true if a URL
    /// somewhere else is refused.
    #[test]
    fn refuses_a_url_its_own_origins_do_not_cover() {
        assert_eq!(
            validate(&descriptor(vec![handoff(
                "https://suno.com/create",
                &["https://www.vinted.co.uk"]
            )])),
            Err(Invalid::OriginNotAllowed(
                "https://suno.com/create".to_owned()
            ))
        );
    }

    #[test]
    fn refuses_a_url_that_is_not_http() {
        for url in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "noctis://open",
        ] {
            assert!(
                validate(&descriptor(vec![handoff(url, &[url])])).is_err(),
                "accepted {url}"
            );
        }
    }

    /// A path or a query string in the allowlist would let one entry cover far
    /// more than it appears to, because the comparison is against the origin.
    #[test]
    fn refuses_an_origin_that_is_not_bare() {
        assert!(validate(&descriptor(vec![handoff(
            "https://www.vinted.co.uk/items/new",
            &["https://www.vinted.co.uk/items"]
        )]))
        .is_err());
    }

    /// THE GATE: a lookalike host must not inherit a grant. This is the check
    /// that stops `vinted.co.uk.evil.example` reading as Vinted.
    #[test]
    fn does_not_let_a_lookalike_host_inherit_the_grant() {
        let origins = vec!["https://www.vinted.co.uk".to_owned()];

        assert!(origin_allows(
            &origins,
            "https://www.vinted.co.uk/items/new"
        ));
        assert!(!origin_allows(
            &origins,
            "https://www.vinted.co.uk.evil.example/items/new"
        ));
        assert!(!origin_allows(
            &origins,
            "http://www.vinted.co.uk/items/new"
        ));
        assert!(!origin_allows(
            &origins,
            "https://evil.example/?https://www.vinted.co.uk"
        ));
    }

    /// THE GATE: arguments are declared, never composed. A verb whose args could
    /// carry a metacharacter would be a command line a caller could extend.
    #[test]
    fn refuses_an_argument_that_could_extend_the_command_line() {
        for argument in ["pr list && rm -rf /", "$(whoami)", "a|b", "a;b", "a>b"] {
            let route = ToolRoute::OfficialCli {
                executable: "gh".to_owned(),
                detached: false,
                verbs: vec![ToolVerb {
                    id: "x".to_owned(),
                    label: "X".to_owned(),
                    args: vec![argument.to_owned()],
                    operation_class: "read_inspect".to_owned(),
                }],
            };

            assert!(
                validate(&descriptor(vec![route])).is_err(),
                "accepted {argument}"
            );
        }
    }

    #[test]
    fn refuses_a_verb_whose_operation_class_is_not_one() {
        let route = ToolRoute::OfficialCli {
            executable: "gh".to_owned(),
            detached: false,
            verbs: vec![ToolVerb {
                id: "x".to_owned(),
                label: "X".to_owned(),
                args: Vec::new(),
                operation_class: "harmless".to_owned(),
            }],
        };

        assert_eq!(
            validate(&descriptor(vec![route])),
            Err(Invalid::UnknownOperationClass("harmless".to_owned()))
        );
    }

    #[test]
    fn refuses_two_routes_of_the_same_name() {
        assert!(validate(&descriptor(vec![
            ToolRoute::Manual {
                steps: vec!["one".to_owned()]
            },
            ToolRoute::Manual {
                steps: vec!["two".to_owned()]
            },
        ]))
        .is_err());
    }

    #[test]
    fn refuses_an_id_that_is_not_a_plain_slug() {
        for id in ["", "../etc", "Vinted", "vin ted", "-leading"] {
            let mut candidate = descriptor(Vec::new());
            candidate.id = id.to_owned();

            assert!(validate(&candidate).is_err(), "accepted {id}");
        }
    }

    /// THE GATE: every built-in has to pass the same validation a person's file
    /// does. A default held to a lower standard is where a mistake lives longest.
    #[test]
    fn every_built_in_tool_is_valid() {
        for tool in built_in() {
            assert_eq!(validate(&tool), Ok(()), "{} is invalid", tool.id);
        }
    }

    /// The terminal fallback must always have something to say, including for a
    /// tool that never declared a manual route.
    #[test]
    fn always_has_manual_steps_to_fall_back_to() {
        for tool in built_in() {
            assert!(!tool.manual_steps().is_empty(), "{} has no steps", tool.id);
        }

        assert_eq!(
            descriptor(Vec::new()).manual_steps(),
            vec!["Open Vinted by hand.".to_owned()]
        );
    }

    /// The wire spelling the router and the Surface both read. A rename here
    /// without one there is a route that silently never matches.
    #[test]
    fn spells_every_route_the_way_the_contract_reads_it() {
        assert_eq!(ToolRoute::Manual { steps: Vec::new() }.name(), "manual");
        assert_eq!(
            handoff("https://suno.com/x", &["https://suno.com"]).name(),
            "visible_handoff"
        );
        assert_eq!(
            ToolRoute::IsolatedBrowser {
                url: "https://suno.com/x".to_owned(),
                origins: Vec::new()
            }
            .name(),
            "isolated_browser"
        );
        assert_eq!(
            ToolRoute::OfficialCli {
                executable: "gh".to_owned(),
                verbs: Vec::new(),
                detached: false
            }
            .name(),
            "official_cli"
        );
    }

    /// THE GATE: `rename_all` renames variants, `rename_all_fields` renames
    /// struct-variant fields. Only having the first sends `operation_class`
    /// where the contract expects `operationClass`, which fails no test in Rust
    /// and renders a fallback in the page.
    #[test]
    fn spells_every_field_the_way_the_contract_reads_it() {
        let route = ToolRoute::OfficialCli {
            executable: "gh".to_owned(),
            detached: true,
            verbs: vec![ToolVerb {
                id: "x".to_owned(),
                label: "X".to_owned(),
                args: Vec::new(),
                operation_class: "read_inspect".to_owned(),
            }],
        };

        let json = serde_json::to_string(&route).expect("serialisable");

        assert!(json.contains("\"route\":\"official_cli\""), "{json}");
        assert!(json.contains("\"operationClass\""), "{json}");
        assert!(!json.contains("operation_class"), "{json}");
    }

    #[test]
    fn finds_a_verb_by_id_and_refuses_one_it_does_not_have() {
        let tool = ToolDescriptor {
            id: "gh".to_owned(),
            display_name: "GitHub".to_owned(),
            instructions: "Use the website.".to_owned(),
            routes: vec![ToolRoute::OfficialCli {
                executable: "gh".to_owned(),
                detached: false,
                verbs: vec![ToolVerb {
                    id: "pr_list".to_owned(),
                    label: "List".to_owned(),
                    args: vec!["pr".to_owned(), "list".to_owned()],
                    operation_class: "read_inspect".to_owned(),
                }],
            }],
        };

        assert!(tool.verb("pr_list").is_some());
        assert!(tool.verb("pr_merge").is_none());
    }

    #[test]
    fn resolves_an_executable_on_the_path_by_extension() {
        let directory = std::env::temp_dir().join("noctis-tool-registry-test");
        std::fs::create_dir_all(&directory).expect("a directory");
        let executable = directory.join("noctis-fake-tool.exe");
        std::fs::write(&executable, b"not really").expect("a file");

        let found = resolve_executable(
            "noctis-fake-tool",
            Some(directory.to_str().expect("utf-8")),
            Some(".EXE"),
        );

        // Compared case-insensitively, because `PATHEXT` is conventionally
        // upper case and the file on disk is not — and Windows treats the two
        // as the same file, which is the behaviour that matters here.
        assert_eq!(
            found.map(|path| path.to_string_lossy().to_lowercase()),
            Some(executable.to_string_lossy().to_lowercase())
        );
        assert_eq!(
            resolve_executable(
                "noctis-absent-tool",
                Some(directory.to_str().expect("utf-8")),
                Some(".EXE")
            ),
            None
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    /// A path is taken literally rather than searched for, and a path to
    /// nothing resolves to nothing rather than to a bare name on the `PATH`.
    #[test]
    fn does_not_fall_back_to_the_path_for_an_executable_given_as_a_path() {
        assert_eq!(
            resolve_executable(
                "C:/definitely/not/here/Code.exe",
                Some("C:/Windows/System32"),
                Some(".EXE")
            ),
            None
        );
    }
}
