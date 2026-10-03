import { requireSession } from "./identity";

/** Object identity also distinguishes a same-DID re-unlock. */
export function captureSessionGuard(): () => void {
  const session = requireSession();
  return () => {
    if (requireSession() !== session) throw new Error("Identity changed");
  };
}
