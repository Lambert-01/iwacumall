import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client();

/** Verify Google's signed ID token and restrict it to our configured clients. */
export async function verifyGoogleIdToken(idToken, audiences) {
  if (!Array.isArray(audiences) || audiences.length === 0) {
    throw new Error('Google Sign-In is not configured');
  }
  const ticket = await client.verifyIdToken({ idToken, audience: audiences });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('Google identity is missing a verified email');
  }
  return {
    googleSub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name || payload.given_name || payload.email.split('@')[0],
  };
}
