//! The shell's hand-written HTTP GET (§28.2).
//!
//! The shell makes exactly two kinds of request: prove a device token against
//! `/api/whoami`, and ask a just-spawned sidecar whether it is up yet. An HTTP
//! client crate for two GETs would be a dependency, a TLS story and a supply
//! chain, so this is a TcpStream and a format string instead.
//!
//! Plaintext only, deliberately and visibly: `https` means TLS means a client
//! crate. That is why a `https://` connect link is refused rather than
//! half-supported (LIMITS.md, §28).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

/// `GET url`, with an optional bearer token.
///
/// The request line comes from the URL's own path — an earlier version parsed
/// the URL for its host and then hardcoded the path, which worked only because
/// it had exactly one caller.
pub fn get(url: &str, token: Option<&str>, timeout: Duration) -> Result<Response, String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "http" {
        return Err("https is not supported yet — use a tunnel, or http on your LAN".into());
    }
    let host = parsed.host_str().ok_or("no host in the URL")?;
    let port = parsed.port().unwrap_or(80);
    let target = match parsed.query() {
        Some(q) => format!("{}?{q}", parsed.path()),
        None => parsed.path().to_string(),
    };

    let mut stream = TcpStream::connect((host, port)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "GET {target} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth}\
         Connection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = raw.split_once("\r\n\r\n").ok_or("the service sent no body")?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("the service sent no status line")?;
    Ok(Response {
        status,
        body: body.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_https_rather_than_pretending() {
        let e = get("https://example.net/healthz", None, Duration::from_secs(1)).unwrap_err();
        assert!(e.contains("https is not supported"), "{e}");
    }

    #[test]
    fn reads_the_status_line_and_body_of_a_real_response() {
        // A one-shot listener is a truer test of a hand-rolled client than any
        // amount of string parsing: this asserts the request line it *sends*
        // carries the URL's own path, which is the bug this module was born of.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 512];
            let n = socket.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).into_owned();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}")
                .unwrap();
            request
        });
        let response = get(
            &format!("http://127.0.0.1:{port}/healthz"),
            Some("tok"),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "{\"ok\":true}");
        let request = seen.join().unwrap();
        assert!(request.starts_with("GET /healthz HTTP/1.1"), "{request}");
        assert!(request.contains("Authorization: Bearer tok"), "{request}");
    }

    #[test]
    fn a_refusal_is_a_status_not_an_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 512];
            let _ = socket.read(&mut buf);
            let _ = socket.write_all(b"HTTP/1.1 401 Unauthorized\r\n\r\nno");
        });
        let response = get(
            &format!("http://127.0.0.1:{port}/api/whoami"),
            None,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(response.status, 401);
    }
}
