import { useEffect, useState, type ReactNode } from "react";

/**
 * The safety net behind the transition, not the transition itself: the real
 * duration lives on `.collapsible` in index.css, and both ends of the
 * animation are taken from transitionend rather than timed against it. This
 * only bounds how long a closing body lingers when no transition runs at all,
 * which is what reduced motion asks for. Deliberately longer than the CSS
 * duration so it never races the animation it is insuring.
 */
const COLLAPSE_FALLBACK_MS = 500;

/**
 * A section body that grows and shrinks instead of appearing all at once.
 *
 * The height comes from a 0fr → 1fr grid row rather than a measured pixel
 * height, so a body whose contents change while open — a rule added, the edit
 * form swapped in — never has to be re-measured and never animates from a
 * stale height.
 *
 * The animating element is always in the tree, even with nothing inside it. A
 * transition needs a previously painted value to start from, and an element
 * created and opened in the same breath has none: it arrives already at its
 * final height. Keeping an empty, zero-height row means the 0fr start state is
 * always the one on screen, so opening is a plain change of one property on a
 * settled element and cannot be beaten by the frame it happens to land in.
 *
 * The contents, which are the expensive part — a full rule list and a rule
 * form for every category — mount only while the body is open or still
 * closing.
 */
export default function Collapsible({
  open,
  id,
  className,
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  // Outlives `open` by one transition, so a closing body has something to
  // shrink rather than blinking out at full height.
  const [mounted, setMounted] = useState(open);
  // Growing means clipping, and clipping cuts the focus outline off any
  // control sitting against an edge. So the clip is lifted once the body has
  // finished arriving and there is no longer anything to hide.
  const [settled, setSettled] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);

  // Adjusted during the render that sees the change, not from an effect. The
  // contents have to appear in the very same commit that flips the row open,
  // or the row spends its animation growing around an empty body and the
  // contents drop in fully formed once it is over.
  if (prevOpen !== open) {
    setPrevOpen(open);
    setSettled(false);
    if (open) setMounted(true);
  }

  useEffect(() => {
    if (open) {
      // Under reduced motion there is no transition and so no transitionend to
      // lift the clip; without this the body would stay clipped for good.
      const timer = window.setTimeout(() => setSettled(true), COLLAPSE_FALLBACK_MS);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setMounted(false), COLLAPSE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      id={id}
      className="collapsible"
      data-open={open ? "true" : "false"}
      data-settled={settled ? "true" : "false"}
      onTransitionEnd={(event) => {
        // The row is what animates; a transition finishing on something inside
        // the body says nothing about whether the body is done.
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== "grid-template-rows") return;
        if (open) setSettled(true);
        else setMounted(false);
      }}
    >
      {/* Three elements, and each one is load-bearing. The clip is its own
          bare element because padding and borders survive a height of zero:
          carrying them here would leave the body stuck at the sum of them and
          hand the close a visible last step down to nothing. So they go on the
          element inside the clip, which is free to keep its full height while
          the clip shrinks past it. */}
      <div className="collapsible-clip">
        {mounted && <div className={className}>{children}</div>}
      </div>
    </div>
  );
}
