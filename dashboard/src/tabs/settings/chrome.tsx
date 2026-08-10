import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** The section currently being pointed at, so SettingsSection can mark itself
 *  without every one of the ten call sites having to thread a prop it does not
 *  otherwise care about. */
export const FlashedSection = createContext<string | null>(null);

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="mb-3 pl-0.5 text-micro font-bold uppercase tracking-[.09em] text-ink-2">{children}</p>;
}

/** `intro` carries the rationale a whole section shares, so its rows can keep
 *  the one-sentence helps that make the column read evenly. */
export function Section({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <SettingsSection title={title}>
      <SectionLabel>{title}</SectionLabel>
      <div className="overflow-hidden rounded-[13px] border border-edge bg-surface-dim">
        {intro && <p className="px-4 pb-3 pt-4 text-xs leading-snug text-ink-3">{intro}</p>}
        {children}
      </div>
    </SettingsSection>
  );
}

/** Every section the rail can reach, in page order. The rail is built from this
 *  list and each section takes its anchor from the same slug, so a section that
 *  is added, renamed or reordered cannot end up missing from the rail or
 *  pointing at nothing — the failure a hand-written list of links invites. */
const SETTINGS_SECTIONS = [
  "Tracker status",
  "Recording & startup",
  "Insights",
  "Timeline window",
  "Focus & idle",
  "Appearance",
  "Activity list",
  "Advanced",
  "Defaults",
  "Help & feedback",
  "Data management",
] as const;

/** How far into the viewport a section has to reach before the rail calls it the
 *  current one. Roughly one section label plus its gap. */
const ACTIVE_SECTION_BAND = 88;

/** How long a pointed-at section stays marked. Long enough to be found by
 *  someone whose eyes are still travelling from the tile they clicked, short
 *  enough that it never becomes part of the page. */
export const SECTION_FLASH_MS = 2_200;

/** Long enough for the tab to finish mounting before it is scrolled — see the
 *  note at the call site. Short enough to read as a jump, not a delay. */
export const SECTION_SCROLL_DELAY_MS = 150;

export function sectionSlug(title: string): string {
  return `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** A section wrapper that carries its own anchor. `scroll-mt` clears the height
 *  the label would otherwise be jammed against at the top of the viewport. */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const flashed = useContext(FlashedSection) === title;
  return (
    <section
      id={sectionSlug(title)}
      className={`scroll-mt-4 rounded-[15px] transition-shadow duration-500 ${
        flashed ? "ring-2 ring-accent/70" : "ring-0 ring-transparent"
      }`}
    >
      {children}
    </section>
  );
}

/**
 * Settings is eleven sections in one column, and the column was correct — any
 * masonry layout re-balances every time a section changes height. The problem
 * was never width, it was length: there is no way to see what is on the page
 * without scrolling all of it.
 *
 * So the rail says what is here and jumps to it, and it lives in the dead space
 * beside a 600px column rather than taking any width from it. It appears only at
 * the app's "large" layout class and above (lib/responsive.ts), because that is
 * where the space exists — below it the page is exactly as it was.
 *
 * It sits to the *right* of the column. On the left it read as a second-level
 * tab bar competing with the real one directly above it, and it pushed the
 * settings themselves off the left margin every other tab starts at. On the
 * right it is unmistakably an index of the column beside it, and the column
 * stays where the rest of the app's content does.
 */
export function SectionRail() {
  const [active, setActive] = useState<string>(SETTINGS_SECTIONS[0]);

  useEffect(() => {
    const sections: { title: string; node: HTMLElement }[] = [];
    for (const title of SETTINGS_SECTIONS) {
      const node = document.getElementById(sectionSlug(title));
      if (node) sections.push({ title, node });
    }
    if (sections.length === 0) return;
    const viewport = sections[0].node.closest<HTMLElement>(".app-viewport") ?? null;

    // The last section that has started, not the first one still touching the
    // viewport. An IntersectionObserver picking the topmost intersecting section
    // marks the one being *left*: a card's last row is still on screen while its
    // successor fills the rest of it, which is the reading position.
    const measure = () => {
      // At the end of the scroll the rule above cannot reach the last sections:
      // nothing below the final screenful can be brought to the top of the
      // viewport, so their tops never cross the band and the mark would stick a
      // few sections early. At the bottom, the last section is where you are.
      if (viewport && viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 2) {
        setActive(sections[sections.length - 1].title);
        return;
      }
      const band = (viewport?.getBoundingClientRect().top ?? 0) + ACTIVE_SECTION_BAND;
      let current = sections[0].title;
      for (const { title, node } of sections) {
        if (node.getBoundingClientRect().top <= band) current = title;
        else break;
      }
      setActive(current);
    };

    measure();
    const target: HTMLElement | Window = viewport ?? window;
    target.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    // Sections change height as settings expand (the rare-item limits appear and
    // disappear), which moves every section below them without any scrolling.
    const observer = new ResizeObserver(measure);
    for (const { node } of sections) observer.observe(node);
    return () => {
      target.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-2 hidden w-[150px] shrink-0 flex-col gap-px self-start min-[1008px]:flex"
    >
      {SETTINGS_SECTIONS.map((title) => (
        <a
          key={title}
          href={`#${sectionSlug(title)}`}
          aria-current={active === title ? "true" : undefined}
          className={`truncate rounded-md px-2 py-[5px] text-xs transition-colors ${
            active === title
              ? "bg-surface-2 font-medium text-ink"
              : "text-ink-3 hover:bg-hover hover:text-ink-2"
          }`}
        >
          {title}
        </a>
      ))}
    </nav>
  );
}
