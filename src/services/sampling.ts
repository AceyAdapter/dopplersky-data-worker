import { createHash } from "node:crypto";

type Entry<T> = { score: string; value: T };

export class BottomKSampler<T> {
  readonly limit: number;
  readonly seed: string;
  #heap: Entry<T>[] = [];
  #seen = 0;

  constructor(limit: number, seed: string) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be positive");
    this.limit = limit;
    this.seed = seed;
  }

  get seen(): number {
    return this.#seen;
  }

  add(key: string, value: T): void {
    this.#seen += 1;
    const entry = {
      score: createHash("sha256").update(this.seed).update("\0").update(key).digest("hex"),
      value,
    };
    if (this.#heap.length < this.limit) {
      this.#heap.push(entry);
      this.#bubbleUp(this.#heap.length - 1);
    } else if (entry.score < this.#heap[0]!.score) {
      this.#heap[0] = entry;
      this.#bubbleDown(0);
    }
  }

  values(): T[] {
    return [...this.#heap].sort((a, b) => a.score.localeCompare(b.score)).map((entry) => entry.value);
  }

  inclusionProbability(): number {
    return this.#seen === 0 ? 1 : Math.min(1, this.limit / this.#seen);
  }

  #bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#heap[parent]!.score >= this.#heap[index]!.score) break;
      [this.#heap[parent], this.#heap[index]] = [this.#heap[index]!, this.#heap[parent]!];
      index = parent;
    }
  }

  #bubbleDown(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < this.#heap.length && this.#heap[left]!.score > this.#heap[largest]!.score) largest = left;
      if (right < this.#heap.length && this.#heap[right]!.score > this.#heap[largest]!.score) largest = right;
      if (largest === index) return;
      [this.#heap[index], this.#heap[largest]] = [this.#heap[largest]!, this.#heap[index]!];
      index = largest;
    }
  }
}
