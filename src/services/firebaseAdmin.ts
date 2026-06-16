import { env } from "../config/env";

let messagingInstance: any | null = null;
let initAttempted = false;

function credentialFromEnv() {
  if (env.firebaseServiceAccountJson) {
    return JSON.parse(env.firebaseServiceAccountJson);
  }
  if (env.firebaseProjectId && env.firebaseClientEmail && env.firebasePrivateKey) {
    return {
      projectId: env.firebaseProjectId,
      clientEmail: env.firebaseClientEmail,
      privateKey: env.firebasePrivateKey.replace(/\\n/g, "\n"),
    };
  }
  return null;
}

export function getFirebaseMessaging() {
  if (messagingInstance || initAttempted) return messagingInstance;
  initAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const admin = require("firebase-admin");
    if (!admin.apps?.length) {
      const credential = credentialFromEnv();
      if (!credential) {
        console.warn("[notifications] Firebase credentials missing; FCM disabled");
        return null;
      }
      admin.initializeApp({
        credential: admin.credential.cert(credential),
        projectId: credential.projectId || env.firebaseProjectId,
      });
    }
    messagingInstance = admin.messaging();
    return messagingInstance;
  } catch (error) {
    console.warn("[notifications] firebase-admin unavailable", error instanceof Error ? error.message : error);
    return null;
  }
}
