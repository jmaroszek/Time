import type { ReactNode } from "react";

/**
 * A section body that grows and shrinks instead of appearing all at once.
 *
 * The contents stay mounted while this view is on screen. That gives the
 * browser a settled intrinsic height before the first open: inserting the
 * contents in the same commit that changed 0fr to 1fr left WebView2 free to
 * cache an empty, zero-height track until some later layout invalidated it.
 * Eight category forms and their rule rows are a small fixed cost here, and a
 * blank rule form does not run the history preview.
 *
 * CSS owns both ends of the animation. Closed contents remain in layout so
 * the 1fr target is known, while `inert` and `aria-hidden` keep them out of
 * pointer, keyboard, and accessibility interaction.
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
  return (
    <div
      id={id}
      className="collapsible"
      data-open={open ? "true" : "false"}
      aria-hidden={open ? undefined : true}
    >
      {/* Padding and borders live inside the bare clip because they survive a
          zero-height grid track. Visibility is delayed by CSS on close so the
          body remains painted throughout the collapse. */}
      <div className="collapsible-clip">
        <div className={className} inert={!open ? true : undefined}>
          {children}
        </div>
      </div>
    </div>
  );
}
