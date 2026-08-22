import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The safety net behind the transition, not the transition itself: the real
 * duration lives on `.collapsible` in index.css, and the end of a collapse is
 * detected from the transition rather than timed against it. This only bounds
 * how long a closing body can linger if no transitionend ever arrives —
 * reduced motion removes the transition outright, and a body unmounted before
 * it is ever painted has nothing to finish. Deliberately longer than the CSS
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
 * The body is mounted only while it is open or still collapsing. Every closed
 * category would otherwise carry a full rule list and a rule form for as long
 * as the tab is on screen, which is the cost the plain conditional render was
 * already avoiding before there was an animation at all.
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
  const [mounted, setMounted] = useState(open);
  // Separate from `mounted` because the two have to land in different frames:
  // the body must exist at 0fr for one frame before it is told to grow, or the
  // browser has no start state to interpolate from and it simply appears.
  const [shown, setShown] = useState(open);
  // Growing means clipping, and clipping cuts the focus outline off any
  // control sitting against an edge. So the clip is lifted once the body has
  // finished arriving and there is no longer anything to hide.
  const [settled, setSettled] = useState(open);
  // A row that starts open — every row does while a rule search is active —
  // has nothing to animate from, so the first commit is taken as it is.
  const first = useRef(true);

  useEffect(() => {
    const wasFirst = first.current;
    first.current = false;
    if (wasFirst && open === shown) return;
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      // Under reduced motion there is no transition and so no transitionend to
      // lift the clip; without this the body would stay clipped for good.
      const timer = window.setTimeout(() => setSettled(true), COLLAPSE_FALLBACK_MS);
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        window.clearTimeout(timer);
      };
    }
    setSettled(false);
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), COLLAPSE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
    // `shown` is read only on the first pass, to decide whether this mount is
    // already in its final state; re-running when it changes would restart the
    // transition it was just set by.
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      id={id}
      className="collapsible"
      data-open={shown ? "true" : "false"}
      data-settled={settled ? "true" : "false"}
      onTransitionEnd={(event) => {
        // The row is what animates; a transition finishing on something inside
        // the body says nothing about whether the body is done closing.
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
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
