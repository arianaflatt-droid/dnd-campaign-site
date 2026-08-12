// ============================================================
// firestore-storage.js
// Drop-in replacements for the old window.storage-based functions.
// Function names/shapes match the originals as closely as possible
// so the rest of the app's code barely has to change.
//
// Data model:
//   /campaigns/{campaignId}
//        dmEmails: [string]       <- DM signs in with one of these emails
//        playerEmails: [string]   <- players sign in with one of these emails
//        ...other campaign fields (overview, sessions, etc. - kept as-is)
//     /campaigns/{campaignId}/sheets/{sheetId}
//        ownerEmail: string       <- which player controls this sheet
//        ...all existing sheet fields, unchanged
//     /campaigns/{campaignId}/rollLog/{entryId}
//        timestamp, casterName, description
//     /campaigns/{campaignId}/pendingSaves/{saveId}
//        timestamp, casterName, spellName, saveAbility, dc,
//        rolledDamage, dmgType, resolved
// ============================================================

import { db, getCurrentUser } from './firebase-init.js';
import {
  doc, getDoc, setDoc, deleteDoc, collection, addDoc, getDocs,
  query, orderBy, limit, onSnapshot, updateDoc, writeBatch, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let activeCampaignId = null;
export function setActiveCampaign(campaignId) { activeCampaignId = campaignId; }
export function getActiveCampaign() { return activeCampaignId; }

// ---- Creating a new campaign (DM flow) ----

// Avoids visually ambiguous characters (0/O, 1/I/L) since this gets
// read aloud / typed by hand.
const INVITE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateInviteCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i++) code += INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)];
  return code;
}

// Creates a brand-new campaign owned by the current signed-in user, plus
// an invite code players can use to join it. Returns { campaignId, inviteCode }.
// ---- Per-user campaign index (lets someone sign in and find their way
// back to a campaign even if their browser's local cache is gone) ----

// Records that the current user belongs to a campaign, so getMyCampaigns()
// can find it later purely from being signed in — no invite code or cached
// browser data required. Safe to call repeatedly (dedupes by campaignId).
export async function recordMyCampaignMembership(campaignId, campaignName, role) {
  const user = getCurrentUser();
  if (!user) return;
  const ref = doc(db, 'users', user.uid);
  let existing = [];
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) existing = snap.data().campaigns || [];
  } catch (e) { /* no doc yet */ }
  const withoutThis = existing.filter(c => c.campaignId !== campaignId);
  withoutThis.push({ campaignId, name: campaignName, role });
  await setDoc(ref, { campaigns: withoutThis }, { merge: true });
}

// Looks up every campaign the signed-in user is already part of — used by
// the plain "Sign In" path (as opposed to "create new" or "join by code")
// so a returning DM or player can get straight back into their campaign(s)
// without needing an invite code handy or a browser that remembered them.
export async function getMyCampaigns() {
  const user = getCurrentUser();
  if (!user) return [];
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists()) return [];
    return snap.data().campaigns || [];
  } catch (e) {
    return [];
  }
}

export async function createCampaign(campaignName) {
  const user = getCurrentUser();
  if (!user || !user.email) throw new Error('Must be signed in to create a campaign.');
  const email = user.email.toLowerCase();
  const campaignId = 'camp_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  await setDoc(doc(db, 'campaigns', campaignId), {
    name: campaignName,
    dmEmails: [email],
    playerEmails: []
  });
  const inviteCode = generateInviteCode();
  await setDoc(doc(db, 'inviteCodes', inviteCode), { campaignId });
  await recordMyCampaignMembership(campaignId, campaignName, 'dm');
  return { campaignId, inviteCode };
}

// DM: generate a fresh code for an existing campaign (e.g. the old one
// leaked, or you just want a new one for a new player).
export async function createNewInviteCode(campaignId) {
  const inviteCode = generateInviteCode();
  await setDoc(doc(db, 'inviteCodes', inviteCode), { campaignId });
  return inviteCode;
}

// ---- Joining a campaign with an invite code (player flow) ----

// Looks up which campaign a code belongs to. Returns null if the code
// doesn't exist (typo, expired, etc.) — the UI should show a friendly
// "check the code and try again" message in that case.
export async function resolveInviteCode(code) {
  try {
    const snap = await getDoc(doc(db, 'inviteCodes', code.trim().toUpperCase()));
    if (!snap.exists()) return null;
    return snap.data().campaignId;
  } catch (e) {
    return null; // not signed in yet, or code genuinely doesn't exist
  }
}

// Adds the current signed-in user's email to the campaign's playerEmails.
// Safe to call even if they're already a member — the security rule allows
// this to be a harmless no-op in that case, so there's no need to check
// membership first (which a brand-new joiner couldn't do anyway, since
// reading the campaign doc requires being a member already).
export async function joinCampaignAsPlayer(campaignId) {
  const user = getCurrentUser();
  if (!user || !user.email) throw new Error('Must be signed in to join a campaign.');
  const email = user.email.toLowerCase();
  await updateDoc(doc(db, 'campaigns', campaignId), {
    playerEmails: arrayUnion(email)
  });
  let campaignName = 'Campaign';
  try {
    const snap = await getDoc(doc(db, 'campaigns', campaignId));
    if (snap.exists()) campaignName = snap.data().name || campaignName;
  } catch (e) { /* fall back to generic name */ }
  await recordMyCampaignMembership(campaignId, campaignName, 'player');
}

