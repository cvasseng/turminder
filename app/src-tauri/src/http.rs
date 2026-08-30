//! The shell's hand-written HTTP (§28.2).
//!
//! The shell makes four kinds of request: prove a device token against
//! `/api/whoami`, ask a just-spawned sidecar whether it is up yet, and — since
//! voice (§28.6) — push an utterance to `POST /api/voice` and pull a spoken
//! delivery from `POST /api/speak`. An HTTP client crate for four requests
//! would be a dependency, a TLS story and a supply chain, so this is a
//! TcpStream and a format string instead.
//!
//! Plaintext only, deliberately and visibly: `https` means TLS means a client
//! crate. That is why a `https://` connect link is refused rather than
//! half-supported (LIMITS.md, §28).
//!
//! The voice route is the one that needs more than "read it all and parse":
//! the reply is `audio/wav` in **chunked** transfer encoding, produced sentence
//! by sentence (§33.2), and the whole latency argument collapses if the shell
//! waits for the last byte before it starts playing. So `post` takes an
//! optional sink and feeds it decoded chunks as they land.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[derive(Debug, Default)]
pub struct Response {
    pub status: u16,
    /// Lower-cased names, in the order they arrived.
    pub headers: Vec<(String, String)>,
    /// Empty when the body went to a sink instead.
    pub body: Vec<u8>,
}

impl Response {
    /// The body as text — what every JSON route wants.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).trim().to_string()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// `GET url`, with an optional bearer token.
///
/// The request line comes from the URL's own path — an earlier version parsed
/// the URL for its host and then hardcoded the path, which worked only because
/// it had exactly one caller.
pub fn get(url: &str, token: Option<&str>, timeout: Duration) -> Result<Response, String> {
    request("GET", url, token, None, timeout, None, None)
}

/// What a request body is: bytes and what they are.
pub struct Body<'a> {
    pub content_type: &'a str,
    pub bytes: &'a [u8],
}

/// Where a streamed response body goes, piece by piece as it arrives. Named
/// because the type spelled out at three call sites is unreadable.
pub type Sink<'a> = &'a mut dyn FnMut(&[u8]);

/// Told the status and headers the moment they land, before a byte of body.
///
/// `/api/voice` puts the transcript in a header and then spends seconds
/// streaming speech (§33.2). Without this the caller learns what was heard
/// when the reply has finished playing, which is far too late to be the
/// feedback it is for.
pub type OnHead<'a> = &'a mut dyn FnMut(&Response);

/// `POST url`, with an optional bearer token and an optional sink.
///
/// With a sink, a 2xx body is handed over as it arrives and `Response.body`
/// comes back empty — that is how a spoken reply starts playing before the
/// service has finished writing it (§33.2). A non-2xx body is always buffered
/// whatever the sink says: an error is small, it is JSON, and the caller needs
/// to read it rather than play it.
pub fn post(
    url: &str,
    token: Option<&str>,
    body: Body<'_>,
    timeout: Duration,
    sink: Option<Sink<'_>>,
) -> Result<Response, String> {
    request("POST", url, token, Some(body), timeout, sink, None)
}

/// `post`, and told the headers as soon as they arrive rather than at the end.
pub fn post_watching_head(
    url: &str,
    token: Option<&str>,
    body: Body<'_>,
    timeout: Duration,
    sink: Option<Sink<'_>>,
    on_head: OnHead<'_>,
) -> Result<Response, String> {
    request("POST", url, token, Some(body), timeout, sink, Some(on_head))
}

