// Called after the authenticated decision endpoint rejects a late request for changes.
export async function saveLateFeedback(storage, draftId, reviewer, reason) {
  const text = reason.trim();
  if (!text || text.length > 160) return;
  const bytes = new TextEncoder().encode(JSON.stringify([reviewer, text]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const key = "late-feedback:" + encodeURIComponent(draftId) + ":" + hash;
  await storage.transaction(async tx => {
    if (!await tx.get(key)) await tx.put(key, {text, at: Date.now()});
  });
}

export async function readLateFeedback(storage, draftId) {
  const rows = await storage.list({prefix: "late-feedback:" + encodeURIComponent(draftId) + ":"});
  return [...rows.values()].sort((a, b) => a.at - b.at);
}

// An exact retry may continue the original revision. Another reviewer's comment is history only.
export function isAdditionalDecline(record, reviewer, reason) {
  return record?.status === "declined" &&
    (record.decidedBy !== reviewer || record.reason !== reason);
}
