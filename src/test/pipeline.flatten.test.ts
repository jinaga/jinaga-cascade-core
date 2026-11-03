import { createPipeline, type KeyedArray, type SourceArrayDescriptor } from '../index';
import { createTestPipeline } from './helpers';

type VenueRow = {
    state: string;
    city: string;
    venue: string;
    seats: number;
};

function sortByJson<T>(items: T[]): T[] {
    return [...items].sort((a, b) => {
        const left = JSON.stringify(a);
        const right = JSON.stringify(b);
        if (left < right) {
            return -1;
        }
        if (left > right) {
            return 1;
        }
        return 0;
    });
}

describe('pipeline flatten', () => {
    it('should emit one flattened item per parent-child pair and preserve scope scalars', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<VenueRow>()
                .groupBy(['state'], 'states')
                .in('items').groupBy(['city'], 'cities')
                .flatten('cities', 'items', 'flatVenues')
        );

        pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', seats: 50000 });
        pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', seats: 20000 });
        pipeline.add('v3', { state: 'TX', city: 'Houston', venue: 'Center', seats: 30000 });

        const output = getOutput();
        expect(output).toHaveLength(1);
        expect(output[0].state).toBe('TX');
        expect(output[0].flatVenues).toHaveLength(3);
        expect(sortByJson(output[0].flatVenues)).toEqual(sortByJson([
            { city: 'Dallas', venue: 'Stadium', seats: 50000 },
            { city: 'Dallas', venue: 'Arena', seats: 20000 },
            { city: 'Houston', venue: 'Center', seats: 30000 }
        ]));
    });

    // The types reject a flatten whose parent and child share a name. When the descriptor does not
    // declare the child's name, the runtime cannot see the collision either; an untyped caller then
    // gets the child's value.
    it('an untyped caller whose child has an undeclared name of the parent\'s gets the child\'s value', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ state: string; city: string; label: string; venue: string; seats: number }>()
                .groupBy(['state'], 'states')
                .in('items').groupBy(['city'], 'cities')
                .in('cities').defineProperty('label', city => `parent-${city.city}`)
                // @ts-expect-error The parent and the child both have `label`.
                .flatten('cities', 'items', 'flatVenues')
        );

        pipeline.add('v1', { state: 'TX', city: 'Dallas', label: 'child-label', venue: 'Stadium', seats: 50000 });
        const output = getOutput();

        expect(output[0].flatVenues).toHaveLength(1);
        expect(output[0].flatVenues[0].label).toBe('child-label');
    });

    it('an untyped caller keeps the child\'s value when the parent\'s value of the same name changes', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ state: string; city: string; score: number; one: number }>()
                .groupBy(['state'], 'states')
                .in('items').groupBy(['city'], 'cities')
                .in('cities').sum('items', 'one', 'score')
                // @ts-expect-error The parent and the child both have `score`.
                .flatten('cities', 'items', 'flatRows')
        );

        pipeline.add('r1', { state: 'TX', city: 'Dallas', score: 101, one: 1 });
        let output = getOutput();
        expect(output[0].flatRows).toEqual([{ city: 'Dallas', score: 101, one: 1 }]);

        // Adding a second child updates the parent aggregate "score" from 1 -> 2.
        // Child-level score values should still win on name collision.
        pipeline.add('r2', { state: 'TX', city: 'Dallas', score: 202, one: 1 });
        output = getOutput();
        const scores = sortByJson(output[0].flatRows.map((row) => row.score));

        expect(scores).toEqual(sortByJson([101, 202]));
    });

    it('should remove flattened children when children are removed and when a parent is depleted', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<VenueRow>()
                .groupBy(['state'], 'states')
                .in('items').groupBy(['city'], 'cities')
                .flatten('cities', 'items', 'flatVenues')
        );

        const d1 = { state: 'TX', city: 'Dallas', venue: 'Stadium', seats: 50000 };
        const d2 = { state: 'TX', city: 'Dallas', venue: 'Arena', seats: 20000 };
        const h1 = { state: 'TX', city: 'Houston', venue: 'Center', seats: 30000 };
        pipeline.add('d1', d1);
        pipeline.add('d2', d2);
        pipeline.add('h1', h1);
        expect(getOutput()[0].flatVenues).toHaveLength(3);

        pipeline.remove('d2', d2);
        let output = getOutput();
        expect(output[0].flatVenues).toHaveLength(2);
        expect(output[0].flatVenues.some(v => v.venue === 'Arena')).toBe(false);

        pipeline.remove('d1', d1);
        output = getOutput();
        expect(output[0].flatVenues).toHaveLength(1);
        expect(output[0].flatVenues[0].venue).toBe('Center');
    });

    it('should fan out parent mutable property changes to all flattened children', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<VenueRow>()
                .groupBy(['state'], 'states')
                .in('items').groupBy(['city'], 'cities')
                .in('cities').sum('items', 'seats', 'citySeats')
                .flatten('cities', 'items', 'flatVenues')
        );

        pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', seats: 10 });
        let output = getOutput();
        expect(output[0].flatVenues).toEqual([{ city: 'Dallas', venue: 'Stadium', seats: 10, citySeats: 10 }]);

        pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', seats: 5 });
        output = getOutput();

        const flatVenues = sortByJson(output[0].flatVenues);
        expect(flatVenues).toEqual(sortByJson([
            { city: 'Dallas', venue: 'Stadium', seats: 10, citySeats: 15 },
            { city: 'Dallas', venue: 'Arena', seats: 5, citySeats: 15 }
        ]));
    });

    it('should apply child mutable property changes only to the corresponding flattened item', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<VenueRow>()
                .groupBy(['state'], 'states')
                .in('items').groupBy(['city'], 'cities')
                .in('cities', 'items').groupBy(['venue'], 'venues')
                .in('cities', 'venues').sum('items', 'seats', 'venueSeats')
                .flatten('cities', 'venues', 'flatVenues')
        );

        pipeline.add('a1', { state: 'TX', city: 'Dallas', venue: 'A', seats: 10 });
        pipeline.add('b1', { state: 'TX', city: 'Dallas', venue: 'B', seats: 20 });
        let output = getOutput();
        let flat = sortByJson(output[0].flatVenues.map((v) => ({
            city: v.city,
            venue: v.venue,
            venueSeats: v.venueSeats
        })));
        expect(flat).toEqual(sortByJson([
            { city: 'Dallas', venue: 'A', venueSeats: 10 },
            { city: 'Dallas', venue: 'B', venueSeats: 20 }
        ]));

        pipeline.add('a2', { state: 'TX', city: 'Dallas', venue: 'A', seats: 5 });
        output = getOutput();
        flat = sortByJson(output[0].flatVenues.map((v) => ({
            city: v.city,
            venue: v.venue,
            venueSeats: v.venueSeats
        })));
        expect(flat).toEqual(sortByJson([
            { city: 'Dallas', venue: 'A', venueSeats: 15 },
            { city: 'Dallas', venue: 'B', venueSeats: 20 }
        ]));
    });

    it('should produce identical final output across different insertion orders', () => {
        const createAndRun = (rows: Array<{ key: string; value: VenueRow }>) => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<VenueRow>()
                    .groupBy(['state'], 'states')
                    .in('items').groupBy(['city'], 'cities')
                    .flatten('cities', 'items', 'flatVenues')
            );

            rows.forEach(row => pipeline.add(row.key, row.value));
            return sortByJson(getOutput());
        };

        const rowsA = [
            { key: 'v1', value: { state: 'TX', city: 'Dallas', venue: 'Stadium', seats: 50000 } },
            { key: 'v2', value: { state: 'TX', city: 'Houston', venue: 'Center', seats: 30000 } },
            { key: 'v3', value: { state: 'CA', city: 'LA', venue: 'Forum', seats: 18000 } }
        ];
        const rowsB = [rowsA[2], rowsA[0], rowsA[1]];

        expect(createAndRun(rowsA)).toEqual(createAndRun(rowsB));
    });

    it('should revert to prior state after adding then removing the same child', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<VenueRow>()
                .groupBy(['state'], 'states')
                .in('items').groupBy(['city'], 'cities')
                .flatten('cities', 'items', 'flatVenues')
        );

        pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', seats: 50000 });
        const baseline = sortByJson(getOutput());

        const transient = { state: 'TX', city: 'Dallas', venue: 'Arena', seats: 20000 };
        pipeline.add('transient', transient);
        pipeline.remove('transient', transient);

        expect(sortByJson(getOutput())).toEqual(baseline);
    });

    it('should reject invalid flatten configuration when referenced arrays do not exist', () => {
        // The types reject these; an untyped caller reaches the runtime checks.
        expect(() => createPipeline<{ state: string }>()
            // @ts-expect-error There is no `cities` array.
            .flatten('cities', 'items', 'flatVenues'))
            .toThrow();

        expect(() => createPipeline<VenueRow>()
            .groupBy(['state'], 'states')
            .in('items').groupBy(['city'], 'cities')
            // @ts-expect-error A city has no `missing` array.
            .flatten('cities', 'missing', 'flatVenues'))
            .toThrow();
    });

    it('rejects a parent and child that both declare a name', () => {
        // Each item's total is absent until it has a line; each group has a total too. Before this
        // was rejected, the flattened rows' totals depended on the order the items arrived.
        const lines: SourceArrayDescriptor = {
            name: 'lines',
            type: { arrays: [], collectionKey: [], scalars: [{ name: 'n', type: 'number' }], objects: [] }
        };
        expect(() => createPipeline<{ cat: string; grp: string; v: number }, 'items', { lines: KeyedArray<{ n: number }> }>('items', [], [lines])
            .sum('lines', 'n', 'total')
            .groupBy(['cat', 'grp'], 'groups')
            .sum('items', 'v', 'total')
            .groupBy(['cat'], 'cats')
            // @ts-expect-error The groups and the items both have `total`.
            .flatten('groups', 'items', 'flat')
        ).toThrow('"total"');
    });

    it('should reject flatten configuration when output array collides at current scope', () => {
        expect(() => createPipeline<VenueRow>()
            .groupBy(['state'], 'states')
            .in('items').groupBy(['city'], 'cities')
            // @ts-expect-error The output name is an array that already exists at this scope.
            .flatten('cities', 'items', 'cities'))
            .toThrow();
    });

    it('should replace parent array in descriptor and merge child/parent metadata', () => {
        const descriptor = createPipeline<VenueRow, 'items'>('items', [
            { name: 'state', type: 'string' },
            { name: 'city', type: 'string' },
            { name: 'venue', type: 'string' },
            { name: 'seats', type: 'number' }
        ])
            .groupBy(['state'], 'states')
            .in('items').groupBy(['city'], 'cities')
            .in('cities').sum('items', 'seats', 'citySeats')
            .flatten('cities', 'items', 'flatVenues')
            .getTypeDescriptor();

        expect(descriptor.scalars).toContainEqual({ name: 'state', type: 'string' });
        expect(descriptor.arrays.some(a => a.name === 'cities')).toBe(false);
        expect(descriptor.arrays.some(a => a.name === 'flatVenues')).toBe(true);

        const flattenedType = descriptor.arrays.find(a => a.name === 'flatVenues')!.type;
        expect(flattenedType.collectionKey).toEqual(['city']);
        expect(flattenedType.scalars.map(s => s.name)).toEqual(
            expect.arrayContaining(['city', 'venue', 'seats'])
        );
    });
});
