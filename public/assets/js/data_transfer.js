/**
 * Local-data export / import.
 *
 * IndexedDB and localStorage are scoped to one browser origin and device. This
 * module provides a portable, offline backup for cached story text, generated
 * narration, reading progress, bookmarks, favourites, and settings.
 *
 * FORMAT (container, not JSON — audio is binary and base64 would add ~33%)
 *
 *   PRBACKUP1\n
 *   <decimal byte length of the manifest>\n
 *   <manifest, UTF-8 JSON>
 *   <audio payloads, concatenated in manifest order>
 *
 * The manifest holds every JSON-safe record inline and describes audio blobs by
 * {offset, length} into the payload region. Export builds one Blob from parts,
 * so the browser keeps it disk-backed instead of assembling it in memory.
 * Import reads only the header and manifest, then File.slice()s each audio
 * payload — slicing does not read the file, so a multi-hundred-megabyte restore
 * never has to fit in RAM.
 *
 * audio_chunks is the only store containing Blobs; the others are treated as
 * JSON-safe and a warning is recorded if that ever stops being true.
 * sync_outbox is deliberately skipped: it is transient per-device state and
 * replaying a stale pending sync on a new origin could resurrect deleted rows.
 */

const DB_NAME = 'PocketReaderDB';
const DB_VERSION = 3;
const MAGIC = 'PRBACKUP1';
const JSON_STORES = ['story_chapters', 'user_profile'];
const BLOB_STORE = 'audio_chunks';

/**
 * localStorage keys that must never leave this device in a backup.
 *
 * A .prbackup is a file the user downloads, keeps and copies between machines.
 * The Supabase session entry holds a live access token AND a refresh token, so
 * exporting it turns a backup into account credentials for anyone who obtains
 * the file. The identity keys are excluded for a different reason: restoring
 * them makes two devices claim the same device id, which then collides in the
 * per-device stats the sync layer keys on.
 *
 * Applied on import as well as export, so a backup written before this existed
 * still cannot re-inject a stale session.
 */
const EXCLUDED_LOCAL_KEYS = new Set([
  'pr_supabase_session_v1',  // access_token + refresh_token
  'pr_device_id',            // per-device identity for statsByDevice
  'pr_profile_owner',        // which account owns this device's local profile
  'pr_sync_outbox',          // transient; replaying it could resurrect deleted rows
]);

const isExportableLocalKey = (key) => typeof key === 'string'
  && key.length > 0
  && !EXCLUDED_LOCAL_KEYS.has(key);

const openDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
  // No onupgradeneeded: storage_core owns the schema. If this runs first on a
  // fresh origin the stores are created empty, which import then fills.
  req.onupgradeneeded = (event) => {
    const db = event.target.result;
    for (const name of [BLOB_STORE, ...JSON_STORES, 'sync_outbox']) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    }
  };
});

const readStore = (db, name) => new Promise((resolve) => {
  if (!db.objectStoreNames.contains(name)) return resolve([]);
  const out = [];
  const req = db.transaction(name, 'readonly').objectStore(name).openCursor();
  req.onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return resolve(out);
    out.push({ key: cursor.key, value: cursor.value });
    cursor.continue();
  };
  req.onerror = () => resolve(out);
});

/**
 * @param {{ includeAudio?: boolean, onProgress?: (msg: string) => void }} options
 * @returns {Promise<{ blob: Blob, summary: object }>}
 */
export async function exportPocketReaderData(options = {}) {
  const { includeAudio = true, onProgress = () => {} } = options;
  const warnings = [];
  const db = await openDb();

  try {
    onProgress('Reading settings…');
    const local = {};
    let excludedKeys = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!isExportableLocalKey(key)) { excludedKeys += 1; continue; }
      local[key] = localStorage.getItem(key);
    }
    if (excludedKeys) {
      warnings.push(`${excludedKeys} device/session key(s) excluded from the backup by design`);
    }

    const stores = {};
    for (const name of JSON_STORES) {
      onProgress(`Reading ${name.replace('_', ' ')}…`);
      const rows = await readStore(db, name);
      stores[name] = rows.filter((row) => {
        try { JSON.stringify(row.value); return true; }
        catch (_) { warnings.push(`skipped non-serialisable ${name} key ${String(row.key)}`); return false; }
      });
    }

    const audioIndex = [];
    const payloads = [];
    let offset = 0;
    if (includeAudio) {
      onProgress('Reading narration audio…');
      const rows = await readStore(db, BLOB_STORE);
      for (const { key, value } of rows) {
        const blob = value?.blob;
        if (!(blob instanceof Blob)) {
          warnings.push(`audio key ${String(key)} had no blob`);
          continue;
        }
        audioIndex.push({
          key,
          offset,
          length: blob.size,
          type: blob.type || 'audio/wav',
          // Preserve the fields eviction and playback rely on.
          isPermanent: !!value.isPermanent,
          timestamp: value.timestamp || 0,
        });
        payloads.push(blob);
        offset += blob.size;
      }
    }

    const manifest = {
      magic: MAGIC,
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      sourceOrigin: location.origin,
      dbVersion: DB_VERSION,
      localStorage: local,
      stores,
      audio: audioIndex,
      audioBytes: offset,
      warnings,
    };

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const header = new TextEncoder().encode(`${MAGIC}\n${manifestBytes.length}\n`);
    const blob = new Blob([header, manifestBytes, ...payloads], { type: 'application/octet-stream' });

    onProgress('Export ready.');
    return {
      blob,
      summary: {
        chapters: stores.story_chapters?.length || 0,
        profileRows: stores.user_profile?.length || 0,
        audioChunks: audioIndex.length,
        audioBytes: offset,
        totalBytes: blob.size,
        settingsKeys: Object.keys(local).length,
        warnings,
      },
    };
  } finally {
    db.close();
  }
}

