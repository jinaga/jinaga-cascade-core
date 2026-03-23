import { expectType } from 'tsd';
import { createPipeline } from '../index.js';
import type { KeyedArray } from '../index.js';

type Input = {
    region: string;
    states: KeyedArray<{
        state: string;
        population: number;
        cities: KeyedArray<{
            city: string;
            households: number;
        }>;
    }>;
};

// Root-level array operator typing
{
    const builder = createPipeline<Input>();

    // Valid: root has 'states' array and state items have 'population'
    builder.sum('states', 'population', 'totalPopulation');

    // Invalid: 'cities' exists only under states, not at root
    type RootArrayName = Parameters<typeof builder.sum>[0];
    expectType<'states'>({} as RootArrayName);
    // @ts-expect-error Root-level arrayName should only allow "states"
    const invalidRootArrayName: RootArrayName = 'cities';
    void invalidRootArrayName;

    // Invalid: state items do not have 'households'
    // @ts-expect-error State items do not include "households"
    builder.sum('states', 'households', 'totalHouseholds');
}

// Scoped array operator typing after .in(...)
{
    const scoped = createPipeline<Input>().in('states');

    // Valid: at this path, 'cities' is the array and city items have 'households'
    scoped.sum('cities', 'households', 'totalHouseholds');

    // Invalid at this path: 'states' is not an array on state items
    type ScopedArrayName = Parameters<typeof scoped.sum>[0];
    expectType<'cities'>({} as ScopedArrayName);
    // @ts-expect-error Scoped arrayName should only allow "cities"
    const invalidScopedArrayName: ScopedArrayName = 'states';
    void invalidScopedArrayName;

    // Invalid at this path: city items do not have 'population'
    // @ts-expect-error City items do not include "population"
    scoped.sum('cities', 'population', 'totalPopulation');
}

// Root scope name should be preserved through groupBy for downstream operators
{
    interface Vote {
        attendeePublicKey: string;
        createdAtSort: string;
        round: number;
        isInvestor: boolean;
    }

    const grouped = createPipeline<Vote, 'votes'>('votes')
        .groupBy(['attendeePublicKey'], 'attendees');

    // Runtime-correct child array name remains the previous scope ("votes")
    grouped.pickByMax('votes', 'createdAtSort', 'latestVote');

    type GroupedArrayName = Parameters<typeof grouped.pickByMax>[0];
    expectType<'votes'>({} as GroupedArrayName);

    // @ts-expect-error groupBy parent name should not be accepted as the picked array
    const invalidGroupedArrayName: GroupedArrayName = 'attendees';
    void invalidGroupedArrayName;
}

// Chained root-level groupBy should use previous parent as child scope name
{
    interface Vote {
        attendeePublicKey: string;
        createdAtSort: string;
        round: number;
        isInvestor: boolean;
    }

    const regrouped = createPipeline<Vote, 'votes'>('votes')
        .groupBy(['attendeePublicKey'], 'attendees')
        .groupBy(['attendeePublicKey'], 'groups');

    type RegroupedArrayName = Parameters<typeof regrouped.pickByMax>[0];

    // After the second root-level groupBy, operators should target the previous root collection.
    expectType<'attendees'>({} as RegroupedArrayName);
    // @ts-expect-error Original root scope name should no longer be accepted
    const invalidRegroupedArrayName: RegroupedArrayName = 'votes';
    void invalidRegroupedArrayName;
}

// Root-level groupBy after aggregate should still advance root scope name
{
    interface Vote {
        attendeePublicKey: string;
        createdAtSort: string;
        round: number;
        isInvestor: boolean;
    }

    const regroupedAfterAggregate = createPipeline<Vote, 'votes'>('votes')
        .groupBy(['attendeePublicKey'], 'attendees')
        .sum('votes', 'round', 'totalRound')
        .groupBy(['attendeePublicKey'], 'groups');

    type RegroupedAfterAggregateArrayName = Parameters<typeof regroupedAfterAggregate.pickByMax>[0];

    expectType<'attendees'>({} as RegroupedAfterAggregateArrayName);
    // @ts-expect-error Original root scope name should no longer be accepted after regrouping
    const invalidRegroupedAfterAggregateArrayName: RegroupedAfterAggregateArrayName = 'votes';
    void invalidRegroupedAfterAggregateArrayName;
}