fn request(
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<Body<'_>>,
    timeout: Duration,
    mut sink: Option<Sink<'_>>,
    on_head: Option<OnHead<'_>>,
) -> Result<Response, String> {
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

    let stream = TcpStream::connect((host, port)).map_err(|e| explain_connect(host, port, &e))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let framing = match &body {
        Some(b) => format!(
            "Content-Type: {}\r\nContent-Length: {}\r\n",
            b.content_type,
            b.bytes.len()
        ),
        None => String::new(),
    };
    let head = format!(
        "{method} {target} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth}{framing}\
         Connection: close\r\nAccept: */*\r\n\r\n"
    );

    let mut writer = &stream;
    writer
        .write_all(head.as_bytes())
        .map_err(|e| e.to_string())?;
    if let Some(b) = &body {
        writer.write_all(b.bytes).map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(&stream);
    let mut response = read_head(&mut reader)?;
    if let Some(told) = on_head {
        told(&response);
    }
    let chunked = response
        .header("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let length = response
        .header("content-length")
        .and_then(|v| v.trim().parse::<usize>().ok());

    // A sink is for audio, and audio only comes back on success.
    let streaming = sink.is_some() && (200..300).contains(&response.status);
    let mut collect = |bytes: &[u8], response: &mut Response| {
        if streaming {
            if let Some(sink) = sink.as_mut() {
                sink(bytes);
            }
        } else {
            response.body.extend_from_slice(bytes);
        }
    };

    if chunked {
        read_chunked(&mut reader, |bytes| collect(bytes, &mut response))?;
    } else {
        read_to_end(&mut reader, length, |bytes| collect(bytes, &mut response))?;
    }
    Ok(response)
}

/// What a failed TCP connect means to a person.
///
/// `std::io::Error`'s own words are the kernel's — *"Connection refused (os
/// error 111)"* — and the person reading them pasted a link into a box. The
/// address goes in the message because "is the service running" and "is that
/// the right address" are the two questions, and neither is answerable without
/// seeing what was actually dialled.
fn explain_connect(host: &str, port: u16, e: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::ConnectionRefused => format!(
            "nothing is listening on {host}:{port} — check the assistant is running there, \
             and that the link has the port it is actually bound to"
        ),
        ErrorKind::TimedOut => format!(
            "{host}:{port} did not answer — check the address, and that a firewall is not \
             in the way"
        ),
        _ => match e.raw_os_error() {
            // EHOSTUNREACH / ENETUNREACH: the route, not the service.
            Some(113) | Some(101) => format!("{host} cannot be reached from this machine"),
            _ => format!("cannot reach {host}:{port}: {e}"),
        },
    }
}

/// Status line and headers, up to the blank line.
fn read_head(reader: &mut BufReader<&TcpStream>) -> Result<Response, String> {
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("the service sent no status line")?;
    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        let read = reader.read_line(&mut header).map_err(|e| e.to_string())?;
        if read == 0 || header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    Ok(Response {
        status,
        headers,
        body: Vec::new(),
    })
}

/// Chunked transfer encoding, decoded as it arrives — the framing bytes are
/// the server's, not the audio's, and a player handed them hears a click.
fn read_chunked(
    reader: &mut BufReader<&TcpStream>,
    mut emit: impl FnMut(&[u8]),
) -> Result<(), String> {
    loop {
        let mut size_line = String::new();
        if reader
            .read_line(&mut size_line)
            .map_err(|e| e.to_string())?
            == 0
        {
            return Ok(()); // the peer hung up mid-stream; what we have is what we got
        }
        let size_text = size_line.trim();
        if size_text.is_empty() {
            continue;
        }
        // A chunk extension rides after a `;` and nobody here has a use for one.
        let size_text = size_text.split(';').next().unwrap_or(size_text);
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| format!("bad chunk size \"{size_text}\""))?;
        if size == 0 {
            return Ok(());
        }
        let mut chunk = vec![0u8; size];
        reader.read_exact(&mut chunk).map_err(|e| e.to_string())?;
        emit(&chunk);
        // The CRLF that terminates the chunk.
        let mut crlf = [0u8; 2];
        let _ = reader.read_exact(&mut crlf);
    }
}