/** Trigger a download of the export. Returns the summary. */
export async function downloadPocketReaderBackup(options = {}) {
  const { blob, summary } = await exportPocketReaderData(options);
  const stamp = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `pocket-reader-backup-${stamp}.prbackup`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke late: revoking before the download commits cancels it in some
    // browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return summary;
}

async function readManifest(file) {
  // The header is short; read generously and locate the two newlines.
  const head = await file.slice(0, 64).text();
  const firstBreak = head.indexOf('\n');
  if (firstBreak === -1 || head.slice(0, firstBreak) !== MAGIC) {
    throw new Error('Not a Pocket Reader backup file.');
  }
  const secondBreak = head.indexOf('\n', firstBreak + 1);
  if (secondBreak === -1) throw new Error('Backup header is truncated.');
  const manifestLength = Number(head.slice(firstBreak + 1, secondBreak));
  if (!Number.isFinite(manifestLength) || manifestLength <= 0) {
    throw new Error('Backup manifest length is invalid.');
  }
  const manifestStart = new TextEncoder().encode(head.slice(0, secondBreak + 1)).length;
  const manifestText = await file.slice(manifestStart, manifestStart + manifestLength).text();
  return { manifest: JSON.parse(manifestText), payloadStart: manifestStart + manifestLength };
}

/**
 * @param {File|Blob} file
 * @param {{ onProgress?: (msg: string) => void, overwriteSettings?: boolean }} options
 */
