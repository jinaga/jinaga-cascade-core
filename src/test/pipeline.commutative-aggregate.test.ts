import { createPipeline } from '../index';
import type { ImmutableProps, Step } from '../pipeline';
import { AddOperator, CommutativeAggregateStep, SubtractOperator } from '../steps/commutative-aggregate';
import { DropPropertyStep } from '../steps/drop-property';
import { createTestPipeline } from './helpers';

// Helper type aliases for cleaner test code
type NumericAddOp = AddOperator<ImmutableProps, number>;
type NumericSubtractOp = SubtractOperator<ImmutableProps, number>;

describe('CommutativeAggregateStep', () => {
    describe('basic sum aggregation', () => {
        it('should emit aggregate via onModified', () => {
            // Set up: groupBy category, then aggregate items' prices
            const builder = createPipeline<{ category: string; itemName: string; price: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'totalPrice',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ path: string[]; key: string; name: string; value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ path: [...path], key, name, value });
            });
            
            // Trigger add via the input pipeline
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            inputPipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
            
            // Verify aggregate was emitted via onModified
            expect(modifiedEvents.length).toBe(1);
            expect(modifiedEvents[0].name).toBe('totalPrice');
            expect(modifiedEvents[0].value).toBe(500);
        });

        it('should emit immutable props via onAdded WITHOUT aggregate', () => {
            const builder = createPipeline<{ category: string; itemName: string; price: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'totalPrice',
                { add: addOp, subtract: subtractOp }
            );
            
            const addedEvents: Array<{ path: string[]; key: string; props: ImmutableProps }> = [];
            aggregateStep.onAdded([], (path, key, props) => {
                addedEvents.push({ path: [...path], key, props: { ...props } });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            inputPipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
            
            // Verify immutable props are passed through onAdded
            expect(addedEvents.length).toBe(1);
            expect(addedEvents[0].props).toHaveProperty('category', 'Electronics');
            
            // CRITICAL: Verify aggregate is NOT in onAdded props
            expect(addedEvents[0].props).not.toHaveProperty('totalPrice');
        });

        it('should accumulate sum when multiple items are added', () => {
            const builder = createPipeline<{ category: string; itemName: string; price: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'totalPrice',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            inputPipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
            inputPipeline.add('item2', { category: 'Electronics', itemName: 'Laptop', price: 1200 });
            inputPipeline.add('item3', { category: 'Electronics', itemName: 'Tablet', price: 300 });
            
            // Verify aggregates: 500, then 1700, then 2000
            expect(modifiedEvents.length).toBe(3);
            expect(modifiedEvents[0].value).toBe(500);
            expect(modifiedEvents[1].value).toBe(1700);
            expect(modifiedEvents[2].value).toBe(2000);
        });
    });

    describe('subtract functionality', () => {
        it('should reduce aggregate when items are removed', () => {
            const builder = createPipeline<{ category: string; itemName: string; price: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'totalPrice',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value });
            });
            
            const inputPipeline = builder['input'] as {
                add: (key: string, props: any) => void;
                remove: (key: string, props: any) => void;
            };
            
            const item1 = { category: 'Electronics', itemName: 'Phone', price: 500 };
            const item2 = { category: 'Electronics', itemName: 'Laptop', price: 1200 };
            inputPipeline.add('item1', item1);
            inputPipeline.add('item2', item2);
            
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(1700);
            
            // Remove item1 (price: 500)
            inputPipeline.remove('item1', item1);
            
            // Verify aggregate reduced
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(1200);
        });

        it('should emit onModified when item is removed', () => {
            const builder = createPipeline<{ category: string; price: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'total',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ name: string; value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ name, value });
            });
            
            const inputPipeline = builder['input'] as {
                add: (key: string, props: any) => void;
                remove: (key: string, props: any) => void;
            };
            
            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 200 };
            inputPipeline.add('item1', item1);
            inputPipeline.add('item2', item2);
            
            const countBeforeRemove = modifiedEvents.length;
            inputPipeline.remove('item1', item1);
            
            // A new modified event should be emitted
            expect(modifiedEvents.length).toBe(countBeforeRemove + 1);
            expect(modifiedEvents[modifiedEvents.length - 1].name).toBe('total');
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(200);
        });

        it('should handle removal of all items', () => {
            const builder = createPipeline<{ category: string; price: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'total',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value });
            });
            
            const inputPipeline = builder['input'] as {
                add: (key: string, props: any) => void;
                remove: (key: string, props: any) => void;
            };
            
            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 200 };
            inputPipeline.add('item1', item1);
            inputPipeline.add('item2', item2);
            
            inputPipeline.remove('item1', item1);
            inputPipeline.remove('item2', item2);
            
            // Final aggregate should be 0
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(0);
        });
    });

    describe('multiple parents (scoped aggregation)', () => {
        it('should maintain independent aggregate state per parent', () => {
            const builder = createPipeline<{ category: string; itemName: string; price: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'totalPrice',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ key: string; value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ key, value });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            
            // Add items to different categories
            inputPipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
            inputPipeline.add('item2', { category: 'Clothing', itemName: 'Shirt', price: 50 });
            inputPipeline.add('item3', { category: 'Electronics', itemName: 'Laptop', price: 1200 });
            inputPipeline.add('item4', { category: 'Clothing', itemName: 'Pants', price: 80 });
            
            // Verify Electronics aggregate: 500 + 1200 = 1700
            const lastElectronics = modifiedEvents.find(e => e.value === 1700);
            expect(lastElectronics).toBeDefined();
            
            // Verify Clothing aggregate: 50 + 80 = 130
            const lastClothing = modifiedEvents.find(e => e.value === 130);
            expect(lastClothing).toBeDefined();
        });

        it('should not affect other parents when removing from one parent', () => {
            const builder = createPipeline<{ department: string; employee: string; salary: number }>()
                .groupBy(['department'], 'employees');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { salary: number }).salary;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { salary: number }).salary;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['employees'],
                'totalSalary',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ key: string; value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ key, value });
            });
            
            const inputPipeline = builder['input'] as {
                add: (key: string, props: any) => void;
                remove: (key: string, props: any) => void;
            };
            
            // Add employees to two departments
            const emp1 = { department: 'Engineering', employee: 'Alice', salary: 100000 };
            const emp2 = { department: 'Sales', employee: 'Bob', salary: 80000 };
            const emp3 = { department: 'Engineering', employee: 'Carol', salary: 120000 };
            inputPipeline.add('emp1', emp1);
            inputPipeline.add('emp2', emp2);
            inputPipeline.add('emp3', emp3);
            
            // Remove from Engineering
            inputPipeline.remove('emp1', emp1);
            
            // Check Sales total is unchanged (80000)
            // Check Engineering total is now 120000
            const allValues = modifiedEvents.map(e => e.value);
            
            // 80000 should still be present (Sales unchanged)
            expect(allValues).toContain(80000);
            // Engineering should have been reduced from 220000 to 120000
            expect(allValues).toContain(220000); // Engineering: 100000 + 120000
            expect(allValues).toContain(120000); // Engineering after removal
        });
    });

    describe('nested array path', () => {
        it('should navigate through nested arrays correctly', () => {
            // Set up: state > city > venues
            const builder = createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                .groupBy(['state', 'city'], 'venues')
                .groupBy(['state'], 'cities');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { capacity: number }).capacity;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { capacity: number }).capacity;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['cities', 'venues'],
                'totalCapacity',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ path: string[]; key: string; name: string; value: number }> = [];
            aggregateStep.onModified(['cities'], (path, key, name, value) => {
                modifiedEvents.push({ path: [...path], key, name, value });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            
            inputPipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            inputPipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });
            
            // Verify aggregate updates for Dallas city
            expect(modifiedEvents.length).toBeGreaterThan(0);
            expect(modifiedEvents[modifiedEvents.length - 1].name).toBe('totalCapacity');
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(70000);
        });

        it('should maintain separate aggregates for each nested parent', () => {
            const builder = createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                .groupBy(['state', 'city'], 'venues')
                .groupBy(['state'], 'cities');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, _item) => (acc ?? 0) + 1;
            const subtractOp: NumericSubtractOp = (acc, _item) => acc - 1;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['cities', 'venues'],
                'venueCount',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ path: string[]; key: string; value: number }> = [];
            aggregateStep.onModified(['cities'], (path, key, name, value) => {
                modifiedEvents.push({ path: [...path], key, value });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            
            // Add venues to Dallas
            inputPipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            inputPipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });
            
            // Add venues to Houston
            inputPipeline.add('v3', { state: 'TX', city: 'Houston', venue: 'Center', capacity: 18000 });
            
            // Verify Dallas reaches count 2
            expect(modifiedEvents.some(e => e.value === 2)).toBe(true);
            // Verify Houston reaches count 1
            expect(modifiedEvents.some(e => e.value === 1)).toBe(true);
        });
    });

    describe('initial undefined state', () => {
        it('should handle undefined as initial aggregate correctly', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            
            let receivedUndefined = false;
            const addOp: NumericAddOp = (acc, item) => {
                if (acc === undefined) {
                    receivedUndefined = true;
                }
                return (acc ?? 0) + (item as { value: number }).value;
            };
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { value: number }).value;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'sum',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            inputPipeline.add('item1', { category: 'A', value: 10 });
            
            // Verify that the add function received undefined for first item
            expect(receivedUndefined).toBe(true);
            expect(modifiedEvents[0].value).toBe(10);
        });

        it('should receive undefined for first item of each new parent', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            
            const undefinedCount: { count: number } = { count: 0 };
            const addOp: NumericAddOp = (acc, item) => {
                if (acc === undefined) {
                    undefinedCount.count++;
                }
                return (acc ?? 0) + (item as { value: number }).value;
            };
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { value: number }).value;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'sum',
                { add: addOp, subtract: subtractOp }
            );
            
            aggregateStep.onModified([], () => {});
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            
            // First item of category A
            inputPipeline.add('item1', { category: 'A', value: 10 });
            // Second item of category A (should NOT receive undefined)
            inputPipeline.add('item2', { category: 'A', value: 20 });
            // First item of category B (should receive undefined)
            inputPipeline.add('item3', { category: 'B', value: 30 });
            
            // Should have received undefined twice: once for A, once for B
            expect(undefinedCount.count).toBe(2);
        });
    });

    describe('edge cases', () => {
        it('should handle aggregates returning complex objects', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            
            type Stats = { min: number; max: number; sum: number; count: number };
            
            const addOp: AddOperator<ImmutableProps, Stats> = (acc, item) => {
                const value = (item as { value: number }).value;
                if (acc === undefined) {
                    return { min: value, max: value, sum: value, count: 1 };
                }
                return {
                    min: Math.min(acc.min, value),
                    max: Math.max(acc.max, value),
                    sum: acc.sum + value,
                    count: acc.count + 1
                };
            };
            const subtractOp: SubtractOperator<ImmutableProps, Stats> = (acc, item) => {
                const value = (item as { value: number }).value;
                return {
                    min: acc.min, // Note: can't properly update min on removal without full recalc
                    max: acc.max,
                    sum: acc.sum - value,
                    count: acc.count - 1
                };
            };
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'stats',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: Stats }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value: value as Stats });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            inputPipeline.add('item1', { category: 'A', value: 10 });
            inputPipeline.add('item2', { category: 'A', value: 30 });
            inputPipeline.add('item3', { category: 'A', value: 20 });
            
            const lastStats = modifiedEvents[modifiedEvents.length - 1].value;
            expect(lastStats.min).toBe(10);
            expect(lastStats.max).toBe(30);
            expect(lastStats.sum).toBe(60);
            expect(lastStats.count).toBe(3);
        });

        it('should handle single-element arrays', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { value: number }).value;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { value: number }).value;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'total',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value });
            });
            
            const inputPipeline = builder['input'] as {
                add: (key: string, props: any) => void;
                remove: (key: string, props: any) => void;
            };
            
            const item1 = { category: 'A', value: 42 };
            inputPipeline.add('item1', item1);
            
            expect(modifiedEvents[0].value).toBe(42);
            
            inputPipeline.remove('item1', item1);
            
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(0);
        });

        it('should handle zero values correctly', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { value: number }).value;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { value: number }).value;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'total',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            
            inputPipeline.add('item1', { category: 'A', value: 0 });
            inputPipeline.add('item2', { category: 'A', value: 100 });
            inputPipeline.add('item3', { category: 'A', value: 0 });
            
            expect(modifiedEvents[0].value).toBe(0);
            expect(modifiedEvents[1].value).toBe(100);
            expect(modifiedEvents[2].value).toBe(100);
        });

        it('should handle negative values correctly', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { value: number }).value;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { value: number }).value;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'total',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value });
            });
            
            const inputPipeline = builder['input'] as {
                add: (key: string, props: any) => void;
                remove: (key: string, props: any) => void;
            };
            
            const item1 = { category: 'A', value: 100 };
            const item2 = { category: 'A', value: -30 };
            inputPipeline.add('item1', item1);
            inputPipeline.add('item2', item2);
            
            expect(modifiedEvents[0].value).toBe(100);
            expect(modifiedEvents[1].value).toBe(70);
            
            inputPipeline.remove('item2', item2);
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(100);
        });
    });

    describe('event channel verification', () => {
        it('should ONLY emit aggregate through onModified, never through onAdded', () => {
            const builder = createPipeline<{ category: string; price: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'totalPrice',
                { add: addOp, subtract: subtractOp }
            );
            
            const addedProps: ImmutableProps[] = [];
            aggregateStep.onAdded([], (path, key, props) => {
                addedProps.push({ ...props });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            inputPipeline.add('item1', { category: 'Electronics', price: 500 });
            inputPipeline.add('item2', { category: 'Electronics', price: 300 });
            
            // Verify NO onAdded event contains the aggregate property
            addedProps.forEach(props => {
                expect(props).not.toHaveProperty('totalPrice');
            });
        });

        it('should emit aggregate property name correctly in onModified', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { value: number }).value;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { value: number }).value;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'myCustomAggregate',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedNames: string[] = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedNames.push(name);
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            inputPipeline.add('item1', { category: 'A', value: 10 });
            
            expect(modifiedNames).toContain('myCustomAggregate');
        });

        it('should maintain event separation with multiple aggregates (if chained)', () => {
            // This test verifies that adding multiple items still keeps the channels separate
            const builder = createPipeline<{ category: string; price: number; quantity: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { price: number }).price;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { price: number }).price;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'totalPrice',
                { add: addOp, subtract: subtractOp }
            );
            
            const addedEvents: Array<{ props: ImmutableProps }> = [];
            const modifiedEvents: Array<{ name: string; value: number }> = [];
            
            aggregateStep.onAdded([], (path, key, props) => {
                addedEvents.push({ props: { ...props } });
            });
            
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ name, value });
            });
            
            const inputPipeline = builder['input'] as { add: (key: string, props: any) => void };
            
            // Add 5 items
            for (let i = 0; i < 5; i++) {
                inputPipeline.add(`item${i}`, { category: 'A', price: 100, quantity: i + 1 });
            }
            
            // All addedEvents should NOT have aggregate
            addedEvents.forEach(e => {
                expect(e.props).toHaveProperty('category');
                expect(e.props).not.toHaveProperty('totalPrice');
            });
            
            // All modifiedEvents should have the aggregate property name
            modifiedEvents.forEach(e => {
                expect(e.name).toBe('totalPrice');
            });
            
            // Verify final aggregate value
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(500);
        });
    });

    describe('TypeDescriptor transformation', () => {
        it('should NOT remove target array from type descriptor (CommutativeAggregateStep)', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const inputDescriptor = step.getTypeDescriptor();
            
            // Input should have 'items' array
            expect(inputDescriptor.arrays.some(a => a.name === 'items')).toBe(true);
            
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { value: number }).value;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { value: number }).value;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'total',
                { add: addOp, subtract: subtractOp }
            );
            
            const outputDescriptor = aggregateStep.getTypeDescriptor();
            
            // CommutativeAggregateStep should NOT remove the array (that's DropPropertyStep's job)
            expect(outputDescriptor.arrays.some(a => a.name === 'items')).toBe(true);
        });

        it('should remove target array from type descriptor when chained with DropPropertyStep', () => {
            const builder = createPipeline<{ category: string; value: number }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const inputDescriptor = step.getTypeDescriptor();
            
            // Input should have 'items' array
            expect(inputDescriptor.arrays.some(a => a.name === 'items')).toBe(true);
            
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { value: number }).value;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { value: number }).value;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'total',
                { add: addOp, subtract: subtractOp }
            );
            
            // Chain with DropPropertyStep to remove the array
            // Note: 'items' exists as an array in the type descriptor at runtime, even if TypeScript can't infer it
            const dropPropertyStep = new DropPropertyStep<any, any>(aggregateStep, 'items', []);
            
            const outputDescriptor = dropPropertyStep.getTypeDescriptor();
            
            // Output should NOT have 'items' array
            expect(outputDescriptor.arrays.some(a => a.name === 'items')).toBe(false);
        });

        it('should handle nested array path in type descriptor transformation with DropPropertyStep', () => {
            const builder = createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                .groupBy(['state', 'city'], 'venues')
                .groupBy(['state'], 'cities');
            
            const step = builder['lastStep'] as Step;
            const inputDescriptor = step.getTypeDescriptor();
            
            // Input should have nested structure: cities > venues
            expect(inputDescriptor.arrays.some(a => a.name === 'cities')).toBe(true);
            const citiesArray = inputDescriptor.arrays.find(a => a.name === 'cities');
            expect(citiesArray?.type.arrays.some(a => a.name === 'venues')).toBe(true);
            
            const addOp: NumericAddOp = (acc, item) => (acc ?? 0) + (item as { capacity: number }).capacity;
            const subtractOp: NumericSubtractOp = (acc, item) => acc - (item as { capacity: number }).capacity;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['cities', 'venues'],
                'totalCapacity',
                { add: addOp, subtract: subtractOp }
            );
            
            // Chain with DropPropertyStep to remove the nested array
            // Note: 'venues' exists as an array in the type descriptor at runtime, even if TypeScript can't infer it
            const dropPropertyStep = new DropPropertyStep<any, any>(aggregateStep, 'venues', ['cities']);
            
            const outputDescriptor = dropPropertyStep.getTypeDescriptor();
            
            // Output should still have 'cities' but without 'venues'
            expect(outputDescriptor.arrays.some(a => a.name === 'cities')).toBe(true);
            const outputCitiesArray = outputDescriptor.arrays.find(a => a.name === 'cities');
            expect(outputCitiesArray?.type.arrays.some(a => a.name === 'venues')).toBe(false);
        });
    });

    describe('count aggregation', () => {
        it('should correctly count items', () => {
            const builder = createPipeline<{ category: string; name: string }>()
                .groupBy(['category'], 'items');
            
            const step = builder['lastStep'] as Step;
            const addOp: NumericAddOp = (acc, _item) => (acc ?? 0) + 1;
            const subtractOp: NumericSubtractOp = (acc, _item) => acc - 1;
            
            const aggregateStep = new CommutativeAggregateStep(
                step,
                ['items'],
                'count',
                { add: addOp, subtract: subtractOp }
            );
            
            const modifiedEvents: Array<{ value: number }> = [];
            aggregateStep.onModified([], (path, key, name, value) => {
                modifiedEvents.push({ value });
            });
            
            const inputPipeline = builder['input'] as {
                add: (key: string, props: any) => void;
                remove: (key: string, props: any) => void;
            };
            
            const item1 = { category: 'A', name: 'First' };
            const item2 = { category: 'A', name: 'Second' };
            const item3 = { category: 'A', name: 'Third' };
            inputPipeline.add('item1', item1);
            inputPipeline.add('item2', item2);
            inputPipeline.add('item3', item3);
            
            expect(modifiedEvents[0].value).toBe(1);
            expect(modifiedEvents[1].value).toBe(2);
            expect(modifiedEvents[2].value).toBe(3);
            
            inputPipeline.remove('item2', item2);
            
            expect(modifiedEvents[modifiedEvents.length - 1].value).toBe(2);
        });
    });

    describe('CommutativeAggregateStep - Builder API', () => {
        describe('basic sum aggregation', () => {
            it('should compute sum aggregate using builder API', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; itemName: string; price: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'totalPrice',
                            (acc: number | undefined, item) => (acc ?? 0) + item.price,
                            (acc: number, item) => acc - item.price
                        )
                );

                pipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });

                const output = getOutput();
                expect(output.length).toBe(1);
                expect(output[0].category).toBe('Electronics');
                expect(output[0].totalPrice).toBe(500);
            });

            it('should accumulate sum when multiple items are added (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; itemName: string; price: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'totalPrice',
                            (acc: number | undefined, item) => (acc ?? 0) + item.price,
                            (acc: number, item) => acc - item.price
                        )
                );

                pipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
                pipeline.add('item2', { category: 'Electronics', itemName: 'Laptop', price: 1200 });
                pipeline.add('item3', { category: 'Electronics', itemName: 'Tablet', price: 300 });

                const output = getOutput();
                const group = output.find(g => g.category === 'Electronics');
                expect(group).toBeDefined();
                expect(group?.totalPrice).toBe(2000); // 500 + 1200 + 300
            });
        });

        describe('subtract functionality', () => {
            it('should reduce aggregate when items are removed (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; itemName: string; price: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'totalPrice',
                            (acc: number | undefined, item) => (acc ?? 0) + item.price,
                            (acc: number, item) => acc - item.price
                        )
                );

                const item1 = { category: 'Electronics', itemName: 'Phone', price: 500 };
                const item2 = { category: 'Electronics', itemName: 'Laptop', price: 1200 };
                pipeline.add('item1', item1);
                pipeline.add('item2', item2);

                let output = getOutput();
                let group = output.find(g => g.category === 'Electronics');
                expect(group?.totalPrice).toBe(1700);

                pipeline.remove('item1', item1);

                output = getOutput();
                group = output.find(g => g.category === 'Electronics');
                expect(group?.totalPrice).toBe(1200);
            });

            it('should handle removal of all items (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; price: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'total',
                            (acc: number | undefined, item) => (acc ?? 0) + item.price,
                            (acc: number, item) => acc - item.price
                        )
                );

                const item1 = { category: 'A', price: 100 };
                const item2 = { category: 'A', price: 200 };
                pipeline.add('item1', item1);
                pipeline.add('item2', item2);

                pipeline.remove('item1', item1);
                pipeline.remove('item2', item2);

                const output = getOutput();
                // Group should be removed when all items are removed
                expect(output.length).toBe(0);
            });
        });

        describe('multiple parents (scoped aggregation)', () => {
            it('should maintain independent aggregate state per parent (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; itemName: string; price: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'totalPrice',
                            (acc: number | undefined, item) => (acc ?? 0) + item.price,
                            (acc: number, item) => acc - item.price
                        )
                );

                pipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
                pipeline.add('item2', { category: 'Clothing', itemName: 'Shirt', price: 50 });
                pipeline.add('item3', { category: 'Electronics', itemName: 'Laptop', price: 1200 });
                pipeline.add('item4', { category: 'Clothing', itemName: 'Pants', price: 80 });

                const output = getOutput();
                const electronicsGroup = output.find(g => g.category === 'Electronics');
                const clothingGroup = output.find(g => g.category === 'Clothing');

                expect(electronicsGroup?.totalPrice).toBe(1700); // 500 + 1200
                expect(clothingGroup?.totalPrice).toBe(130); // 50 + 80
            });

            it('should not affect other parents when removing from one parent (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ department: string; employee: string; salary: number }>()
                        .groupBy(['department'], 'employees')
                        .commutativeAggregate(
                            'employees',
                            'totalSalary',
                            (acc: number | undefined, item) => (acc ?? 0) + item.salary,
                            (acc: number, item) => acc - item.salary
                        )
                );

                const emp1 = { department: 'Engineering', employee: 'Alice', salary: 100000 };
                const emp2 = { department: 'Sales', employee: 'Bob', salary: 80000 };
                const emp3 = { department: 'Engineering', employee: 'Carol', salary: 120000 };
                pipeline.add('emp1', emp1);
                pipeline.add('emp2', emp2);
                pipeline.add('emp3', emp3);

                let output = getOutput();
                let engineeringGroup = output.find(g => g.department === 'Engineering');
                let salesGroup = output.find(g => g.department === 'Sales');
                expect(engineeringGroup?.totalSalary).toBe(220000); // 100000 + 120000
                expect(salesGroup?.totalSalary).toBe(80000);

                pipeline.remove('emp1', emp1);

                output = getOutput();
                engineeringGroup = output.find(g => g.department === 'Engineering');
                salesGroup = output.find(g => g.department === 'Sales');
                expect(engineeringGroup?.totalSalary).toBe(120000); // Reduced
                expect(salesGroup?.totalSalary).toBe(80000); // Unchanged
            });
        });

        describe('nested array path', () => {
            it('should navigate through nested arrays correctly (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                        .groupBy(['state', 'city'], 'venues')
                        .groupBy(['state'], 'cities')
                        .in('cities').commutativeAggregate(
                            'venues',
                            'totalCapacity',
                            (acc: number | undefined, item) => (acc ?? 0) + item.capacity,
                            (acc: number, item) => acc - item.capacity
                        )
                );

                pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
                pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

                const output = getOutput();
                const txState = output.find(s => s.state === 'TX');
                expect(txState).toBeDefined();
                const dallasCity = (txState?.cities as Array<{ city: string; totalCapacity: number }> | undefined)?.find(c => c.city === 'Dallas');
                expect(dallasCity?.totalCapacity).toBe(70000);
            });

            it('should maintain separate aggregates for each nested parent (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                        .groupBy(['state', 'city'], 'venues')
                        .groupBy(['state'], 'cities')
                        .in('cities').commutativeAggregate(
                            'venues',
                            'venueCount',
                            (acc: number | undefined, _item) => (acc ?? 0) + 1,
                            (acc: number, _item) => acc - 1
                        )
                );

                pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
                pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });
                pipeline.add('v3', { state: 'TX', city: 'Houston', venue: 'Center', capacity: 18000 });

                const output = getOutput();
                const txState = output.find(s => s.state === 'TX');
                const dallasCity = (txState?.cities as Array<{ city: string; venueCount: number }> | undefined)?.find(c => c.city === 'Dallas');
                const houstonCity = (txState?.cities as Array<{ city: string; venueCount: number }> | undefined)?.find(c => c.city === 'Houston');
                
                expect(dallasCity?.venueCount).toBe(2);
                expect(houstonCity?.venueCount).toBe(1);
            });
        });

        describe('edge cases', () => {
            it('should handle zero values correctly (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; value: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'total',
                            (acc: number | undefined, item) => (acc ?? 0) + item.value,
                            (acc: number, item) => acc - item.value
                        )
                );

                pipeline.add('item1', { category: 'A', value: 0 });
                pipeline.add('item2', { category: 'A', value: 100 });
                pipeline.add('item3', { category: 'A', value: 0 });

                const output = getOutput();
                const group = output.find(g => g.category === 'A');
                expect(group?.total).toBe(100);
            });

            it('should handle negative values correctly (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; value: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'total',
                            (acc: number | undefined, item) => (acc ?? 0) + item.value,
                            (acc: number, item) => acc - item.value
                        )
                );

                const item1 = { category: 'A', value: 100 };
                const item2 = { category: 'A', value: -30 };
                pipeline.add('item1', item1);
                pipeline.add('item2', item2);

                let output = getOutput();
                let group = output.find(g => g.category === 'A');
                expect(group?.total).toBe(70);

                pipeline.remove('item2', item2);
                output = getOutput();
                group = output.find(g => g.category === 'A');
                expect(group?.total).toBe(100);
            });

            it('should handle single-element arrays (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; value: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'total',
                            (acc: number | undefined, item) => (acc ?? 0) + item.value,
                            (acc: number, item) => acc - item.value
                        )
                );

                const item1 = { category: 'A', value: 42 };
                pipeline.add('item1', item1);

                let output = getOutput();
                let group = output.find(g => g.category === 'A');
                expect(group?.total).toBe(42);

                pipeline.remove('item1', item1);
                output = getOutput();
                expect(output.length).toBe(0);
            });
        });

        describe('integration with other steps', () => {
            it('should work with dropProperty to keep aggregate but remove array (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; value: number }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'total',
                            (acc: number | undefined, item) => (acc ?? 0) + item.value,
                            (acc: number, item) => acc - item.value
                        )
                        .dropProperty('items')
                );

                pipeline.add('item1', { category: 'A', value: 10 });
                pipeline.add('item2', { category: 'A', value: 20 });
                pipeline.add('item3', { category: 'B', value: 30 });

                let output = getOutput() as Array<{ category: string; total: number; items?: unknown }>;
                expect(output.length).toBe(2);
                const groupA = output.find(g => g.category === 'A');
                const groupB = output.find(g => g.category === 'B');

                expect(groupA?.category).toBe('A');
                expect(groupA?.total).toBe(30);
                expect(groupA?.items).toBeUndefined();

                expect(groupB?.category).toBe('B');
                expect(groupB?.total).toBe(30);
                expect(groupB?.items).toBeUndefined();

                pipeline.remove('item1', { category: 'A', value: 10 });
                output = getOutput() as Array<{ category: string; total: number; items?: unknown }>;
                const groupAAfter = output.find(g => g.category === 'A');
                expect(groupAAfter?.total).toBe(20);
                expect(groupAAfter?.items).toBeUndefined();
            });

            it('should work with defineProperty before aggregation (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; price: number; quantity: number }>()
                        .groupBy(['category'], 'items')
                        .in('items').defineProperty('extendedPrice', (item) => item.price * item.quantity)
                        .commutativeAggregate(
                            'items',
                            'totalRevenue',
                            (acc: number | undefined, item) => (acc ?? 0) + item.extendedPrice,
                            (acc: number, item) => acc - item.extendedPrice
                        )
                );

                pipeline.add('item1', { category: 'A', price: 10, quantity: 2 });
                pipeline.add('item2', { category: 'A', price: 5, quantity: 3 });

                const output = getOutput();
                const group = output.find(g => g.category === 'A');
                expect(group?.totalRevenue).toBe(35); // (10 * 2) + (5 * 3) = 20 + 15
            });
        });

        describe('count aggregation', () => {
            it('should correctly count items (builder API)', () => {
                const [pipeline, getOutput] = createTestPipeline(() => 
                    createPipeline<{ category: string; name: string }>()
                        .groupBy(['category'], 'items')
                        .commutativeAggregate(
                            'items',
                            'count',
                            (acc: number | undefined, _item) => (acc ?? 0) + 1,
                            (acc: number, _item) => acc - 1
                        )
                );

                pipeline.add('item1', { category: 'A', name: 'First' });
                pipeline.add('item2', { category: 'A', name: 'Second' });
                pipeline.add('item3', { category: 'A', name: 'Third' });

                let output = getOutput();
                let group = output.find(g => g.category === 'A');
                expect(group?.count).toBe(3);

                pipeline.remove('item2', { category: 'A', name: 'Second' });
                output = getOutput();
                group = output.find(g => g.category === 'A');
                expect(group?.count).toBe(2);
            });
        });
    });
});