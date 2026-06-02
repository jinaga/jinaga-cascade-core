import { createPipeline, toPipelinePlainOutput, type KeyedArray } from '../index';
import type { ArrayDescriptor, DescriptorNode, PipelineRuntimeDiagnostic } from '../pipeline';
import { getPathSegmentsFromDescriptor } from '../pipeline';
import { createTestPipeline, simulateState } from './helpers';

type Folder = { folderName: string };
type Bookmark = { url: string };
type SizedBookmark = { url: string; size: number };

const scalarNode = (scalars: DescriptorNode['scalars'], arrays: ArrayDescriptor[] = []): DescriptorNode => ({
    arrays,
    collectionKey: [],
    scalars,
    objects: [],
    mutableProperties: []
});

const bookmarksArray = (extraScalars: DescriptorNode['scalars'] = []): ArrayDescriptor => ({
    name: 'bookmarks',
    type: scalarNode([{ name: 'url', type: 'string' }, ...extraScalars])
});

const folderSources = [{ name: 'folderName', type: 'string' as const }];

function countPipeline() {
    return createPipeline<Folder, 'folders', { bookmarks: KeyedArray<Bookmark> }>(
        'folders',
        folderSources,
        [bookmarksArray()]
    ).count('bookmarks', 'bookmarkCount');
}

