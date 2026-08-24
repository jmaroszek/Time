import { useRef } from "react";

import {
  type ActivityEntitySummary,
  type ActivityTriageItem,
} from "../lib/activity";
import { addRule, deleteRule } from "../lib/queries";
import { type StarterSuggestion } from "../lib/starterSuggestions";
import { useBanner } from "./banner";
import { useMeta } from "./meta";

type RuleEntity = Pick<ActivityEntitySummary, "kind" | "key" | "displayName">;

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
  // Undo runs after the write and therefore must not close over the rules from
  // the render that offered it.
  const rulesRef = useRef(meta.rules);
  rulesRef.current = meta.rules;

  /** Everything the section tracks is classified. Deliberately not
   *  `remainingTriage === 0` alone: emptying the list while partly-classified
   *  rows still hold uncategorized time is not the same statement, and the card
   *  one click away says that time is left out of every category total.
   *  Claiming otherwise here contradicts it. */
  const nothingLeft = (remainingTriage: number) => remainingTriage === 0 && residualSeconds === 0;

  const exactRulesFor = (entity: RuleEntity) => {
    const matchType = entity.kind === "website" ? "domain" : "process";
    return rulesRef.current.filter(
      (rule) => rule.matchType === matchType && rule.pattern.toLowerCase() === entity.key.toLowerCase(),
    );
  };

  const writeEntityRule = async (entity: RuleEntity, categoryId: number) => {
    const matchType = entity.kind === "website" ? "domain" : "process";
    const exactRules = exactRulesFor(entity);
    const retained = exactRules.find((rule) => rule.categoryId === categoryId);
    for (const rule of exactRules) {
      if (rule.id !== retained?.id) await deleteRule(rule.id);
    }
    if (!retained) await addRule(matchType, entity.key, categoryId);
    await meta.refresh();
  };

  const undoTriageAssign = async (item: ActivityTriageItem) => {
    try {
      for (const rule of exactRulesFor(item)) await deleteRule(rule.id);
      await meta.refresh();
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  const assignEntity = async (entity: ActivityEntitySummary, categoryId: number) => {
    try {
      await writeEntityRule(entity, categoryId);
      const category = meta.categories.find((option) => option.id === categoryId);
      if (category) {
        banner.show(`${entity.displayName} is now ${category.name}, in all history and from now on.`);
      }
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  const assignFromTriage = async (item: ActivityTriageItem, categoryId: number) => {
    try {
      await writeEntityRule(item, categoryId);
      const category = meta.categories.find((option) => option.id === categoryId);
      if (category) {
        banner.show(
          nothingLeft(pendingTriageCount - 1)
            ? `${item.displayName} is now ${category.name}. Everything is classified.`
            : `${item.displayName} is now ${category.name}.`,
          { label: "Undo", run: () => void undoTriageAssign(item) },
        );
      }
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  const undoSuggestions = async (accepted: StarterSuggestion<ActivityTriageItem>[]) => {
    try {
      for (const suggestion of accepted) {
        for (const rule of exactRulesFor(suggestion.entity)) await deleteRule(rule.id);
      }
      await meta.refresh();
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  const applySuggestions = async (accepted: StarterSuggestion<ActivityTriageItem>[]) => {
    if (accepted.length === 0) return;
    try {
      for (const suggestion of accepted) {
        await writeEntityRule(suggestion.entity, suggestion.categoryId);
      }
      const remaining = pendingTriageCount - accepted.length;
      banner.show(
        `Classified ${accepted.length} app${accepted.length === 1 ? "" : "s"}.`
        + (remaining > 0
          ? ` ${remaining} item${remaining === 1 ? "" : "s"} still unclassified.`
          : nothingLeft(remaining)
            ? " Everything is classified."
            : " Some time on partly-classified rows is still unclassified."),
        { label: "Undo", run: () => void undoSuggestions(accepted) },
      );
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  const removeExactRules = async (entity: ActivityEntitySummary) => {
    try {
      for (const rule of exactRulesFor(entity)) await deleteRule(rule.id);
      await meta.refresh();
      banner.show(`Removed the ${entity.kind === "website" ? "Website" : "App"} rule for ${entity.key}.`);
    } catch (error) {
      banner.report(error, "rule");
    }
  };

  return { applySuggestions, assignEntity, assignFromTriage, removeExactRules };
}
