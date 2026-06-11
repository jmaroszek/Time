// Timeline block aggregation: bucket each day into fixed N-minute blocks and
// color each block by its dominant category, with a per-app breakdown for the
// tooltip. Display-only — KPIs and other charts always use exact sessions.

import type { Classifier } from "./classify";
import { clipSessions, splitAtMidnights, type Session } from "./metrics";
import { dayKey, listDays, type Range } from "./time";

/** Blocks with less active time than this fraction are dropped (true gaps). */
const MIN_ACTIVE_FRACTION = 0.05;
/** Mostly-AFK blocks render as faint AFK instead of being dropped. */
const AFK_FRACTION = 0.5;

export interface BlockApp {
  process: string;
  seconds: number;
}

export interface TimelineBlock {
  dayKey: string;
  startHour: number; // hours from local midnight
  endHour: number;
  startSec: number;
  endSec: number;
  isAfk: boolean;
  categoryName: string; // dominant category ("AFK" for afk blocks)
  color: string | null; // null for afk blocks
  activeSec: number;
  apps: BlockApp[]; // sorted by seconds desc
}

interface Acc {
  afk: number;
  apps: Map<string, number>;
  cats: Map<string, { color: string; secs: number }>;
}

export function aggregateBlocks(
  sessions: Session[],
  range: Range,
  classifier: Classifier,
  blockMinutes: number,
): TimelineBlock[] {
  const blockSecs = blockMinutes * 60;
  const dayStartByKey = new Map(listDays(range).map((d) => [dayKey(d), d.getTime() / 1000]));
  const acc = new Map<string, Acc>(); // "<dayKey>#<blockIdx>"

  const rangeStart = range.start.getTime() / 1000;
  const rangeEnd = range.end.getTime() / 1000;
  for (const s of clipSessions(sessions, rangeStart, rangeEnd)) {
    const cat = s.isAfk ? null : classifier(s);
    for (const chunk of splitAtMidnights(s.start, s.end)) {
      const dk = dayKey(chunk.dayStart);
      const dayStartSec = dayStartByKey.get(dk);
      if (dayStartSec === undefined) continue;
      let cur = chunk.startSec;
      while (cur < chunk.endSec) {
        const blockIdx = Math.floor((cur - dayStartSec) / blockSecs);
        const blockEndSec = dayStartSec + (blockIdx + 1) * blockSecs;
        const end = Math.min(chunk.endSec, blockEndSec);
        const secs = end - cur;
        const key = `${dk}#${blockIdx}`;
        let a = acc.get(key);
        if (!a) {
          a = { afk: 0, apps: new Map(), cats: new Map() };
          acc.set(key, a);
        }
        if (s.isAfk) {
          a.afk += secs;
        } else {
          a.apps.set(s.process, (a.apps.get(s.process) ?? 0) + secs);
          const name = cat?.name ?? "Uncategorized";
          const entry = a.cats.get(name) ?? { color: cat?.color ?? "#5b616b", secs: 0 };
          entry.secs += secs;
          a.cats.set(name, entry);
        }
        cur = end;
      }
    }
  }

  const out: TimelineBlock[] = [];
  for (const [key, a] of acc) {
    const [dk, idxStr] = key.split("#");
    const blockIdx = Number(idxStr);
    const dayStartSec = dayStartByKey.get(dk)!;
    const startSec = dayStartSec + blockIdx * blockSecs;
    const endSec = startSec + blockSecs;
    const activeSec = [...a.cats.values()].reduce((sum, c) => sum + c.secs, 0);

    let isAfk = false;
    let categoryName: string;
    let color: string | null;
    if (activeSec >= blockSecs * MIN_ACTIVE_FRACTION) {
      let best: { name: string; color: string; secs: number } | null = null;
      for (const [name, c] of a.cats) {
        if (!best || c.secs > best.secs) best = { name, color: c.color, secs: c.secs };
      }
      categoryName = best!.name;
      color = best!.color;
    } else if (a.afk >= blockSecs * AFK_FRACTION) {
      isAfk = true;
      categoryName = "AFK";
      color = null;
    } else {
      continue;
    }

    out.push({
      dayKey: dk,
      startHour: (startSec - dayStartSec) / 3600,
      endHour: (endSec - dayStartSec) / 3600,
      startSec,
      endSec,
      isAfk,
      categoryName,
      color,
      activeSec,
      apps: [...a.apps.entries()]
        .map(([process, seconds]) => ({ process, seconds }))
        .sort((x, y) => y.seconds - x.seconds),
    });
  }
  return out.sort((x, y) =>
    x.dayKey === y.dayKey ? x.startHour - y.startHour : x.dayKey < y.dayKey ? -1 : 1,
  );
}
