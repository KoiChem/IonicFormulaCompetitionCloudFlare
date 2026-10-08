import type { CompetitionSettings } from "../../../config/public";

export type GameMode = "ion" | "compound";
export type Difficulty = "normal" | "hard";
export type IonAnswerMode = "formula" | "name" | "random";
export type CompoundAnswerMode = "formula" | "name" | "random" | "both";
export type GradingMode = "immediate" | "deferred";

export type IonicFormulaGameSettings = CompetitionSettings & {
  readonly complexEnabled?: boolean;
  readonly complexOnly?: boolean;
  readonly chemistryContentVersion?: string;
  readonly gradingMode?: GradingMode;
  readonly mode: GameMode;
  readonly difficulty: Difficulty;
  readonly ionAnswer: IonAnswerMode;
  readonly compoundPrompts: { readonly formula: boolean; readonly name: boolean };
  readonly compoundAnswer: CompoundAnswerMode;
};

export type AnswerFieldId = "formula" | "name";
export type AnswerField = { readonly id: AnswerFieldId; readonly type: AnswerFieldId };
export type AnswerSpecification = {
  readonly type: AnswerFieldId;
  readonly canonical: string;
  readonly accepted: readonly ({ readonly formula: string; readonly note?: string } | string)[];
};
export type QuestionAnswer = AnswerSpecification | {
  readonly type: "both";
  readonly formula: AnswerSpecification;
  readonly name: AnswerSpecification;
};

export type FormulaCharge = {
  readonly magnitude: number;
  readonly sign: "+" | "-";
  readonly source: "chargeButton" | "typed";
};
export type FormulaEntry = { readonly tokens: readonly string[]; readonly cursor: number; readonly charge: FormulaCharge | null };

export type QuestionPrompt = {
  readonly kind: "ionName" | "ionFormula" | "compoundIons";
  readonly values: readonly { readonly type: "formula" | "name"; readonly value: string; readonly charge?: number }[];
  readonly order?: "cationFirst" | "anionFirst";
};

export type InternalQuestion = {
  readonly id: string;
  readonly ordinal: number;
  readonly itemId: string;
  readonly category: string;
  readonly variant: string;
  readonly prompt: QuestionPrompt;
  readonly fields: readonly AnswerField[];
  readonly maxScore: number;
  readonly answer: QuestionAnswer;
  readonly ionCharge?: number;
  readonly ionFormula?: string;
};

export type QuestionProgress = { readonly resolvedFieldIds: readonly AnswerFieldId[]; readonly fieldStates?: Readonly<Partial<Record<AnswerFieldId, "pending" | "correct" | "passed" | "unanswered">>> };
export type PublicQuestion = Pick<InternalQuestion, "id" | "ordinal" | "prompt" | "fields"> & {
  readonly progress: QuestionProgress;
};

export type FieldEvaluation = {
  readonly correct: boolean;
  readonly empty: boolean;
  readonly matchedAnswerKind: "canonical" | "acceptedAlternative" | null;
  readonly note: string | null;
};
