/**
 * Vertex AI auth via Application Default Credentials (ADC).
 *
 * Uses `google-auth-library`, which resolves credentials from (in order):
 *   1. GOOGLE_APPLICATION_CREDENTIALS — a service-account key file, if set.
 *   2. The well-known ADC file written by
 *      `gcloud auth application-default login` (~/.config/gcloud/...).
 *   3. The attached service account / metadata server (when running on GCP).
 *
 * This keeps us KEYLESS where service-account keys are blocked by org policy
 * (`iam.disableServiceAccountKeyCreation`): a developer runs
 * `gcloud auth application-default login` and the same code works unchanged on
 * GCP (Cloud Run/GCE) via the attached identity. The library caches + refreshes
 * the access token; credentials are read ONLY server-side, never on the device.
 */
import { GoogleAuth } from 'google-auth-library';

let auth: GoogleAuth | null = null;

function client(): GoogleAuth {
  auth ??= new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  return auth;
}

/** A valid Google OAuth2 access token for the `cloud-platform` scope. */
export async function getVertexAccessToken(): Promise<string> {
  const token = await client().getAccessToken();
  if (!token) {
    throw new Error(
      'Vertex: could not obtain an access token. Run `gcloud auth application-default login` ' +
        '(and `gcloud auth application-default set-quota-project <project>`), or set ' +
        'GOOGLE_APPLICATION_CREDENTIALS to a service-account key.',
    );
  }
  return token;
}
