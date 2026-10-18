import { describe, expect, it } from "vitest";
import { BottomKSampler } from "./sampling.js";

describe(BottomKSampler, () => {
  it("produces an order-independent deterministic sample and its inclusion probability", () => {
    const ascending = new BottomKSampler<number>(100, "cohort-seed");
    const descending = new BottomKSampler<number>(100, "cohort-seed");
    for (let value = 0; value < 1_000; value += 1) ascending.add(String(value), value);
    for (let value = 999; value >= 0; value -= 1) descending.add(String(value), value);

    expect(ascending.values()).toEqual(descending.values());
    expect(ascending.values()).toHaveLength(100);
    expect(ascending.inclusionProbability()).toBe(0.1);
  });
});
