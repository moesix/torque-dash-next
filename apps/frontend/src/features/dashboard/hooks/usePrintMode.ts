import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Print-to-PDF state machine for the replay dashboard (moved verbatim out of
 * ReplayDashboard.tsx in plans/017 — behavior unchanged).
 *
 *   handlePrint()
 *     setIsPrinting(true); setPrintMode(true);
 *     raf1 → raf2 (double-rAF, ids stored in printRafRef) → window.print()
 *   reset effect (armed while isPrinting)
 *     - re-arms printInvokedRef.current = false
 *     - window 'afterprint' → finishPrint() (clear printMode + isPrinting)
 *     - 500ms setTimeout fallback → finishPrint() ONLY if
 *       printInvokedRef.current is true (a backgrounded tab stalls rAF; the
 *       fallback must not collapse the report before the print was invoked)
 *     - cleanup: remove listener, clear timeout, cancel pending rAFs
 *   unmount-only effect → cancels any pending rAFs
 *
 * Regression net: features/dashboard/__tests__/printFlow.test.tsx drives this
 * through the real dashboard chrome (button state, panel aria-expanded,
 * window.print timing, unmount cancellation).
 */
export function usePrintMode() {
  // Print mode: force-expands diagnostic panels so charts initialize before
  // window.print(); cleared again after the print dialog closes.
  const [printMode, setPrintMode] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  // Ids of the in-flight double-rAF chain that calls window.print(). Stored so
  // a navigating/unmounting component can cancel the chain — window.print()
  // must never fire on a page the user has already left.
  const printRafRef = useRef<number[]>([]);
  // True only between the moment window.print() is actually invoked and the
  // reset that follows. Gates the reset effect's timeout fallback so a
  // backgrounded tab (rAF stalled) cannot collapse the report pre-print.
  const printInvokedRef = useRef(false);

  /**
   * Print the session report / save as PDF.
   *
   * Sets printMode so the diagnostic panels force-expand (charts lazy-init),
   * then waits two frames for React to commit the expanded panels and for
   * ECharts' lazy init to render before opening the print dialog (a single
   * rAF raced the charts on some engines — notably Safari). printMode is kept
   * on until the dialog closes: the reset happens via the `afterprint` event
   * (see the effect below), with a timeout fallback for engines that never
   * fire it. Note: the latest AI analysis body is fetched asynchronously on
   * printMode — if it was never expanded before, the first print may omit its
   * body (one-print latency); the analysis is usually already expanded when
   * the owner prints after reading.
   */
  const handlePrint = useCallback(() => {
    setIsPrinting(true);
    setPrintMode(true);
    // Double rAF so React commits the expanded panels AND ECharts' lazy init
    // gets a frame to render before the print dialog opens. Ids are stored so a
    // navigating/unmounting component can cancel the chain — window.print()
    // must never fire on a page the user has already left.
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        printInvokedRef.current = true;
        window.print();
      });
      printRafRef.current.push(raf2);
    });
    printRafRef.current.push(raf1);
  }, []);

  // Reset print mode AFTER printing completes. `afterprint` is not fired by
  // every engine (older Safari), so fall back to a ~500ms timeout. Keeps
  // isPrinting true (spinner visible) until the dialog actually closes.
  useEffect(() => {
    if (!isPrinting) return;
    // Armed when isPrinting flips true — BEFORE handlePrint's rAF chain runs
    // and sets it true. This keeps the ordering deterministic.
    printInvokedRef.current = false;
    const finishPrint = () => {
      printInvokedRef.current = false;
      setPrintMode(false);
      setIsPrinting(false);
    };
    window.addEventListener('afterprint', finishPrint);
    // Fallback ONLY for engines where afterprint never fires — and only once
    // window.print() has actually been invoked (a backgrounded tab stalls
    // rAF; without this gate the fallback would reset printMode before the
    // print, degrading the report).
    const fallback = window.setTimeout(() => {
      if (printInvokedRef.current) finishPrint();
    }, 500);
    return () => {
      window.removeEventListener('afterprint', finishPrint);
      window.clearTimeout(fallback);
      printRafRef.current.forEach((id) => cancelAnimationFrame(id));
      printRafRef.current = [];
    };
  }, [isPrinting]);

  // Unmount-only cleanup: navigation away mid-chain cancels the pending
  // window.print() so it can never fire on whatever page mounts next.
  useEffect(
    () => () => {
      printRafRef.current.forEach((id) => cancelAnimationFrame(id));
      printRafRef.current = [];
    },
    [],
  );

  return { printMode, isPrinting, handlePrint };
}
