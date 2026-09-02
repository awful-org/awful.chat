/**
 * Save the app's own flight recorder from every peer, when a run fails.
 *
 * A failing scenario proves something is wrong and says nothing about where.
 * The bundle carries the client's view - every producer announced, every
 * consume attempted, every one that failed - so the next question after "the
 * late joiner received no video" is answerable without another run.
 *
 * Written next to the run rather than uploaded: these contain peer ids and
 * session detail, and the lab should not quietly ship them anywhere.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const DIR = new URL("./captures/", import.meta.url).pathname;

/** Capture even when a run passed. A failing bundle means little without one
 *  from a healthy run beside it - "roomPeerCount is 0 when it breaks" is only
 *  evidence if it is 1 when it works. */
const ALWAYS = process.env.LAB_CAPTURE_ALWAYS === "1";

export async function captureOnFailure(scenario, peers, failures) {
  if (failures.length === 0 && !ALWAYS) return null;
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {
    return null;
  }
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${failures.length === 0 ? "PASS" : "FAIL"}`;
  const saved = [];
  for (const peer of peers) {
    let json = null;
    try {
      json = await peer.captureDiagBundle();
    } catch {
      json = null;
    }
    if (!json) continue;
    const file = `${DIR}${stamp}-${scenario}-${peer.name}.json`;
    try {
      writeFileSync(file, json);
      saved.push(file);
    } catch {
      // A capture that cannot be written is not worth failing a run over.
    }
  }
  if (saved.length > 0) {
    console.log(`\ndiagnostics captured:\n  ${saved.join("\n  ")}`);
    console.log("  (load these in dashboard/ to see what the client actually did)");
  } else {
    console.log(
      "\ndiagnostics NOT captured: this build has no Diagnostics pane, or it" +
        " could not be reached. The failure above still stands."
    );
  }
  return saved;
}
