import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('pipeline basic operations', () => {
    it('should build an array', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ message: string }>()
        );

        pipeline.add("item1", { message: "Hello" });
        pipeline.add("item2", { message: "Goodbye" });

        const output = getOutput();

        expect(output).toEqual([
            { message: "Hello" },
            { message: "Goodbye" }
        ]);
    });

    it('should remove an item', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ message: string }>()
        );

        const item1 = { message: "Hello" };
        const item2 = { message: "Goodbye" };
        const item3 = { message: "See you" };
        pipeline.add("item1", item1);
        pipeline.add("item2", item2);
        pipeline.add("item3", item3);

        expect(getOutput()).toEqual([
            { message: "Hello" },
            { message: "Goodbye" },
            { message: "See you" }
        ]);

        pipeline.remove("item2", item2);

        expect(getOutput()).toEqual([
            { message: "Hello" },
            { message: "See you" }
        ]);
    });
});


