//! Connect-URL parsing (§24.3, §28.2).
//!
//! The shell is just another App. D device: it needs a base URL, a token, and
//! a device name, and the QR the service prints carries all three. Parsing it
//! here — rather than asking the user to copy three fields — is the whole
//! reason the QR exists.
//!
//! The token rides the URL *fragment*, which browsers never send to a server.
//! That is also why this parser exists at all: nothing upstream ever sees the
//! value, so the shell has to read it out itself.

use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Connection {
    /// Origin only — scheme, host, port. No path, no fragment.
    pub base_url: String,
    pub token: String,
    pub device: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConnectError {
    NotAUrl,
    NoToken,
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::NotAUrl => write!(f, "that does not look like a URL"),
            ConnectError::NoToken => write!(
                f,
                "no #connect= token in that URL — scan the QR the service printed, \
                 or paste the whole line under it"
            ),
        }
    }
}

/// Parse `<base>/#connect=<token>&device=<name>` into its three parts.
pub fn parse_connect_url(input: &str) -> Result<Connection, ConnectError> {
    let trimmed = input.trim();
    let parsed = Url::parse(trimmed).map_err(|_| ConnectError::NotAUrl)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ConnectError::NotAUrl);
    }
    let fragment = parsed.fragment().ok_or(ConnectError::NoToken)?;

    let mut token = None;
    let mut device = None;
    for pair in fragment.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let decoded = percent_decode(value);
        match key {
            "connect" => token = Some(decoded),
            "device" => device = Some(decoded),
            _ => {}
        }
    }
    let token = token
        .filter(|t| !t.is_empty())
        .ok_or(ConnectError::NoToken)?;

    let mut base = parsed.clone();
    base.set_fragment(None);
    base.set_query(None);
    base.set_path("");
    Ok(Connection {
        base_url: base.as_str().trim_end_matches('/').to_string(),
        token,
        // A device name is a label; the token is what authenticates, so a URL
        // without one still connects rather than being refused.
        device: device
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "desktop".to_string()),
    })
}

/// The URL the window loads to hand the page its token (§24.3).
///
/// The chat UI reads the fragment on load, stores the token, and strips it
/// from the address bar — so the shell hands the token over exactly the way a
/// scanned QR does, and there is one code path in the page rather than two.
pub fn window_url(connection: &Connection) -> String {
    format!(
        "{}/#connect={}&device={}",
        connection.base_url,
        percent_encode(&connection.token),
        percent_encode(&connection.device)
    )
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_qr_payload() {
        let c = parse_connect_url("http://192.168.0.5:7787/#connect=abc123&device=laptop").unwrap();
        assert_eq!(c.base_url, "http://192.168.0.5:7787");
        assert_eq!(c.token, "abc123");
        assert_eq!(c.device, "laptop");
    }

    #[test]
    fn keeps_https_and_drops_path_and_query() {
        let c =
            parse_connect_url("https://turminder.example.net/chat?x=1#connect=t&device=d").unwrap();
        assert_eq!(c.base_url, "https://turminder.example.net");
    }

    #[test]
    fn defaults_the_device_name_but_never_the_token() {
        let c = parse_connect_url("http://localhost:7787/#connect=t").unwrap();
        assert_eq!(c.device, "desktop");
        assert_eq!(
            parse_connect_url("http://localhost:7787/"),
            Err(ConnectError::NoToken)
        );
        assert_eq!(
            parse_connect_url("http://localhost:7787/#connect=&device=d"),
            Err(ConnectError::NoToken)
        );
    }

    #[test]
    fn decodes_percent_escapes() {
        let c = parse_connect_url("http://h:1/#connect=a%2Bb&device=my%20laptop").unwrap();
        assert_eq!(c.token, "a+b");
        assert_eq!(c.device, "my laptop");
    }

    #[test]
    fn refuses_what_is_not_a_url() {
        assert_eq!(parse_connect_url("hello"), Err(ConnectError::NotAUrl));
        assert_eq!(
            parse_connect_url("file:///etc/passwd#connect=t"),
            Err(ConnectError::NotAUrl)
        );
    }

    #[test]
    fn round_trips_into_a_window_url() {
        let c = parse_connect_url("http://h:7787/#connect=tok&device=my%20laptop").unwrap();
        assert_eq!(
            window_url(&c),
            "http://h:7787/#connect=tok&device=my%20laptop"
        );
        // And the page will strip it again, which is what makes this safe to
        // put in a window URL at all (§24.3).
        assert_eq!(parse_connect_url(&window_url(&c)).unwrap(), c);
    }
}
