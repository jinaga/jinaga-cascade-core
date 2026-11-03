// @ts-nocheck
/**
 * Each level of a descriptor records the properties of its own items that can change after
 * they are added. A step reads the level it listens to and writes the level it produces, so
 * properties of the same name at different levels do not affect one another.
 */
import { createPipeline } from '../index';
import { getMutablePropertiesOfArrayItems } from '../pipeline';
import { createTestPipeline } from './helpers';

const tierOf = r => ((r.total ?? 0) > 50 ? 'hi' : 'lo');

function scalarsAt(descriptor, path) {
    let node = descriptor;
    for (const segment of path) {
        node = node.arrays.find(a => a.name === segment).type;
    }
    return node.scalars.map(s => s.name);
}

describe('mutable properties per level', () => {
    it('a sum over replaceToDelta outputs follows them', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['effectiveClass'], 'attendees')
                .in('items').groupBy(['attendeeId'], 'attendees')
                .replaceToDelta('attendees', 'items', ['createdAt', 'eventId'], ['amount'], ['deltaAmount'])
                .in('attendees').sum('items', 'deltaAmount', 'net')
        );
        const row = (id, createdAt, amount) => ({ effectiveClass: 'c', attendeeId: 'a', createdAt, eventId: id, amount });
        // The later event arrives first, so its delta changes when the earlier one arrives.
        pipeline.add('2', row('2', '2026-02', 50));
        pipeline.add('1', row('1', '2026-01', 30));
        expect(getOutput()[0].attendees[0].net).toBe(50);
    });

    it('a nested aggregate declares its output on the parent level', () => {
        const descriptor = createPipeline()
            .groupBy(['item'], 'groups')
            .count('items', 'lines')
            .getTypeDescriptor();
        expect(scalarsAt(descriptor, [])).toEqual(['lines']);
        expect(getMutablePropertiesOfArrayItems(descriptor, [])).toEqual(['lines']);

        const nested = createPipeline()
            .groupBy(['tier'], 'tiers')
            .in('items').groupBy(['item'], 'groups')
            .in('groups').count('items', 'lines')
            .getTypeDescriptor();
        expect(scalarsAt(nested, ['groups'])).toEqual(['lines']);
        expect(getMutablePropertiesOfArrayItems(nested, ['groups'])).toEqual(['lines']);
        expect(getMutablePropertiesOfArrayItems(nested, [])).toEqual([]);
    });

    it('groups have no mutable values, and items keep theirs', () => {
        const descriptor = createPipeline()
            .groupBy(['item'], 'groups')
            .sum('items', 'v', 'total')
            .defineProperty('tier', tierOf, ['total'])
            .groupBy(['tier'], 'tiers')
            .getTypeDescriptor();
        expect(getMutablePropertiesOfArrayItems(descriptor, [])).toEqual([]);
        expect(getMutablePropertiesOfArrayItems(descriptor, ['groups'])).toEqual(['total']);
    });

    it('a property of the same name at another level does not change a flattened value', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['cat', 'item'], 'groups')
                .sum('items', 'v', 'total')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['cat', 'tier'], 'tiers')
                .defineProperty('label', t => t.tier.toUpperCase())
                .groupBy(['cat'], 'cats')
                .flatten('tiers', 'groups', 'flat')
                // Define and drop an unrelated root `label`.
                .defineProperty('label', () => 'root', ['cat'])
                .dropProperty('label')
        );
        pipeline.add('1', { cat: 'c', item: 'a', v: 30 });
        pipeline.add('2', { cat: 'c', item: 'a', v: 40 });
        expect(getOutput()[0].flat[0].label).toBe('HI');
    });

    it('a mutable property at one level does not make a same-named property mutable at another', () => {
        // `v` is mutable on the groups (a sum), not on the items. An item with no `v` still counts.
        const descriptor = createPipeline()
            .groupBy(['item'], 'groups')
            .sum('items', 'n', 'v')
            .getTypeDescriptor();
        expect(getMutablePropertiesOfArrayItems(descriptor, [])).toEqual(['v']);
        expect(getMutablePropertiesOfArrayItems(descriptor, ['items'])).toEqual([]);
    });

    it('source values never change', () => {
        const descriptor = createPipeline('folders', [], [
            { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }
        ]).getTypeDescriptor();
        expect(getMutablePropertiesOfArrayItems(descriptor, ['files'])).toEqual([]);
    });
});
