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

/** Owns the exact-rule transaction shared by Activity's entity surfaces. */
export function useEntityRuleWrites(pendingTriageCount: number) {
  const meta = useMeta();
  const banner = useBanner();
  // Undo runs after the write and therefore must not close over the rules from
  // the render that offered it.
  const rulesRef = useRef(meta.rules);
  rulesRef.current = meta.rules;

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
        const clearedTheLast = pendingTriageCount === 1;
        banner.show(
          clearedTheLast
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
          : " Everything is classified."),
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
