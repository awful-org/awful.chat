/**
 * Is the lab and its target healthy enough for a result to mean anything?
 *
 * Written the moment the matrix printed "VERDICT: CODE. It fails on a clean
 * network" for five profiles in a row, because the target had blipped. Every
 * run had aborted before reaching a single assertion, and the table said the
 * app was broken. A harness that blames the code for its own network trouble
 * is worse than no harness: it sends someone to read source that was never
 * involved.
 *
 * So a run now has three outcomes, not two. PASS and FAIL are claims about the
 * app. ENVIRONMENT is a claim about the lab, and it must never be reported as
 * either of the other two.
 */
import { Cdp } from "./cdp.mjs";

export const EXIT_ENVIRONMENT = 3;

/**
 * The target answers and serves the app, seen from a lab browser - not from
 * this host, whose network path is a different one.
 */
export async function targetIsReachable(port, appUrl, { attempts = 3 } = {}) {
  const probe = new Cdp(port);
  try {
    await probe.open();
    let last = "";
    for (let i = 1; i <= attempts; i++) {
      try {
        await probe.goto(`${appUrl}/app`);
        // The app shell, not merely a 200: a captive portal, a maintenance
        // page and a 404 all load happily.
        await probe.waitFor(
          "app shell",
          `document.querySelectorAll('button').length > 0 || null`,
          { timeout: 45_000 }
        );
        return { ok: true, attempts: i };
      } catch (err) {
        // A browser that started seconds ago fails its FIRST external
        // resolution and succeeds on the next - measured, repeatedly, right
        // after up.sh. Declaring the environment dead on one cold attempt
        // turned every profile in a matrix run into ENVIRONMENT.
        last = err.message.slice(0, 200);
        if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    return { ok: false, why: `${last} (after ${attempts} attempts)` };
  } catch (err) {
    return { ok: false, why: err.message.slice(0, 200) };
  } finally {
    probe.close();
  }
}

/** Exit with the ENVIRONMENT code and say so, or return and let the run go on. */
export async function requireReachableTarget(port, appUrl) {
  const seen = await targetIsReachable(port, appUrl);
  if (seen.ok) return;
  console.log(`ENVIRONMENT ${appUrl} is not serving the app: ${seen.why}`);
  console.log(
    "Nothing was tested. This is not a result about the app - it is the lab" +
      " or the target being unavailable."
  );
  process.exit(EXIT_ENVIRONMENT);
}
