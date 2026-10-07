import type { FormulaCharge, FormulaEntry } from "../shared/types";

export function createFormulaEntry(): FormulaEntry {
  return { tokens: [], cursor: 0, charge: null };
}

export function setFormulaTokens(entry: FormulaEntry, tokens: readonly string[]): FormulaEntry {
  return { ...entry, tokens: [...tokens], cursor: tokens.length };
}

export function setFormulaCharge(entry: FormulaEntry, charge: FormulaCharge | null): FormulaEntry {
  return { ...entry, charge };
}

export function formulaEntryValue(entry: FormulaEntry): string {
  const core = entry.tokens.join("");
  if (!entry.charge) return core;
  const magnitude = entry.charge.magnitude === 1 ? "" : String(entry.charge.magnitude);
  return `${core}${magnitude}${entry.charge.sign}`;
}
