import { IndexedHeap, HeapEntry } from '../util/indexed-heap';

function givenMinHeap(): IndexedHeap<number> {
    return new IndexedHeap<number>((a, b) => a - b);
}

describe('IndexedHeap', () => {
    it('should create an empty heap', () => {
        const heap = givenMinHeap();

        const actualSize = heap.size();
        const actualIsEmpty = heap.isEmpty();

        expect(actualSize).toBe(0); // A newly constructed IndexedHeap should report size 0
        expect(actualIsEmpty).toBe(true); // A newly constructed IndexedHeap should report isEmpty() true
    });

    it('should return undefined when peeking an empty heap', () => {
        const heap = givenMinHeap();

        const actualPeek: HeapEntry<number> | undefined = heap.peek();

        expect(actualPeek).toBeUndefined(); // peek() on an empty heap has no minimum element to return
    });

    it('should insert a single element and peek it', () => {
        const heap = givenMinHeap();

        heap.insert(42, 'a');

        const actualSize = heap.size();
        const actualIsEmpty = heap.isEmpty();
        const actualPeek = heap.peek();

        expect(actualSize).toBe(1); // After inserting one element, size should be 1
        expect(actualIsEmpty).toBe(false); // After inserting one element, isEmpty should be false
        expect(actualPeek).toEqual({ value: 42, id: 'a' }); // peek() should return the inserted entry
    });

    it('should maintain min-heap order with two elements', () => {
        // Case 1: insert larger value first, then smaller — requires bubble-up to swap root
        const heapLargeFirst = givenMinHeap();
        heapLargeFirst.insert(10, 'a');
        heapLargeFirst.insert(5, 'b');

        const actualPeekLargeFirst = heapLargeFirst.peek();
        expect(actualPeekLargeFirst).toEqual({ value: 5, id: 'b' }); // After inserting (10,'a') then (5,'b'), the min-heap root must be the smaller entry (5,'b'), not the first-inserted (10,'a')

        // Case 2: insert smaller value first — no swap needed, root is already minimum
        const heapSmallFirst = givenMinHeap();
        heapSmallFirst.insert(5, 'c');
        heapSmallFirst.insert(10, 'd');

        const actualPeekSmallFirst = heapSmallFirst.peek();
        expect(actualPeekSmallFirst).toEqual({ value: 5, id: 'c' }); // After inserting (5,'c') then (10,'d'), the min-heap root must remain the smaller entry (5,'c')
    });

    it('should maintain min-heap order with three elements requiring no rotation', () => {
        const heap = givenMinHeap();

        heap.insert(1, 'a');
        heap.insert(2, 'b');
        heap.insert(3, 'c');

        const actualPeek = heap.peek();
        const actualSize = heap.size();

        // Inserting in ascending order places each new element at a child position (2i+1 or 2i+2)
        // with a value greater than its parent — no bubble-up swaps occur.
        // The minimum element (1,'a') must remain at the root.
        expect(actualSize).toBe(3); // After three inserts, size must be 3
        expect(actualPeek).toEqual({ value: 1, id: 'a' }); // Root of min-heap must be the smallest inserted entry (1,'a'); no swaps should disturb it
    });

    it('should support max-heap via reversed comparator', () => {
        const heap = new IndexedHeap<number>((a, b) => b - a);

        heap.insert(10, 'a');
        heap.insert(20, 'b');
        heap.insert(5, 'c');

        const actualPeek = heap.peek();

        // A reversed comparator (b - a) makes bubbleUp swap when the child is LARGER than
        // its parent, so the greatest value rises to the root. After inserting (10,'a'),
        // (20,'b'), and (5,'c'), the entry with value 20 must be at the root.
        expect(actualPeek).toEqual({ value: 20, id: 'b' }); // With comparator (a,b)=>b-a the heap orders largest-first; (20,'b') must be at root, not (10,'a') or (5,'c')
    });

    it('should remove the only element by id', () => {
        const heap = givenMinHeap();
        heap.insert(42, 'a');

        heap.removeById('a');

        const actualSize = heap.size();
        const actualIsEmpty = heap.isEmpty();
        const actualPeek = heap.peek();

        expect(actualSize).toBe(0); // After removing the only element, size must be 0
        expect(actualIsEmpty).toBe(true); // After removing the only element, isEmpty must return true
        expect(actualPeek).toBeUndefined(); // After removing the only element, peek must return undefined — the heap is empty
    });

    it('should bubble up through multiple levels', () => {
        const heap = givenMinHeap();

        heap.insert(30, 'a');
        heap.insert(20, 'b');
        heap.insert(10, 'c');
        heap.insert(5, 'd');

        const actualPeek = heap.peek();
        const actualSize = heap.size();

        // After inserting (30,'a'), (20,'b'), (10,'c'), (5,'d') in descending order,
        // each new element is smaller than its ancestors. The last element (5,'d') must
        // bubble up past its parent (20,'b') and then its grandparent (10,'c' or 20,'b')
        // to reach the root — requiring the bubble-up loop to iterate more than once.
        expect(actualSize).toBe(4); // After four inserts, size must be 4
        expect(actualPeek).toEqual({ value: 5, id: 'd' }); // After multi-level bubble-up, (5,'d') must be at the root as the minimum element
    });

    it('should remove the last element without heap fix', () => {
        const heap = givenMinHeap();

        heap.insert(1, 'a');
        heap.insert(5, 'b');
        heap.insert(3, 'c');

        // After inserting (1,'a'), (5,'b'), (3,'c'), the internal array is:
        //   index 0: (1,'a') — root
        //   index 1: (5,'b') — left child (5 > 1, no bubble-up)
        //   index 2: (3,'c') — right child (3 > 1, no bubble-up)
        // "c" is at index 2, which is the last position. Removing it requires only a
        // pop and an index-map delete — no swap or sift-down needed.
        heap.removeById('c');

        const actualSize = heap.size();
        const actualPeek = heap.peek();

        expect(actualSize).toBe(2); // After removing one of three elements, size must be 2, not 3 or 1
        expect(actualPeek).toEqual({ value: 1, id: 'a' }); // The min-heap root must still be (1,'a') after removing the last-position element (3,'c')
        // Verify "c" is gone from the index map by re-removing it — must be a no-op, not a throw
        expect(() => heap.removeById('c')).not.toThrow(); // removeById('c') a second time must be a no-op; 'c' must have been deleted from the index map
    });

    it('should remove the root and promote the next smallest', () => {
        const heap = givenMinHeap();

        heap.insert(1, 'a');
        heap.insert(5, 'b');
        heap.insert(3, 'c');

        // After inserting, the internal array is:
        //   index 0: (1,'a') — root
        //   index 1: (5,'b') — left child
        //   index 2: (3,'c') — right child
        // Removing 'a' (index 0, not the last): swap with last element (3,'c'),
        // pop (1,'a'), then bubble down (3,'c') from the root.
        // Left child is (5,'b'); since 3 < 5, (3,'c') is already correct — no swap needed.
        heap.removeById('a');

        const actualSize = heap.size();
        const actualPeek = heap.peek();

        expect(actualSize).toBe(2); // After removing the root from a 3-element heap, size must be 2
        expect(actualPeek).toEqual({ value: 3, id: 'c' }); // After removing (1,'a'), the next smallest is (3,'c') and must be promoted to root via swap-with-last and bubble-down
    });

    it('should handle remove-by-id where swapped element bubbles up', () => {
        const heap = givenMinHeap();

        // Build a 10-element min-heap. Inserts produce this exact internal array
        // (verified: each new element's value exceeds its parent, so no bubble-up fires):
        //   index 0: (1,  'a')
        //   index 1: (2,  'b')
        //   index 2: (5,  'c')
        //   index 3: (6,  'd')
        //   index 4: (3,  'e')
        //   index 5: (20, 'f')  ← will be removed
        //   index 6: (8,  'g')
        //   index 7: (10, 'h')
        //   index 8: (9,  'i')
        //   index 9: (4,  'j')  ← last element at removal time
        heap.insert(1,  'a');
        heap.insert(2,  'b');
        heap.insert(5,  'c');
        heap.insert(6,  'd');
        heap.insert(3,  'e');
        heap.insert(20, 'f');
        heap.insert(8,  'g');
        heap.insert(10, 'h');
        heap.insert(9,  'i');
        heap.insert(4,  'j');

        // Remove 'f' (value 20, index 5). The last element (4,'j') at index 9 swaps
        // into index 5. Its new parent is (5,'c') at index 2. Since 4 < 5, (4,'j')
        // must bubble UP. Without bubbleUp, (4,'j') sits under (5,'c') — a heap
        // violation. bubbleDown is a no-op here because index 5 has no children.
        heap.removeById('f');

        // Drain the heap by repeatedly extracting the minimum. Correct ascending
        // order: 1, 2, 3, 4, 5, 6, 8, 9, 10. With the bubbleUp bug, the violation
        // propagates through the drain: at the fourth extraction the misplaced (5,'c')
        // floats to the root before (4,'j') can, yielding 1, 2, 3, 5, 4, … — wrong.
        const drainOrder: number[] = [];
        while (!heap.isEmpty()) {
            const top = heap.peek()!;
            drainOrder.push(top.value);
            heap.removeById(top.id);
        }

        expect(drainOrder).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10]);
    });

    it('should allow duplicate values with different ids', () => {
        const heap = givenMinHeap();

        heap.insert(42, 'a');
        heap.insert(42, 'b');
        heap.insert(42, 'c');

        const sizeAfterInserts = heap.size();
        expect(sizeAfterInserts).toBe(3); // After inserting three entries with the same value but different ids, size must be 3 — each id is a distinct slot in the index map

        const firstPeek = heap.peek();
        expect(firstPeek).toBeDefined(); // heap is non-empty so peek() must return an entry
        expect(firstPeek!.value).toBe(42); // All entries have value 42, so the root must have value 42 regardless of which entry was placed there

        // Remove the current root by id — one of the three 42-valued entries
        heap.removeById(firstPeek!.id);

        const sizeAfterFirstRemove = heap.size();
        expect(sizeAfterFirstRemove).toBe(2); // After removing one of three entries, size must be 2

        const secondPeek = heap.peek();
        expect(secondPeek).toBeDefined(); // Two entries remain so peek() must still return an entry
        expect(secondPeek!.value).toBe(42); // The remaining entries both have value 42, so the new root must also have value 42
        expect(secondPeek!.id).not.toBe(firstPeek!.id); // The remaining root must have a different id than the one just removed — the index map must track each id independently

        // Remove the second entry
        heap.removeById(secondPeek!.id);

        const sizeAfterSecondRemove = heap.size();
        expect(sizeAfterSecondRemove).toBe(1); // After removing two of three entries, size must be 1

        const thirdPeek = heap.peek();
        expect(thirdPeek).toBeDefined(); // One entry remains so peek() must still return an entry
        expect(thirdPeek!.value).toBe(42); // The last remaining entry must still have value 42

        // Remove the final entry — heap must become empty
        heap.removeById(thirdPeek!.id);

        const isEmptyAfterAll = heap.isEmpty();
        expect(isEmptyAfterAll).toBe(true); // After removing all three entries, isEmpty() must return true — no stale entries must remain in the index map or entries array
    });

    it('should support string values with a custom comparator', () => {
        const heap = new IndexedHeap<string>((a, b) => a < b ? -1 : a > b ? 1 : 0);

        heap.insert('banana', '1');
        heap.insert('apple', '2');
        heap.insert('cherry', '3');

        const peekAfterInserts = heap.peek();
        expect(peekAfterInserts).toEqual({ value: 'apple', id: '2' }); // After inserting 'banana', 'apple', 'cherry' with a lexicographic comparator, the root must be the lexicographic minimum ('apple','2'), not the first-inserted ('banana','1')

        heap.removeById('2');

        const peekAfterRemove = heap.peek();
        expect(peekAfterRemove).toEqual({ value: 'banana', id: '1' }); // After removing ('apple','2'), the new lexicographic minimum must be ('banana','1') at the root; ('cherry','3') must remain a child
    });

    it('should maintain index map consistency through a sequence of mixed operations', () => {
        const heap = givenMinHeap();

        // Step 1: Insert 7 elements
        heap.insert(15, 'a');
        heap.insert(3,  'b');
        heap.insert(7,  'c');
        heap.insert(1,  'd');
        heap.insert(20, 'e');
        heap.insert(5,  'f');
        heap.insert(11, 'g');

        // Step 2: Verify size after all 7 inserts
        const sizeAfterInserts = heap.size();
        expect(sizeAfterInserts).toBe(7); // After inserting 7 elements, size must be 7

        // Step 3: Remove root (peek and remove) — must be the minimum, which is 1
        const root = heap.peek();
        expect(root).toEqual({ value: 1, id: 'd' }); // The min-heap root must be (1,'d'), the smallest inserted value
        heap.removeById('d');

        // Step 4: Remove 'c' (value 7, a middle node)
        heap.removeById('c');
        const sizeAfterTwoRemoves = heap.size();
        expect(sizeAfterTwoRemoves).toBe(5); // After removing root ('d') and middle node ('c'), size must drop from 7 to 5

        // Step 5: Remove 'a' (value 15, another interior node)
        heap.removeById('a');
        const sizeAfterThreeRemoves = heap.size();
        expect(sizeAfterThreeRemoves).toBe(4); // After removing 'a' (value 15), size must drop to 4

        // Step 6: Insert (2,'h') and (9,'i')
        heap.insert(2, 'h');
        heap.insert(9, 'i');
        const sizeAfterTwoInserts = heap.size();
        expect(sizeAfterTwoInserts).toBe(6); // After inserting two more elements, size must be 6

        // Step 7: Remove 'e' (value 20, near the end)
        heap.removeById('e');
        const sizeAfterFourthRemove = heap.size();
        expect(sizeAfterFourthRemove).toBe(5); // After removing 'e' (value 20), size must drop to 5

        // Step 8: Remove 'b' (value 3)
        heap.removeById('b');
        const sizeAfterFifthRemove = heap.size();
        expect(sizeAfterFifthRemove).toBe(4); // After removing 'b' (value 3), size must drop to 4

        // Step 9: Drain remaining elements — remaining are (5,'f'), (9,'i'), (11,'g'), (2,'h')
        // Expected ascending drain order: 2, 5, 9, 11
        const drainOrder: number[] = [];
        while (!heap.isEmpty()) {
            const top = heap.peek()!;
            drainOrder.push(top.value);
            heap.removeById(top.id);
        }

        expect(drainOrder).toEqual([2, 5, 9, 11]); // After all mixed insert/remove operations, draining the remaining 4 elements must yield values in ascending order; any deviation indicates a heap-property violation or index-map corruption from one of the earlier operations
    });

    it('should be a no-op when removing a non-existent id', () => {
        const heap = givenMinHeap();

        heap.insert(10, 'a');
        heap.insert(20, 'b');

        expect(() => heap.removeById('z')).not.toThrow(); // removeById with an unknown id must not throw — the guard clause must return early

        const actualSize = heap.size();
        const actualPeek = heap.peek();

        expect(actualSize).toBe(2); // After inserting 2 elements and calling removeById('z') for a non-existent id, size must still be 2 — no element was removed
        expect(actualPeek).toEqual({ value: 10, id: 'a' }); // After a no-op removeById('z'), the min-heap root must remain (10,'a') — the heap state must be unchanged
    });

    it('should be a no-op when removing from an empty heap', () => {
        const heap = givenMinHeap();

        expect(() => heap.removeById('x')).not.toThrow(); // removeById on an empty heap must not throw — the index map is empty so the guard clause must return early without any array access

        const actualIsEmpty = heap.isEmpty();

        expect(actualIsEmpty).toBe(true); // After constructing an empty heap and calling removeById('x'), isEmpty() must still return true — no state corruption must occur
    });

    it('should handle insert then remove then insert with the same id', () => {
        const heap = givenMinHeap();

        // Insert (10, 'a') — 'a' occupies index 0 (the root)
        heap.insert(10, 'a');

        // Remove 'a' — the index map must fully clean up the entry for 'a'
        heap.removeById('a');

        // Re-insert 'a' with a new value (20). A stale entry in the index map would
        // either skip the re-insert or corrupt the heap's internal bookkeeping.
        heap.insert(20, 'a');

        const actualSize = heap.size();
        const actualPeek = heap.peek();

        expect(actualSize).toBe(1); // After insert→remove→insert of the same id, size must be 1; a lingering stale entry in idToIndex would produce incorrect behavior
        expect(actualPeek).toEqual({ value: 20, id: 'a' }); // peek() must return (20,'a') — the fresh re-insertion — not undefined or a stale (10,'a')
    });

    it('should correctly remove the root when heap has exactly two elements', () => {
        const heap = givenMinHeap();

        heap.insert(5, 'a');
        heap.insert(10, 'b');

        // Remove 'a' (value 5, the root at index 0). The heap has exactly two elements:
        //   index 0: (5,'a')  — root
        //   index 1: (10,'b') — only child
        // Implementation: since index 0 !== last (index 1), swap last (10,'b') into index 0,
        // pop (5,'a'), then call bubbleDown(0). After the pop, length is 1, so left child
        // index = 2*0+1 = 1 >= 1 — the loop must break immediately with no swap.
        // Then bubbleUp(0): index is 0 so the while-condition (index > 0) is false — no-op.
        heap.removeById('a');

        const peekAfterFirstRemove = heap.peek();
        const sizeAfterFirstRemove = heap.size();

        expect(sizeAfterFirstRemove).toBe(1); // After removing the root from a 2-element heap, size must be 1, not 0 or 2
        expect(peekAfterFirstRemove).toEqual({ value: 10, id: 'b' }); // After removing the smaller root (5,'a'), the remaining element (10,'b') must become the new root

        // Remove the last remaining element
        heap.removeById('b');

        const isEmptyAfterSecondRemove = heap.isEmpty();
        expect(isEmptyAfterSecondRemove).toBe(true); // After removing both elements, isEmpty() must return true — the index map and entries array must both be fully drained
    });

    it('should remove a middle element and restore heap order', () => {
        const heap = givenMinHeap();

        // Build a 5-element min-heap. With ascending-then-varied inserts:
        //   index 0: (1,'a')  — root
        //   index 1: (10,'b') — left child of root
        //   index 2: (5,'c')  — right child of root
        //   index 3: (20,'d') — left child of 'b'
        //   index 4: (15,'e') — right child of 'b'
        heap.insert(1, 'a');
        heap.insert(10, 'b');
        heap.insert(5, 'c');
        heap.insert(20, 'd');
        heap.insert(15, 'e');

        // Remove 'b' (value 10) — an interior non-root, non-last node.
        // Implementation: swap 'b' at index 1 with last element (15,'e') at index 4,
        // pop (10,'b'), leaving (15,'e') at index 1 with children (20,'d') at index 3.
        // 15 < 20, so no bubble-down needed. 15 > 1 (parent), so no bubble-up needed.
        heap.removeById('b');

        const actualPeek = heap.peek();
        const actualSize = heap.size();

        expect(actualSize).toBe(4); // After removing one of five elements, size must be 4
        expect(actualPeek).toEqual({ value: 1, id: 'a' }); // Removing an interior non-root node must not displace (1,'a') from the root

        // Drain the heap by repeatedly extracting the minimum to verify heap order is intact.
        // Expected ascending drain order: 1, 5, 15, 20.
        const drainOrder: Array<{ value: number; id: string }> = [];
        while (!heap.isEmpty()) {
            const top = heap.peek()!;
            drainOrder.push({ value: top.value, id: top.id });
            heap.removeById(top.id);
        }

        expect(drainOrder.map(e => e.value)).toEqual([1, 5, 15, 20]); // Draining the heap after removing (10,'b') must yield values in ascending order; any out-of-order entry indicates the heap property was violated by removeById
    });

    it('should handle removing all elements one by one', () => {
        const heap = givenMinHeap();

        // Insert 5 elements with varied values and ids
        heap.insert(3, 'a');
        heap.insert(1, 'b');
        heap.insert(4, 'c');
        heap.insert(1, 'd');
        heap.insert(5, 'e');

        // Remove in an order that exercises root, middle, and last removal paths
        // interleaved: 'c' (value 4, interior), 'a' (value 3, interior), 'e' (value 5, last),
        // 'b' (value 1, root), 'd' (value 1, only remaining element)
        heap.removeById('c');
        const sizeAfterFirst = heap.size();
        expect(sizeAfterFirst).toBe(4); // After removing 'c' (1 of 5 elements), size must be 4

        heap.removeById('a');
        const sizeAfterSecond = heap.size();
        expect(sizeAfterSecond).toBe(3); // After removing 'a' (2 of 5 elements), size must be 3

        heap.removeById('e');
        const sizeAfterThird = heap.size();
        expect(sizeAfterThird).toBe(2); // After removing 'e' (3 of 5 elements), size must be 2

        heap.removeById('b');
        const sizeAfterFourth = heap.size();
        expect(sizeAfterFourth).toBe(1); // After removing 'b' (4 of 5 elements), size must be 1

        heap.removeById('d');
        const sizeAfterFifth = heap.size();
        const isEmptyAfterAll = heap.isEmpty();

        expect(sizeAfterFifth).toBe(0); // After removing all 5 elements one by one, size must be 0 — no stale entries must remain in the index map
        expect(isEmptyAfterAll).toBe(true); // After removing all 5 elements, isEmpty() must return true — the heap must be fully drained regardless of removal order (root, middle, last interleaved)
    });

    it('should handle a large number of elements and produce sorted output', () => {
        const heap = givenMinHeap();

        // Insert 100 elements with deterministic, varied values: value = (i * 37 + 13) % 100
        // This produces values in the range 0-99 with repetitions — a non-trivial ordering
        // that exercises bubble-up, bubble-down, and index-map correctness across a full binary
        // tree of depth 7.
        for (let i = 0; i < 100; i++) {
            const value = (i * 37 + 13) % 100;
            const id = 'item' + i;
            heap.insert(value, id);
        }

        const sizeAfterInserts = heap.size();
        expect(sizeAfterInserts).toBe(100); // After inserting 100 elements, size must be exactly 100

        // Drain by repeatedly peeking and removing the root.
        // For a correct min-heap, each extracted value must be >= the previous extracted value.
        const drainedValues: number[] = [];
        while (!heap.isEmpty()) {
            const top = heap.peek()!;
            drainedValues.push(top.value);
            heap.removeById(top.id);
        }

        expect(drainedValues).toHaveLength(100); // Draining must yield exactly 100 values — one per inserted element

        const sortedExpected = [...drainedValues].sort((a, b) => a - b);
        expect(drainedValues).toEqual(sortedExpected); // Draining a 100-element min-heap must yield values in non-decreasing order; any out-of-order pair indicates a heap-property violation or index-map corruption that only surfaces with deeper trees

        const isEmptyAfterDrain = heap.isEmpty();
        expect(isEmptyAfterDrain).toBe(true); // After draining all 100 elements, isEmpty() must return true — no stale entries must remain
    });
});