// ---- Role check for the current campaign (call after sign-in) ----
export async function getMyRoleInCampaign(campaignId) {
  const user = getCurrentUser();
  if (!user || !user.email) return null;
  const snap = await getDoc(doc(db, 'campaigns', campaignId));
  if (!snap.exists()) return null;
  const data = snap.data();
  const email = user.email.toLowerCase();
  if ((data.dmEmails || []).map(e => e.toLowerCase()).includes(email)) return 'dm';
  if ((data.playerEmails || []).map(e => e.toLowerCase()).includes(email)) return 'player';
  return null; // signed in, but not authorized for this campaign
}

// ---- Character sheets ----
const sheetCacheFS = {};

export async function loadSheet(sheetId) {
  if (sheetCacheFS[sheetId]) return sheetCacheFS[sheetId];
  try {
    const snap = await getDoc(doc(db, 'campaigns', activeCampaignId, 'sheets', sheetId));
    if (snap.exists()) { sheetCacheFS[sheetId] = snap.data(); return sheetCacheFS[sheetId]; }
  } catch (e) { /* not found */ }
  const blank = blankSheet(); // assumes blankSheet() is defined elsewhere in your app
  sheetCacheFS[sheetId] = blank;
  return blank;
}

export async function saveSheet(sheetId, data) {
  sheetCacheFS[sheetId] = data;
  try {
    await setDoc(doc(db, 'campaigns', activeCampaignId, 'sheets', sheetId), data, { merge: false });
  } catch (e) {
    console.error('Save failed', e);
    throw e;
  }
}

export async function deleteSheetDoc(sheetId) {
  delete sheetCacheFS[sheetId];
  try { await deleteDoc(doc(db, 'campaigns', activeCampaignId, 'sheets', sheetId)); } catch (e) { /* already gone */ }
}

// Live-sync a sheet: calls onUpdate(data) every time it changes,
// including changes made by OTHER people (e.g. DM watching HP live).
export function watchSheet(sheetId, onUpdate) {
  return onSnapshot(doc(db, 'campaigns', activeCampaignId, 'sheets', sheetId), (snap) => {
    if (snap.exists()) { sheetCacheFS[sheetId] = snap.data(); onUpdate(snap.data()); }
  });
}

// ---- Roll log (append-only, one document per entry) ----
export async function pushRollLogEntry(entry) {
  await addDoc(collection(db, 'campaigns', activeCampaignId, 'rollLog'), {
    ...entry,
    timestamp: Date.now()
  });
}

export async function loadRollLog(max = 300) {
  const q = query(collection(db, 'campaigns', activeCampaignId, 'rollLog'), orderBy('timestamp', 'desc'), limit(max));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Real-time roll log: calls onUpdate(entries) instantly whenever
// a new roll is logged by anyone, no polling needed.
export function watchRollLog(onUpdate, max = 300) {
  const q = query(collection(db, 'campaigns', activeCampaignId, 'rollLog'), orderBy('timestamp', 'desc'), limit(max));
  return onSnapshot(q, (snap) => {
    onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function clearRollLog() {
  const snap = await getDocs(collection(db, 'campaigns', activeCampaignId, 'rollLog'));
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// ---- Pending saving throws ----
export async function pushPendingSave(entry) {
  await addDoc(collection(db, 'campaigns', activeCampaignId, 'pendingSaves'), {
    ...entry,
    timestamp: Date.now(),
    resolved: false
  });
}

// Real-time pending saves: DM sees new saves the instant they're cast.
export function watchPendingSaves(onUpdate) {
  const q = query(collection(db, 'campaigns', activeCampaignId, 'pendingSaves'), orderBy('timestamp', 'desc'), limit(100));
  return onSnapshot(q, (snap) => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    onUpdate(all.filter(p => !p.resolved));
  });
}

export async function resolvePendingSave(saveId, resolutionNote) {
  await updateDoc(doc(db, 'campaigns', activeCampaignId, 'pendingSaves', saveId), {
    resolved: true,
    resolutionNote
  });
}

// ---- Campaign metadata (overview, sessions, npcs, maps, docs, store) ----
export async function loadCampaign(campaignId) {
  const snap = await getDoc(doc(db, 'campaigns', campaignId));
  return snap.exists() ? { id: campaignId, ...snap.data() } : null;
}

export async function saveCampaign(campaignId, data) {
  await setDoc(doc(db, 'campaigns', campaignId), data, { merge: true });
}

// Writes ONLY the given top-level fields, leaving everything else on the
// server document exactly as it is — even if the caller's own local copy
// of those other fields is stale. This is what prevents two people editing
// different parts of the same campaign at the same time (e.g. a player
// adding a character while the DM edits Sessions) from clobbering each
// other's work.
export async function saveCampaignFields(campaignId, fields) {
  await updateDoc(doc(db, 'campaigns', campaignId), fields);
}

// ---- DM: authorize a player by email (works before they even sign up) ----
export async function addPlayerEmail(campaignId, email) {
  const snap = await getDoc(doc(db, 'campaigns', campaignId));
  const data = snap.data() || {};
  const list = new Set((data.playerEmails || []).map(e => e.toLowerCase()));
  list.add(email.toLowerCase());
  await updateDoc(doc(db, 'campaigns', campaignId), { playerEmails: Array.from(list) });
}
