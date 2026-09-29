import { useEffect, useState } from 'react';

// Real mobile devices match here. Desktop browsers — even when their window
// is dragged narrow — do not, which is exactly what we want: shrinking the
// window must NOT flip a desktop session into the mobile UI mid-meeting.
const MOBILE_UA = /Mobi|Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i;

// True touch-only devices that don't surface a hover-capable pointer.
// Catches iPadOS (which lies in its UA but still has coarse + !hover) and
// Android tablets that don't include "Mobi" in their UA. Most desktop
// laptops with a touchscreen still expose hover via the trackpad/mouse so
// they fail this check and stay on the desktop UI.
const TOUCH_ONLY_MQ = '(pointer: coarse) and (hover: none)';

export function detectMobile(): boolean {
  if (typeof navigator !== 'undefined' && MOBILE_UA.test(navigator.userAgent)) {
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia(TOUCH_ONLY_MQ).matches;
    } catch {
      return false;
    }
  }
  return false;
}

// React hook variant — re-checks when the pointer/hover capability changes
// (e.g. external mouse plugged in/out on a touch device). Window-resize is
// intentionally NOT a trigger; layout width is irrelevant to "is this a
// mobile device?".
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(detectMobile);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(TOUCH_ONLY_MQ);
    } catch {
      return;
    }
    const update = () => setIsMobile(detectMobile());
    // Older Safari uses addListener/removeListener
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    const legacy = mq as unknown as { addListener: (cb: () => void) => void; removeListener: (cb: () => void) => void };
    legacy.addListener(update);
    return () => legacy.removeListener(update);
  }, []);

  return isMobile;
}
