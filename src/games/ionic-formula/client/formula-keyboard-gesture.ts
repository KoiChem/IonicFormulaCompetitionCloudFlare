export const CASE_FLICK_MIN_DISTANCE_PX = 18;
export const CASE_FLICK_AXIS_RATIO = 1.25;

export type FormulaLetterGesture = "tap" | "alternate" | "cancel";

export function classifyCaseFlick(deltaX: number, deltaY: number, uppercase: boolean): FormulaLetterGesture {
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < CASE_FLICK_MIN_DISTANCE_PX) return "tap";
  if (Math.abs(deltaY) < CASE_FLICK_MIN_DISTANCE_PX) return "cancel";
  if (Math.abs(deltaY) < Math.abs(deltaX) * CASE_FLICK_AXIS_RATIO) return "cancel";
  return (uppercase && deltaY > 0) || (!uppercase && deltaY < 0) ? "alternate" : "cancel";
}

export function alternateCaseLetter(letter: string, uppercase: boolean): string {
  return uppercase ? letter.toLowerCase() : letter.toUpperCase();
}

export function classifyBracketFlick(deltaX: number, deltaY: number): FormulaLetterGesture {
  if (Math.hypot(deltaX, deltaY) < CASE_FLICK_MIN_DISTANCE_PX) return "tap";
  if (Math.abs(deltaY) < CASE_FLICK_MIN_DISTANCE_PX || Math.abs(deltaY) < Math.abs(deltaX) * CASE_FLICK_AXIS_RATIO) return "cancel";
  return "alternate";
}

export function shouldHandleFormulaLetterClick(detail: number, pointerType = ""): boolean {
  return !(Number(detail) > 0 || ["mouse", "pen", "touch"].includes(pointerType));
}
