import { uncategorizedMark } from "../../lib/chartTheme";
import type { CategoryState } from "../../lib/classify";
import type { Palette } from "../../lib/palettes";
import type { ThemeName } from "../../lib/theme";

/** One palette for productivity anywhere Activity names a state. */
export function stateColors(
  palette: Palette,
  theme: ThemeName,
): Record<CategoryState, string> {
  return {
    productive: palette.productive,
    neutral: palette.neutral,
    unproductive: palette.unproductive,
    ignored: uncategorizedMark(theme),
  };
}
