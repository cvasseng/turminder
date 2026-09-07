/**
 * App. A, the print-and-scan half (§34). One module so the numbers the spec
 * names are readable together — a probe budget and a scan budget that drift
 * apart in two files is how "why did that time out" becomes a bisect.
 */

/** One IPP or eSCL metadata call. A device that is awake answers instantly. */
export const PROBE_TIMEOUT_MS = 10_000;

/** How long the mDNS listener stays open before it reports what it heard. */
export const DISCOVERY_WINDOW_MS = 4_000;

/** The `/24` fallback sweep, used only when multicast found nothing (§34.3).
 *  Concurrency counts hosts in flight; each one probes its two ports at once. */
export const SWEEP_CONCURRENCY = 32;
export const SWEEP_TIMEOUT_MS = 400;

/** Submitting one document: a raster over wifi to a printer that is warming up. */
export const JOB_TIMEOUT_MS = 120_000;

/** Pages one `print.document` call may convert — and therefore jobs it may submit. */
export const MAX_PAGES = 50;

/** Live device status, cached in `meta` so a repeated question is not a repeated request. */
export const STATUS_CACHE_MS = 15_000;

/** One eSCL page retrieval. 1200 dpi on a flatbed is genuinely this slow. */
export const SCAN_TIMEOUT_MS = 300_000;

/** Where a pulled scan lands, and the drop folder the shipped handler watches. */
export const DEFAULT_SCAN_DIR = 'scans';
export const DEFAULT_SCAN_INBOX = 'scans/inbox';