/// Everything left, in pieces, so a sink sees it as it arrives rather than at
/// the end. `Connection: close` means EOF is the end when there is no length.
fn read_to_end(
    reader: &mut BufReader<&TcpStream>,
    length: Option<usize>,
    mut emit: impl FnMut(&[u8]),
) -> Result<(), String> {
    let mut buffer = [0u8; 8192];
    let mut seen = 0usize;
    loop {
        if length.is_some_and(|n| seen >= n) {
            return Ok(());
        }
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            // A read timeout after some bytes is a stream that stalled, not a
            // failed request: keep what arrived.
            Err(_) if seen > 0 => return Ok(()),
            Err(e) => return Err(e.to_string()),
        };
        seen += read;
        emit(&buffer[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_address_says_which_address_and_what_to_check() {
        // Somebody pasted a link into a box; "Connection refused (os error
        // 111)" is the kernel talking to the wrong audience.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener); // nothing is there now
        let e = get(
            &format!("http://127.0.0.1:{port}/api/whoami"),
            None,
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert!(e.contains(&format!("127.0.0.1:{port}")), "{e}");
        assert!(e.contains("nothing is listening"), "{e}");
        assert!(!e.contains("os error"), "{e}");
    }

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
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}",
                )
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
        assert_eq!(response.text(), "{\"ok\":true}");
        let request = seen.join().unwrap();
        assert!(request.starts_with("GET /healthz HTTP/1.1"), "{request}");
        assert!(request.contains("Authorization: Bearer tok"), "{request}");
    }

    /// A one-shot listener that replies with `reply` and hands back what it
    /// was sent — the shape the `get()` tests already use, reused because a
    /// hand-rolled client is only really tested against a real socket.
    fn one_shot(reply: &'static [u8]) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            // Read until the body is in: `Content-Length` says how much.
            loop {
                let n = socket.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).into_owned();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let want = head
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= want {
                        break;
                    }
                }
            }
            socket.write_all(reply).unwrap();
            request
        });
        (port, seen)
    }

    #[test]
    fn posts_a_binary_body_and_reads_the_headers_back() {
        let (port, seen) = one_shot(
            b"HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\n              X-Turminder-Transcript: UTF-8''hei\r\nContent-Length: 4\r\n\r\nRIFF",
        );
        let response = post(
            &format!("http://127.0.0.1:{port}/api/voice"),
            Some("tok"),
            Body {
                content_type: "audio/wav",
                bytes: &[0xDE, 0xAD, 0xBE, 0xEF],
            },
            Duration::from_secs(5),
            None,
        )
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"RIFF");
        // Header names are lower-cased so a caller does not have to guess the
        // server's capitalisation.
        assert_eq!(
            response.header("x-turminder-transcript"),
            Some("UTF-8''hei")
        );
        assert_eq!(response.header("content-type"), Some("audio/wav"));

        let request = seen.join().unwrap();
        let text = String::from_utf8_lossy(&request).into_owned();
        assert!(text.starts_with("POST /api/voice HTTP/1.1"), "{text}");
        assert!(text.contains("Content-Type: audio/wav"), "{text}");
        assert!(text.contains("Content-Length: 4"), "{text}");
        assert!(text.contains("Authorization: Bearer tok"), "{text}");
        assert!(request.ends_with(&[0xDE, 0xAD, 0xBE, 0xEF]), "body missing");
    }

    #[test]
    fn decodes_a_chunked_reply_into_the_sink_as_it_arrives() {
        // The voice route answers chunked and sentence by sentence (§33.2).
        // The framing bytes are the server's, not the audio's — a player handed
        // "1a\r\n" hears a click.
        let (port, _seen) = one_shot(
            b"HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nTransfer-Encoding: chunked\r\n\r\n              4\r\nRIFF\r\n6\r\nWAVEfm\r\n0\r\n\r\n",
        );
        let mut pieces: Vec<Vec<u8>> = Vec::new();
        let mut sink = |bytes: &[u8]| pieces.push(bytes.to_vec());
        let response = post(
            &format!("http://127.0.0.1:{port}/api/voice"),
            None,
            Body {
                content_type: "audio/wav",
                bytes: b"x",
            },
            Duration::from_secs(5),
            Some(&mut sink),
        )
        .unwrap();
        assert_eq!(response.status, 200);
        // Streamed, not buffered: the body stays empty on purpose.
        assert!(response.body.is_empty());
        assert_eq!(pieces, vec![b"RIFF".to_vec(), b"WAVEfm".to_vec()]);
    }

    #[test]
    fn the_headers_arrive_before_the_body_does() {
        // The transcript rides a header and the speech takes seconds (§33.2).
        // A caller told at the end has been told too late to say anything.
        let (port, _seen) = one_shot(
            b"HTTP/1.1 200 OK\r\nX-Turminder-Transcript: UTF-8''hei\r\n              Transfer-Encoding: chunked\r\n\r\n4\r\nRIFF\r\n0\r\n\r\n",
        );
        // One shared log, because what is under test is the *order* of two
        // callbacks — which needs both of them writing to the same place.
        let order: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        {
            let body_log = order.clone();
            let mut sink = |bytes: &[u8]| {
                body_log
                    .lock()
                    .unwrap()
                    .push(format!("body {}", bytes.len()));
            };
            let head_log = order.clone();
            let mut head = |r: &Response| {
                head_log.lock().unwrap().push(format!(
                    "head {}",
                    r.header("x-turminder-transcript").unwrap_or("?")
                ));
            };
            post_watching_head(
                &format!("http://127.0.0.1:{port}/api/voice"),
                None,
                Body {
                    content_type: "audio/wav",
                    bytes: b"x",
                },
                Duration::from_secs(5),
                Some(&mut sink),
                &mut head,
            )
            .unwrap();
        }
        assert_eq!(
            *order.lock().unwrap(),
            vec!["head UTF-8''hei".to_string(), "body 4".to_string()]
        );
    }

    #[test]
    fn buffers_an_error_body_even_when_a_sink_was_offered() {
        // A `422 nothing_heard` is JSON and small, and the caller has to read
        // it rather than play it (§33.2).
        let (port, _seen) = one_shot(
            b"HTTP/1.1 422 Unprocessable Entity\r\nContent-Type: application/json\r\n              Content-Length: 28\r\n\r\n{\"error\":\"nothing_heard\"}",
        );
        let mut played = 0usize;
        let mut sink = |bytes: &[u8]| played += bytes.len();
        let response = post(
            &format!("http://127.0.0.1:{port}/api/voice"),
            None,
            Body {
                content_type: "audio/wav",
                bytes: b"x",
            },
            Duration::from_secs(5),
            Some(&mut sink),
        )
        .unwrap();
        assert_eq!(response.status, 422);
        assert!(
            response.text().contains("nothing_heard"),
            "{}",
            response.text()
        );
        assert_eq!(played, 0, "an error must not reach the speaker");
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
