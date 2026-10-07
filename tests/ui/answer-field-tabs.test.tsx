import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerFieldTabs } from "../../src/features/play/AnswerFieldTabs";

describe("answer field tabs", () => {
  it("labels a passed formula separately from a pending name", () => {
    const html = renderToStaticMarkup(createElement(AnswerFieldTabs, {
      fields: [{ id: "formula", type: "formula" }, { id: "name", type: "name" }],
      fieldStates: { formula: "passed", name: "pending" },
      selectedFieldId: "name",
      mode: "compound",
      onSelect: () => {},
    }));
    expect(html).toContain("パス済み");
    expect(html).toContain('data-field-state="passed"');
    expect(html).toContain("解答中");
    expect(html).not.toContain("正解済み");
  });
});
