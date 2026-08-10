import type { MenuOption } from "../../components/ui";
import type { Category } from "../../lib/classify";

export function triageCategoryOptions(categories: Category[]): MenuOption[] {
  const destinations = [
    ...categories.filter((category) => !category.isIgnored),
    ...categories.filter((category) => category.isIgnored),
  ];
  const firstIgnored = categories.findIndex((category) => category.isIgnored) === -1
    ? -1
    : destinations.findIndex((category) => category.isIgnored);
  return destinations.map((category, index) => ({
    value: String(category.id),
    label: category.name,
    dot: category.color,
    divider: index === firstIgnored && index > 0,
  }));
}
