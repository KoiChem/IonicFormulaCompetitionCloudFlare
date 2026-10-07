// Port of IonicFormula js/chemistry/complex-policy.js, reviewed 2026-10-02.
type ChemistryItem = { chemistryClass?: string; formula?: string | null; cation?: string; anion?: string };
export const CHEMISTRY_CONTENT_VERSION = "complex-ions-2026-10-02";

export function isComplexItem(item: ChemistryItem, ionById: ReadonlyMap<string, ChemistryItem> = new Map()): boolean {
  return item.chemistryClass === "complex" || !!item.formula?.includes("[")
    || [item.cation, item.anion].some(id => !!id && ionById.get(id)?.chemistryClass === "complex");
}

export function complexItemAllowed(item: ChemistryItem, enabled: boolean | undefined, ionById: ReadonlyMap<string, ChemistryItem>): boolean {
  return !isComplexItem(item, ionById) || enabled === true;
}
