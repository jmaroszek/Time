import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { TOOLTIP_DELAY_MS } from "../../lib/tooltipDelay";

/** A delayed tooltip rendered outside scroll containers so it cannot create
 * overflow or be clipped by the content it describes. */
export function FloatingTooltip({
  text,
  ariaLabel,
  children,
  className = "",
  disabled = false,
}: {
  text: string;
  /** Accessible name, when it has to differ from the visible tooltip. A label
   *  and its explanation read as one phrase to a screen reader, which has no
   *  layout to tell it they are two things — but folding the label into `text`
   *  to achieve that would print it back onto a tooltip already sitting under
   *  the label it names. */
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  /** Suppresses the tooltip, and dismisses one already showing. */
  disabled?: boolean;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const hide = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPosition(null);
  };
  const show = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 208;
    const estimatedHeight = 48;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + estimatedHeight <= window.innerHeight
      ? below
      : Math.max(8, rect.top - estimatedHeight - 6);
    setPosition({ left, top });
  };
  const scheduleShow = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(show, TOOLTIP_DELAY_MS);
  };

  useEffect(() => {
    if (disabled) hide();
  }, [disabled]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return (
    <span
      ref={triggerRef}
      tabIndex={0}
      aria-label={ariaLabel ?? text}
      className={className}
      onMouseEnter={scheduleShow}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {children}
      {position && createPortal(
        <span
          role="tooltip"
          style={{ left: position.left, top: position.top }}
          // Above menus, which are above dialogs: a tooltip explains whatever
          // is frontmost, so it can never be the thing that gets covered.
          className="pointer-events-none fixed z-[85] w-52 rounded-lg border border-raised-edge bg-raised px-2.5 py-1.5 text-left text-meta font-normal leading-snug text-ink-2 shadow-menu"
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