describe('source-level arrays', () => {
    describe('count', () => {
        it('counts children fed via collection() for a single folder', () => {
            const [pipeline, getOutput] = createTestPipeline(countPipeline);

            pipeline.add('F1', { folderName: 'Work' });
            pipeline.collection('bookmarks').add('F1', 'B1', { url: 'a' });
            pipeline.collection('bookmarks').add('F1', 'B2', { url: 'b' });

            const output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0].folderName).toBe('Work');
            expect(output[0].bookmarkCount).toBe(2);
            expect(output[0].bookmarks).toHaveLength(2);
        });

        it('isolates counts per parent folder', () => {
            const [pipeline, getOutput] = createTestPipeline(countPipeline);

            pipeline.add('F1', { folderName: 'Work' });
            pipeline.add('F2', { folderName: 'Play' });
            pipeline.collection('bookmarks').add('F1', 'B1', { url: 'a' });
            pipeline.collection('bookmarks').add('F1', 'B2', { url: 'b' });
            pipeline.collection('bookmarks').add('F1', 'B3', { url: 'c' });
            pipeline.collection('bookmarks').add('F2', 'B4', { url: 'd' });

            const output = getOutput();
            expect(output.find(f => f.folderName === 'Work')?.bookmarkCount).toBe(3);
            expect(output.find(f => f.folderName === 'Play')?.bookmarkCount).toBe(1);
        });

        it('leaves the aggregate undefined for a folder with no children', () => {
            const [pipeline, getOutput] = createTestPipeline(countPipeline);

            pipeline.add('F1', { folderName: 'Empty' });

            const output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0].bookmarkCount).toBeUndefined();
            // Consumers coalesce the empty case, matching the launchkings `?? 0` idiom.
            expect(output[0].bookmarkCount ?? 0).toBe(0);
            expect(output[0].bookmarks).toEqual([]);
        });
    });

    describe('sum', () => {
        it('sums a child scalar over the source array', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<Folder, 'folders', { bookmarks: KeyedArray<SizedBookmark> }>(
                    'folders',
                    folderSources,
                    [bookmarksArray([{ name: 'size', type: 'number' }])]
                ).sum('bookmarks', 'size', 'totalSize')
            );

            pipeline.add('F1', { folderName: 'Work' });
            pipeline.collection('bookmarks').add('F1', 'B1', { url: 'a', size: 10 });
            pipeline.collection('bookmarks').add('F1', 'B2', { url: 'b', size: 32 });

            expect(getOutput()[0].totalSize).toBe(42);
        });
    });

    describe('removal', () => {
        it('reverts the aggregate as children and the folder are removed', () => {
            const [pipeline, getOutput] = createTestPipeline(countPipeline);
            const bookmarks = pipeline.collection('bookmarks');

            pipeline.add('F1', { folderName: 'Work' });
            bookmarks.add('F1', 'B1', { url: 'a' });
            bookmarks.add('F1', 'B2', { url: 'b' });
            expect(getOutput()[0].bookmarkCount).toBe(2);

            bookmarks.remove('F1', 'B1', { url: 'a' });
            expect(getOutput()[0].bookmarkCount).toBe(1);

            pipeline.remove('F1', { folderName: 'Work' });
            expect(getOutput()).toHaveLength(0);
        });

        it('recomputes correctly after re-adding a removed folder', () => {
            const [pipeline, getOutput] = createTestPipeline(countPipeline);
            const bookmarks = pipeline.collection('bookmarks');

            pipeline.add('F1', { folderName: 'Work' });
            bookmarks.add('F1', 'B1', { url: 'a' });
            bookmarks.add('F1', 'B2', { url: 'b' });
            bookmarks.remove('F1', 'B1', { url: 'a' });
            bookmarks.remove('F1', 'B2', { url: 'b' });
            pipeline.remove('F1', { folderName: 'Work' });
            expect(getOutput()).toHaveLength(0);

            pipeline.add('F1', { folderName: 'Work' });
            bookmarks.add('F1', 'B3', { url: 'c' });
            expect(getOutput()[0].bookmarkCount).toBe(1);
        });
    });

    describe('duplicate-content children', () => {
        it('counts distinct keys with identical props and removes cleanly without diagnostics', () => {
            const diagnostics: PipelineRuntimeDiagnostic[] = [];
            const [getState, setState] = simulateState<KeyedArray<{ folderName: string; bookmarks: KeyedArray<Bookmark>; bookmarkCount: number }>>([]);
            const builder = countPipeline();
            const pipeline = builder.build(setState, { onDiagnostic: d => diagnostics.push(d) });

            pipeline.add('F1', { folderName: 'Work' });
            pipeline.collection('bookmarks').add('F1', 'B1', { url: 'same' });
            pipeline.collection('bookmarks').add('F1', 'B2', { url: 'same' });
            pipeline.flush();
            expect(toPipelinePlainOutput(getState(), builder.getTypeDescriptor())[0].bookmarkCount).toBe(2);

            pipeline.collection('bookmarks').remove('F1', 'B1', { url: 'same' });
            pipeline.collection('bookmarks').remove('F1', 'B2', { url: 'same' });
            pipeline.remove('F1', { folderName: 'Work' });
            pipeline.flush();

            expect(toPipelinePlainOutput(getState(), builder.getTypeDescriptor())).toHaveLength(0);
            expect(diagnostics).toHaveLength(0);
        });
    });

    describe('commutativity', () => {
        it('produces the same output regardless of folder add order', () => {
            const run = (orderFirst: 'F1' | 'F2') => {
                const [pipeline, getOutput] = createTestPipeline(countPipeline);
                const bookmarks = pipeline.collection('bookmarks');
                const addF1 = () => {
                    pipeline.add('F1', { folderName: 'Work' });
                    bookmarks.add('F1', 'B1', { url: 'a' });
                    bookmarks.add('F1', 'B2', { url: 'b' });
                };
                const addF2 = () => {
                    pipeline.add('F2', { folderName: 'Play' });
                    bookmarks.add('F2', 'B3', { url: 'c' });
                };
                if (orderFirst === 'F1') { addF1(); addF2(); } else { addF2(); addF1(); }
                return getOutput().slice().sort((a, b) => a.folderName.localeCompare(b.folderName));
            };

            expect(run('F1')).toEqual(run('F2'));
        });

        it('is independent of flush timing', () => {
            const eager = createTestPipeline(countPipeline);
            eager[0].add('F1', { folderName: 'Work' });
            eager[0].flush();
            eager[0].collection('bookmarks').add('F1', 'B1', { url: 'a' });
            eager[0].flush();
            eager[0].collection('bookmarks').add('F1', 'B2', { url: 'b' });

            const lazy = createTestPipeline(countPipeline);
            lazy[0].add('F1', { folderName: 'Work' });
            lazy[0].collection('bookmarks').add('F1', 'B1', { url: 'a' });
            lazy[0].collection('bookmarks').add('F1', 'B2', { url: 'b' });

            expect(eager[1]()).toEqual(lazy[1]());
        });
    });

    describe('nested source arrays', () => {
        type Tag = { label: string };
        type TaggedBookmark = { url: string; tags: KeyedArray<Tag> };

        function nestedPipeline() {
            const bookmarksWithTags: ArrayDescriptor = {
                name: 'bookmarks',
                type: scalarNode(
                    [{ name: 'url', type: 'string' }],
                    [{ name: 'tags', type: scalarNode([{ name: 'label', type: 'string' }]) }]
                )
            };
            return createPipeline<Folder, 'folders', { bookmarks: KeyedArray<TaggedBookmark> }>(
                'folders',
                folderSources,
                [bookmarksWithTags]
            )
                .in('bookmarks').count('tags', 'tagCount')
                .count('bookmarks', 'bookmarkCount');
        }

        it('counts at both the parent and nested levels', () => {
            const [pipeline, getOutput] = createTestPipeline(nestedPipeline);

            pipeline.add('F1', { folderName: 'Work' });
            pipeline.collection('bookmarks').add('F1', 'B1', { url: 'a' });
            pipeline.collection('bookmarks').add('F1', 'B2', { url: 'b' });
            pipeline.collection('bookmarks', 'tags').add(['F1', 'B1'], 'T1', { label: 'x' });
            pipeline.collection('bookmarks', 'tags').add(['F1', 'B1'], 'T2', { label: 'y' });
            pipeline.collection('bookmarks', 'tags').add(['F1', 'B2'], 'T3', { label: 'z' });

            const output = getOutput();
            expect(output[0].bookmarkCount).toBe(2);
            const b1 = output[0].bookmarks.find(b => b.url === 'a');
            const b2 = output[0].bookmarks.find(b => b.url === 'b');
            expect(b1?.tagCount).toBe(2);
            expect(b2?.tagCount).toBe(1);
        });
    });

    describe('composition with groupBy', () => {
        it('aggregates a source array while grouping on a scalar', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ folderName: string; region: string }, 'folders', { bookmarks: KeyedArray<Bookmark> }>(
                    'folders',
                    [{ name: 'folderName', type: 'string' }, { name: 'region', type: 'string' }],
                    [bookmarksArray()]
                ).count('bookmarks', 'bookmarkCount')
            );

            pipeline.add('F1', { folderName: 'Work', region: 'US' });
            pipeline.collection('bookmarks').add('F1', 'B1', { url: 'a' });
            pipeline.collection('bookmarks').add('F1', 'B2', { url: 'b' });

            expect(getOutput()[0].bookmarkCount).toBe(2);
            expect(getOutput()[0].region).toBe('US');
        });
    });

    describe('descriptor seeding', () => {
        it('exposes the source array in the descriptor and its path', () => {
            const descriptor = countPipeline().getTypeDescriptor();
            expect(descriptor.arrays.map(a => a.name)).toContain('bookmarks');
            expect(getPathSegmentsFromDescriptor(descriptor)).toEqual(
                expect.arrayContaining([[], ['bookmarks']])
            );
        });
    });

    describe('typing', () => {
        it('keeps the add input flat and the output typed', () => {
            const [pipeline, getOutput] = createTestPipeline(countPipeline);

            pipeline.add('F1', { folderName: 'Work' });
            // @ts-expect-error - the source array is not part of the flat add input
            pipeline.add('F2', { folderName: 'Play', bookmarks: [] });
            pipeline.collection('bookmarks').add('F1', 'B1', { url: 'a' });

            const count: number = getOutput()[0].bookmarkCount;
            expect(count).toBe(1);
        });

        it('infers T = TStart for scalar-only pipelines (back-compat)', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .sum('items', 'price', 'total')
            );
            pipeline.add('i1', { category: 'A', price: 5 });
            expect(getOutput()[0].total).toBe(5);
        });
    });
});
