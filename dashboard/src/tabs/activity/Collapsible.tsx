import type { ReactNode } from "react";

/**
 * An immediate disclosure body. Its presence follows `open` directly, with no
 * intermediate layout state that can disagree with the chevron. The chevron's
 * transform is the only motion in this interaction.
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
  if (!open) return null;
  return (
    <div id={id} className={className}>
      {children}
    </div>
  );
}
