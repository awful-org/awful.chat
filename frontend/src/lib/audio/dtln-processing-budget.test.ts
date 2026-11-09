import { expect, it } from "vitest";
import { DtlnProcessingBudget } from "./dtln-processing-budget";

function ready() {
  const budget = new DtlnProcessingBudget();
  expect(budget.sample(500, 1000, 5000)).toBeNull();
  return budget;
}
it("ignores startup/JIT cost and permits processing with spare headroom", () => {
  const budget = ready();
  for (let i = 0; i < 5; i++) expect(budget.sample(1000, 1000, 300)).toEqual({ load: 0.3, overloaded: false });
});
it("falls back after two sustained expensive windows even when processing keeps up", () => {
  const budget = ready();
  expect(budget.sample(1000, 1000, 700)).toEqual({ load: 0.7, overloaded: false });
  expect(budget.sample(1000, 1000, 700)).toEqual({ load: 0.7, overloaded: true });
});
it("does not disable DTLN for one expensive window", () => {
  const budget = ready();
  budget.sample(1000, 1000, 900);
  expect(budget.sample(1000, 1000, 200)?.overloaded).toBe(false);
  expect(budget.sample(1000, 1000, 900)?.overloaded).toBe(false);
});
it("accumulates work by represented audio duration at the native sample rate", () => {
  const budget = ready();
  for (let i = 0; i < 3; i++) expect(budget.sample(12000, 48000, 175)).toBeNull();
  expect(budget.sample(12000, 48000, 175)).toEqual({ load: 0.7, overloaded: false });
});
