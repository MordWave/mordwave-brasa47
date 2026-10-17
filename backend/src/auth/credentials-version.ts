// The `cv` claim of a JWT: the credentials version (users.credentials_version) the token was issued for.
//
// Tokens issued before the claim existed have no `cv`; they are read as version 0, which is what every existing user
// has — so deploying this does not log anybody out. A claim that IS present but is not a non-negative safe integer
// (a string, a float, a negative number, null, ...) is malformed and the token is refused. Tokens are signed by this
// server, so a malformed claim can only come from a bug or a forged-and-signed token; either way it is never "fixed up".
//
// This function only READS the claim. The decision lives in JwtStrategy, which compares it with the user's current row:
// the database is the source of truth, nothing the client sends is trusted on its own.
export function readTokenCredentialsVersion(claim: unknown): number | null {
  if (claim === undefined) return 0;
  if (typeof claim !== 'number' || !Number.isSafeInteger(claim) || claim < 0) return null;
  return claim;
}
