/**
 * Each level of a descriptor records the properties of its own items that can change after
 * they are added. A step reads the level it listens to and writes the level it produces, so
 * properties of the same name at different levels do not affect one another.
 */
import { createPipeline } from '../index';
import { getMutablePropertiesOfArrayItems, type DescriptorNode } from '../pipeline';
import { createTestPipeline } from './helpers';

const tierOf = (r: { total: number | undefined }) => ((r.total ?? 0) > 50 ? 'hi' : 'lo');

function scalarsAt(descriptor: DescriptorNode, path: string[]): string[] {
    let node = descriptor;
    for (const segment of path) {
        const array = node.arrays.find(a => a.name === segment);
        if (!array) {
            throw new Error(`no array ${segment}`);
        }
        node = array.type;
    }
    return node.scalars.map(s => s.name);
}

describe('mutable properties per level', () => {
    it('a sum over replaceToDelta outputs follows them', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ effectiveClass: string; attendeeId: string; createdAt: string; eventId: string; amount: number }>()
                .groupBy(['effectiveClass'], 'attendees')
                .in('items').groupBy(['attendeeId'], 'attendees')
                .replaceToDelta('attendees', 'items', ['createdAt', 'eventId'], ['amount'], ['deltaAmount'])
                .in('attendees').sum('items', 'deltaAmount', 'net')
        );
        const row = (id: string, createdAt: string, amount: number) => ({ effectiveClass: 'c', attendeeId: 'a', createdAt, eventId: id, amount });
        // The later event arrives first, so its delta changes when the earlier one arrives.
        pipeline.add('2', row('2', '2026-02', 50));
        pipeline.add('1', row('1', '2026-01', 30));
        expect(getOutput()[0].attendees[0].net).toBe(50);
    });

    it('a nested aggregate declares its output on the parent level', () => {
        const descriptor = createPipeline<{ item: string }>()
            .groupBy(['item'], 'groups')
            .count('items', 'lines')
            .getTypeDescriptor();
        expect(scalarsAt(descriptor, [])).toEqual(['lines']);
        expect(getMutablePropertiesOfArrayItems(descriptor, [])).toEqual(['lines']);

        const nested = createPipeline<{ tier: string; item: string }>()
            .groupBy(['tier'], 'tiers')
            .in('items').groupBy(['item'], 'groups')
            .in('groups').count('items', 'lines')
            .getTypeDescriptor();
        expect(scalarsAt(nested, ['groups'])).toEqual(['lines']);
        expect(getMutablePropertiesOfArrayItems(nested, ['groups'])).toEqual(['lines']);
        expect(getMutablePropertiesOfArrayItems(nested, [])).toEqual([]);
    });

    it('groups have no mutable values, and items keep theirs', () => {
        const descriptor = createPipeline<{ item: string; v: number }>()
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
            createPipeline<{ cat: string; item: string; v: number }>()
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
        const descriptor = createPipeline<{ item: string; n: number }>()
            .groupBy(['item'], 'groups')
            .sum('items', 'n', 'v')
            .getTypeDescriptor();
        expect(getMutablePropertiesOfArrayItems(descriptor, [])).toEqual(['v']);
        expect(getMutablePropertiesOfArrayItems(descriptor, ['items'])).toEqual([]);
    });

    it('grouping by an object puts it on the group, and a flattened item follows it', () => {
        const make = () => createPipeline<{ cat: string; item: string; v: number }>()
            .groupBy(['cat', 'item'], 'groups')
            .pickByMax('items', 'v', 'latest')
            .groupBy(['cat', 'latest'], 'byLatest')
            .groupBy(['cat'], 'cats')
            .flatten('byLatest', 'groups', 'flat');
        const descriptor = make().getTypeDescriptor();
        const byLatest = createPipeline<{ cat: string; item: string; v: number }>()
            .groupBy(['cat', 'item'], 'groups')
            .pickByMax('items', 'v', 'latest')
            .groupBy(['cat', 'latest'], 'byLatest')
            .getTypeDescriptor();
        expect(byLatest.objects.map(o => o.name)).toEqual(['latest']);
        expect(byLatest.arrays[0].type.objects).toEqual([]);
        expect(getMutablePropertiesOfArrayItems(descriptor, ['flat'])).toContain('latest');

        const [pipeline, getOutput] = createTestPipeline(make);
        pipeline.add('1', { cat: 'c', item: 'a', v: 1 });
        pipeline.add('2', { cat: 'c', item: 'a', v: 2 });
        expect(getOutput()[0].flat[0].latest).toEqual({ v: 2 });
    });

    it('source values never change', () => {
        const descriptor = createPipeline('folders', [], [
            { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }
        ]).getTypeDescriptor();
        expect(getMutablePropertiesOfArrayItems(descriptor, ['files'])).toEqual([]);
    });
});
