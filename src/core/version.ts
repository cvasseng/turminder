export const VERSION = '0.1.0';

/** Where this thing lives, for the User-Agent it is required to identify with. */
export const REPO_URL = 'https://github.com/turminder/turminder';

/**
 * The identifying `User-Agent` every outbound public API call must carry.
 * MET Norway and Nominatim both answer 403 to a missing or generic UA, and
 * both ask to be told who is calling — so this is politeness with teeth.
 */
export const USER_AGENT = `turminder/${VERSION} ${REPO_URL}`;
