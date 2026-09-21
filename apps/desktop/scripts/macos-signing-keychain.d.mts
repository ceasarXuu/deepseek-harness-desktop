/** Own a temporary PKCS#12 signing identity for one macOS packaging invocation. */

/** One code-signing identity an owned keychain holds. */
export interface MacOSSigningIdentity {
  readonly hash: string
  readonly name: string
}

/**
 * Parse the identities `security find-identity` lists for one keychain.
 * @param listing - `security find-identity -v -p codesigning` output.
 * @returns Identities in listing order.
 */
export function parseSigningIdentities(listing: string): MacOSSigningIdentity[]

/**
 * Import and authorize the required p12 before work; delete the owned keychain after work settles.
 * Children receive only its path, never the p12 password. Existing login keychains are not unlocked.
 * Abrupt process termination requires the CI runner to clean its temporary directory.
 * @param environment Validated platform configuration with local CSC_LINK and CSC_KEY_PASSWORD.
 * @param action All signing work, settled before cleanup.
 * @param run Apple command executor, returning the command's standard output when a caller needs it;
 * `revealOutput` is set only for a command whose arguments carry no secret.
 * @returns Resolves after work and cleanup; rejects on setup, work, or cleanup failure.
 */
export function withMacOSSigningKeychain(
  environment: NodeJS.ProcessEnv,
  action: (environment: NodeJS.ProcessEnv) => Promise<void>,
  run?: (command: string, args: string[], options?: { readonly revealOutput?: boolean }) => string | void,
): Promise<void>
