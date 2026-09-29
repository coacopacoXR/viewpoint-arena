// Re-export from the shared location (lib/auth/verifyJwt.ts).
//
// The room server and its tests import from this path. Keeping the re-export
// here means neither needs to change — the move was for batch BD, which needed
// the same verification in api handlers, and a shared path under lib/auth/
// is where both the room server and the api can reach it.

export { verifyAccessToken, type VerifiedAccount } from '../lib/auth/verifyJwt.ts';