export async function importPocketReaderData(file, options = {}) {
  const { onProgress = () => {}, overwriteSettings = true } = options;
  onProgress('Reading backup…');
  const { manifest, payloadStart } = await readManifest(file);
  if (manifest.formatVersion !== 1) {
    throw new Error(`Unsupported backup format version ${manifest.formatVersion}.`);
  }

  const db = await openDb();
  const restored = { chapters: 0, profileRows: 0, audioChunks: 0, audioBytes: 0, settingsKeys: 0 };

  try {
    if (overwriteSettings && manifest.localStorage) {
      onProgress('Restoring settings…');
      for (const [key, value] of Object.entries(manifest.localStorage)) {
        // Enforced here too: a backup written before these were excluded would
        // otherwise restore someone else's session or device identity.
        if (!isExportableLocalKey(key)) continue;
        try { localStorage.setItem(key, value); restored.settingsKeys += 1; }
        catch (_) { /* quota or a blocked key: keep going, settings are re-derivable */ }
      }
    }

    for (const name of JSON_STORES) {
      const rows = manifest.stores?.[name] || [];
      if (!rows.length) continue;
      onProgress(`Restoring ${name.replace('_', ' ')} (${rows.length})…`);
      await new Promise((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        for (const row of rows) store.put(row.value, row.key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      if (name === 'story_chapters') restored.chapters = rows.length;
      if (name === 'user_profile') restored.profileRows = rows.length;
    }

    const audio = manifest.audio || [];
    if (audio.length) {
      // Write in batches so one huge transaction cannot exhaust memory or trip
      // a quota error that discards the whole restore.
      const BATCH = 40;
      for (let i = 0; i < audio.length; i += BATCH) {
        const slice = audio.slice(i, i + BATCH);
        onProgress(`Restoring narration audio ${i + 1}-${Math.min(i + BATCH, audio.length)} of ${audio.length}…`);
        await new Promise((resolve, reject) => {
          const tx = db.transaction(BLOB_STORE, 'readwrite');
          const store = tx.objectStore(BLOB_STORE);
          for (const entry of slice) {
            const start = payloadStart + entry.offset;
            // slice() is lazy: this does not read the file into memory.
            const blob = file.slice(start, start + entry.length, entry.type);
            store.put({
              blob,
              isPermanent: !!entry.isPermanent,
              timestamp: entry.timestamp || Date.now(),
            }, entry.key);
          }
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        restored.audioChunks += slice.length;
        restored.audioBytes += slice.reduce((sum, e) => sum + e.length, 0);
      }
    }

    onProgress('Import complete. Reload to see your library.');
    return { restored, manifest: { createdAt: manifest.createdAt, sourceOrigin: manifest.sourceOrigin } };
  } finally {
    db.close();
  }
}

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Mounts a self-contained backup and restore panel.
 *
 * Styling is inline and theme-neutral so it does not depend on theme.css
 * having loaded, and it uses textContent throughout: story titles and file
 * names are untrusted input and must never reach innerHTML.
 */
export function mountDataTransferUI(target = document.body) {
  if (!target || document.getElementById('pr-migrate-panel')) return null;

  const panel = document.createElement('section');
  panel.id = 'pr-migrate-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Transfer your Pocket Reader data');
  panel.style.cssText = [
    'position:fixed', 'inset:auto 16px 16px auto', 'z-index:2147483000',
    'max-width:min(92vw,380px)', 'padding:18px 20px', 'border-radius:14px',
    'background:#16181c', 'color:#e8e8ea', 'border:1px solid #2c3038',
    'box-shadow:0 18px 48px rgba(0,0,0,.55)',
    "font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  ].join(';');

  const heading = document.createElement('h2');
  heading.textContent = 'Transfer your library';
  heading.style.cssText = 'margin:0 0 8px;font-size:16px;font-weight:600';

  const blurb = document.createElement('p');
  blurb.textContent = 'Saved stories, narration audio and settings are stored per website address, '
    + 'so they do not follow you automatically. Back up here, then restore on the new site.';
  blurb.style.cssText = 'margin:0 0 14px;opacity:.8';

  const status = document.createElement('p');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'margin:12px 0 0;min-height:1.2em;opacity:.9';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap';

  const button = (label, primary) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'flex:1 1 auto', 'padding:10px 14px', 'border-radius:9px', 'cursor:pointer',
      'font:inherit', 'font-weight:600',
      primary ? 'background:#4a9eff;color:#08111c;border:1px solid #4a9eff'
              : 'background:transparent;color:#e8e8ea;border:1px solid #3a3f49',
    ].join(';');
    return b;
  };

  const exportBtn = button('Back up', true);
  const importBtn = button('Restore');
  const closeBtn = button('Close');
  closeBtn.style.flex = '0 0 auto';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.prbackup';
  fileInput.style.display = 'none';

  const busy = (on) => { exportBtn.disabled = on; importBtn.disabled = on; };

  exportBtn.addEventListener('click', async () => {
    busy(true);
    try {
      const summary = await downloadPocketReaderBackup({ onProgress: (m) => { status.textContent = m; } });
      status.textContent = `Saved ${fmtBytes(summary.totalBytes)} — `
        + `${summary.chapters} stories, ${summary.audioChunks} audio clips.`;
    } catch (err) {
      status.textContent = `Back up failed: ${err?.message || err}`;
    } finally { busy(false); }
  });

  importBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    busy(true);
    try {
      const { restored } = await importPocketReaderData(file, { onProgress: (m) => { status.textContent = m; } });
      status.textContent = `Restored ${restored.chapters} stories and `
        + `${restored.audioChunks} audio clips. Reload to see them.`;
    } catch (err) {
      status.textContent = `Restore failed: ${err?.message || err}`;
    } finally { busy(false); fileInput.value = ''; }
  });

  closeBtn.addEventListener('click', () => panel.remove());

  row.append(exportBtn, importBtn, closeBtn);
  panel.append(heading, blurb, row, status, fileInput);
  target.appendChild(panel);
  return panel;
}

// Exposed for the Settings UI, for the backup panel, and for hand-running
// from a console.
if (typeof window !== 'undefined') {
  window.exportPocketReaderData = exportPocketReaderData;
  window.downloadPocketReaderBackup = downloadPocketReaderBackup;
  window.importPocketReaderData = importPocketReaderData;
  window.mountDataTransferUI = mountDataTransferUI;

  // Opt-in only: ?backup=1 shows the panel.
  try {
    if (new URLSearchParams(location.search).get('backup') === '1') {
      if (document.body) mountDataTransferUI();
      else document.addEventListener('DOMContentLoaded', () => mountDataTransferUI(), { once: true });
    }
  } catch (_) { /* URL unavailable — panel simply does not mount */ }
}
