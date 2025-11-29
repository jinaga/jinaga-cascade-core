import { canonicalizeGroupingProperties, computeGroupKey } from './hash';

describe('hash utility', () => {
    describe('canonicalizeGroupingProperties', () => {
        it('should extract and sort grouping properties', () => {
            const obj = { b: 2, a: 1, c: 3 };
            const result = canonicalizeGroupingProperties(obj, ['a', 'b', 'c']);
            expect(result).toBe('{"a":1,"b":2,"c":3}');
        });

        it('should handle single grouping property', () => {
            const obj = { category: 'A', value: 10 };
            const result = canonicalizeGroupingProperties(obj, ['category']);
            expect(result).toBe('{"category":"A"}');
        });

        it('should handle missing properties', () => {
            const obj = { a: 1 };
            const result = canonicalizeGroupingProperties(obj, ['a', 'b']);
            expect(result).toBe('{"a":1}');
        });

        it('should handle different value types', () => {
            const obj = { str: 'test', num: 42, bool: true };
            const result = canonicalizeGroupingProperties(obj, ['str', 'num', 'bool']);
            expect(result).toBe('{"bool":true,"num":42,"str":"test"}');
        });
    });

    describe('computeGroupKey', () => {
        it('should produce consistent hashes for same input', () => {
            const obj = { a: 1, b: 2 };
            const hash1 = computeGroupKey(obj, ['a', 'b']);
            const hash2 = computeGroupKey(obj, ['a', 'b']);
            expect(hash1).toBe(hash2);
        });

        it('should produce different hashes for different inputs', () => {
            const obj1 = { a: 1, b: 2 };
            const obj2 = { a: 2, b: 1 };
            const hash1 = computeGroupKey(obj1, ['a', 'b']);
            const hash2 = computeGroupKey(obj2, ['a', 'b']);
            expect(hash1).not.toBe(hash2);
        });

        it('should be order-independent for grouping properties', () => {
            const obj = { a: 1, b: 2, c: 3 };
            const hash1 = computeGroupKey(obj, ['a', 'b', 'c']);
            const hash2 = computeGroupKey(obj, ['c', 'a', 'b']);
            expect(hash1).toBe(hash2);
        });

        it('should handle string values', () => {
            const obj = { category: 'A' };
            const hash = computeGroupKey(obj, ['category']);
            expect(hash).toBeTruthy();
            expect(typeof hash).toBe('string');
        });

        it('should handle number values', () => {
            const obj = { count: 42 };
            const hash = computeGroupKey(obj, ['count']);
            expect(hash).toBeTruthy();
            expect(typeof hash).toBe('string');
        });

        it('should handle boolean values', () => {
            const obj = { active: true };
            const hash = computeGroupKey(obj, ['active']);
            expect(hash).toBeTruthy();
            expect(typeof hash).toBe('string');
        });
    });
});

