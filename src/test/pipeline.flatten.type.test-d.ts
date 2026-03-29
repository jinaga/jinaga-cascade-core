import { expectError } from 'tsd';
import { createPipeline, type KeyedArray, type PipelineOutput } from '../index.js';

type NestedInput = {
    states: KeyedArray<{
        state: string;
        cities: KeyedArray<{
            city: string;
            venue: string;
            seats: number;
        }>;
        parentNotes: KeyedArray<{ note: string }>;
    }>;
};

{
    const builder = createPipeline<NestedInput>()
        .flatten('states', 'cities', 'flatCities');

    type Output = PipelineOutput<typeof builder>;
    type FlatCity = Output['flatCities'][number]['value'];

    // Issue #2: should be a type error if sibling parent arrays leak into flattened item type.
    expectError(({} as FlatCity).parentNotes);
}

{
    // Issue #4: output name collision with an existing scalar at scope should be rejected.
    expectError(
        createPipeline<{
            flatCities: string;
            states: KeyedArray<{
                state: string;
                cities: KeyedArray<{ city: string }>;
            }>;
        }>().flatten('states', 'cities', 'flatCities')
    );
}

