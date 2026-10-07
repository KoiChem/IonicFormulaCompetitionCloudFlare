const KEY = "ionic-formula-competition:last-nickname";

export function loadSavedNickname(storage: Storage): string {
  try {
    const value = storage.getItem(KEY)?.trim() ?? "";
    return value.length <= 16 ? value : "";
  } catch { return ""; }
}

export function saveNickname(storage: Storage, nickname: string): void {
  const value = nickname.trim();
  if (!value || value.length > 16) return;
  try { storage.setItem(KEY, value); } catch { /* Joining still works when storage is unavailable. */ }
}
