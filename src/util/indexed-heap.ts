export interface HeapEntry<T> {
    value: T;
    id: string;
}

export class IndexedHeap<T> {
    private entries: HeapEntry<T>[];
    private idToIndex: Map<string, number>;
    private comparator: (a: T, b: T) => number;

    constructor(comparator: (a: T, b: T) => number) {
        this.entries = [];
        this.idToIndex = new Map();
        this.comparator = comparator;
    }

    size(): number {
        return this.entries.length;
    }

    isEmpty(): boolean {
        return this.entries.length === 0;
    }

    peek(): HeapEntry<T> | undefined {
        return this.entries[0];
    }

    insert(value: T, id: string): void {
        this.entries.push({ value, id });
        this.idToIndex.set(id, this.entries.length - 1);
        this.bubbleUp(this.entries.length - 1);
    }

    removeById(id: string): void {
        const index = this.idToIndex.get(id);
        if (index === undefined) {
            return;
        }
        const last = this.entries.length - 1;
        if (index === last) {
            this.entries.pop();
            this.idToIndex.delete(id);
        } else {
            // Move the last entry into the vacated slot, then restore the heap
            // property by sifting in both directions: the replacement may be
            // smaller than its new parent (needs bubbleUp) or larger than a
            // child (needs bubbleDown). Exactly one direction will do work.
            this.entries[index] = this.entries[last];
            this.idToIndex.set(this.entries[index].id, index);
            this.idToIndex.delete(id);
            this.entries.pop();
            this.bubbleDown(index);
            this.bubbleUp(index);
        }
    }

    private swap(i: number, j: number): void {
        const tmp = this.entries[i];
        this.entries[i] = this.entries[j];
        this.entries[j] = tmp;
        this.idToIndex.set(this.entries[i].id, i);
        this.idToIndex.set(this.entries[j].id, j);
    }

    private bubbleDown(index: number): void {
        const length = this.entries.length;
        while (true) {
            const left = 2 * index + 1;
            if (left >= length) {
                break;
            }
            const right = left + 1;
            const best =
                right < length &&
                this.comparator(this.entries[right].value, this.entries[left].value) < 0
                    ? right
                    : left;
            if (this.comparator(this.entries[best].value, this.entries[index].value) < 0) {
                this.swap(index, best);
                index = best;
            } else {
                break;
            }
        }
    }

    private bubbleUp(index: number): void {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.comparator(this.entries[index].value, this.entries[parent].value) < 0) {
                this.swap(index, parent);
                index = parent;
            } else {
                break;
            }
        }
    }
}
