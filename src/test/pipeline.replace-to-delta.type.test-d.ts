import { expectError } from 'tsd';
import { createPipeline, type KeyedArray } from '../index.js';

type TimelineInput = {
    entities: KeyedArray<{
        entityId: string;
        events: KeyedArray<{
            time: number;
            id: string;
            amount: number;
            bonus: number;
        }>;
    }>;
};

{
    createPipeline<TimelineInput>().replaceToDelta(
        'entities',
        'events',
        ['time', 'id'],
        ['amount', 'bonus'],
        ['deltaAmount', 'deltaBonus'] as const
    );
}

// Expected behavior: orderBy/properties should be constrained to event keys.
{
    expectError(
        createPipeline<TimelineInput>().replaceToDelta(
            'entities',
            'events',
            ['missingOrderByField'],
            ['amount'],
            ['deltaAmount'] as const
        )
    );
}

{
    expectError(
        createPipeline<TimelineInput>().replaceToDelta(
            'entities',
            'events',
            ['time', 'id'],
            ['missingValueField'],
            ['deltaAmount'] as const
        )
    );
}
