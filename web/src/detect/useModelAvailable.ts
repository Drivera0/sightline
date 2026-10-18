import { useEffect, useState } from "react";
import { modelAvailable } from "./runDetector";

let check: Promise<boolean> | null = null;

/** One HEAD check per page load, shared by every "Try your own photo" entry point. */
export function modelAvailableOnce(): Promise<boolean> {
  check ??= modelAvailable();
  return check;
}

/** Forget the cached check (tests). */
export function resetModelAvailable(): void {
  check = null;
}

/**
 * Whether this deployment ships the in-browser detector. False until the check answers, so an
 * entry point never shows and then disappears.
 */
export function useModelAvailable(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    void modelAvailableOnce().then((value) => live && setOk(value));
    return () => {
      live = false;
    };
  }, []);
  return ok;
}
