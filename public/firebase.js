import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const isLocalhost = ["localhost", "127.0.0.1"].includes(location.hostname);

// Firebase Hosting serves this reserved URL with the project's real web app
// config, so we never have to hardcode it here.
const firebaseConfig = await fetch("/__/firebase/init.json").then((res) => res.json());

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

if (isLocalhost) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// Every visitor (voter or poll creator) is signed in anonymously; their uid
// is what security rules use to tell voters and the poll's creator apart.
export function waitForUser() {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsubscribe();
          resolve(user);
        } else {
          signInAnonymously(auth).catch(reject);
        }
      },
      reject,
    );
  });
}
