import {
  type ActivityEntitySummary,
  type ActivityTriageItem,
} from "../lib/activity";
import { assignEntityRule, assignEntityRules, undoEntityRules, removeEntityRules, type EntityRuleChange } from "../lib/queries";
import { KeyedSerialQueue } from "../lib/keyedSerialQueue";
import { type StarterSuggestion } from "../lib/starterSuggestions";
import { useBanner } from "./banner";
import { useMeta } from "./meta";

type RuleEntity = Pick<ActivityEntitySummary, "kind" | "key" | "displayName">;
// Shared across mounts: navigating away must not let a later action overtake
// an earlier write still in flight from the previous screen.
const writes = new KeyedSerialQueue();

/** What is still unclassified before the write, in the two shapes this hook
 *  reports on: the rows the Unclassified section lists, and the uncategorized
 *  time on partly-classified rows it does not. Both are read from the same
 *  all-history triage summary the section renders.
 *
 *  Taken before the write on purpose — "this was the last one" is a statement
 *  about the backlog the reader just acted on. `residualSeconds` survives the
 *  write unchanged: a listed row is uncategorized in full, so classifying it
 *  moves it to `single` and never adds to the partial residue. */
export interface PendingClassification {
  triageCount: number;
  residualSeconds: number;
}

/** Owns the exact-rule transaction shared by Activity's entity surfaces. */
export function useEntityRuleWrites(pending: PendingClassification) {
  const { triageCount: pendingTriageCount, residualSeconds } = pending;
  const meta = useMeta();
  const banner = useBanner();

  /** Everything the section tracks is classified. Deliberately not
   *  `remainingTriage === 0` alone: emptying the list while partly-classified
   *  rows still hold uncategorized time is not the same statement, and the card
   *  one click away says that time is left out of every category total.
   *  Claiming otherwise here contradicts it. */
  const nothingLeft = (remainingTriage: number) => remainingTriage === 0 && residualSeconds === 0;

  const writeEntityRule = (entity: RuleEntity, categoryId: number) => writes.run("rules", async () => {
    const matchType = entity.kind === "website" ? "domain" : "process";
    const change = await assignEntityRule(matchType, entity.key, categoryId);
    await meta.refresh();
    return change;
  });

  const undo = async (changes: EntityRuleChange[]) => {
    try {
      await writes.run("rules", async () => {
        await undoEntityRules(changes);
        await meta.refresh();
      });
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  // Undo for the same reason triage has it: from a table row this is one
  // misplaced click away, with no panel open to show what just changed.
  const assignEntity = async (entity: ActivityEntitySummary, categoryId: number) => {
    try {
      const change = await writeEntityRule(entity, categoryId);
      const category = meta.categories.find((option) => option.id === categoryId);
      if (category) {
        banner.show(
          `${entity.displayName} is now ${category.name}, in all history and from now on.`,
          { label: "Undo", run: () => void undo([change]) },
        );
      }
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  const assignFromTriage = async (item: ActivityTriageItem, categoryId: number) => {
    try {
      const change = await writeEntityRule(item, categoryId);
      const category = meta.categories.find((option) => option.id === categoryId);
      if (category) {
        banner.show(
          nothingLeft(pendingTriageCount - 1)
            ? `${item.displayName} is now ${category.name}. Everything is classified.`
            : `${item.displayName} is now ${category.name}.`,
          { label: "Undo", run: () => void undo([change]) },
        );
      }
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  const applySuggestions = async (accepted: StarterSuggestion<ActivityTriageItem>[]) => {
    if (accepted.length === 0) return;
    try {
      const changes = await writes.run("rules", async () => {
        const committed = await assignEntityRules(accepted.map((suggestion) => ({
          matchType: suggestion.entity.kind === "website" ? "domain" : "process",
          pattern: suggestion.entity.key, categoryId: suggestion.categoryId,
        })));
        await meta.refresh();
        return committed;
      });
      const remaining = pendingTriageCount - accepted.length;
      banner.show(
        `Classified ${accepted.length} app${accepted.length === 1 ? "" : "s"}.`
        + (remaining > 0
          ? ` ${remaining} item${remaining === 1 ? "" : "s"} still unclassified.`
          : nothingLeft(remaining)
            ? " Everything is classified."
            : " Some time on partly-classified rows is still unclassified."),
        { label: "Undo", run: () => void undo(changes) },
      );
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  const removeExactRules = async (entity: ActivityEntitySummary) => {
    try {
      await writes.run("rules", async () => {
        await removeEntityRules(entity.kind === "website" ? "domain" : "process", entity.key);
        await meta.refresh();
      });
      banner.show(`Removed the ${entity.kind === "website" ? "Website" : "App"} rule for ${entity.key}.`);
    } catch (error) {
      banner.report(error, "rule");
    }
  };

  return { applySuggestions, assignEntity, assignFromTriage, removeExactRules };
}
