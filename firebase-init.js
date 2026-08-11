// ============================================================
// firebase-init.js
// Firebase setup + authentication for the D&D campaign site.
// Load this as a <script type="module"> BEFORE your main app script.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// -----------------------------------------------------------
// PASTE YOUR OWN CONFIG HERE.
// Get this from: Firebase Console -> Project Settings -> General
// -> "Your apps" -> Web app -> SDK setup and configuration.
// It's safe for this to be visible in client-side code; access
// control is enforced by Firestore Security Rules, not by hiding
// these values.
// -----------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyDRDxS3cMsm4uwFsnjiIKWno2h2nZTqlEc",
  authDomain: "dnd-webpage.firebaseapp.com",
  projectId: "dnd-webpage",
  storageBucket: "dnd-webpage.firebasestorage.app",
  messagingSenderId: "143342986806",
  appId: "1:143342986806:web:c43f12e49c20b5eabb5a97"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

let currentUser = null;
let authReadyResolve;
export const authReady = new Promise(res => { authReadyResolve = res; });

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  authReadyResolve(user);
  if (window.onAuthChanged) window.onAuthChanged(user);
});

export function getCurrentUser() {
  return currentUser;
}

// ---- Sign in / sign up / sign out ----

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return { ok: true, user: result.user };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function signUpWithEmail(email, password) {
  try {
    const result = await createUserWithEmailAndPassword(auth, email, password);
    return { ok: true, user: result.user };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function signInWithEmail(email, password) {
  try {
    const result = await signInWithEmailAndPassword(auth, email, password);
    return { ok: true, user: result.user };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function resetPassword(email) {
  try {
    await sendPasswordResetEmail(auth, email);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function signOutUser() {
  await signOut(auth);
}
