/**
 * Files handed to the app by the OS (manifest file_handlers): the launch
 * queue fires before any UI that could consume the file exists, so the file
 * parks here and the restore flow picks it up when it mounts.
 */

let _pendingBackup: File | null = null;
// setConsumer takes exactly one consumer per page, and TWO screens need to
// register: the setup screen (a device with no account, where a backup is the
// only way in) and the app itself. First registration wins; the later caller
// finds the file already parked and takes it with takePendingBackupFile().
let _registered = false;

export function initLaunchQueue(onBackupFile: () => void): void {
  if (_registered) {
    // Already parked by an earlier screen: tell this caller so it can consume
    // it, rather than silently doing nothing.
    if (_pendingBackup) onBackupFile();
    return;
  }
  const lq = (
    window as Window & {
      launchQueue?: {
        setConsumer(cb: (params: { files: FileSystemFileHandle[] }) => void): void;
      };
    }
  ).launchQueue;
  if (!lq) return;
  _registered = true;
  lq.setConsumer((params) => {
    void (async () => {
      const handle = params.files?.[0];
      if (!handle) return;
      try {
        _pendingBackup = await handle.getFile();
        onBackupFile();
      } catch {
        // Unreadable handle: nothing to restore.
      }
    })();
  });
}

/** The restore flow takes the file exactly once. */
export function takePendingBackupFile(): File | null {
  const f = _pendingBackup;
  _pendingBackup = null;
  return f;
}
