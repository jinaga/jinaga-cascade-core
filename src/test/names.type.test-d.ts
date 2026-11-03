import { expectError } from 'tsd';
import { createPipeline, type KeyedArray } from '../index.js';

// A name that becomes a property must be one string literal: the runtime creates exactly the
// name it is given, so a union or a widened `string` would describe properties that do not exist.

type Row = { cat: string; item: string; v: number };
declare const union: 'a' | 'b';
declare const widened: string;

const grouped = () => createPipeline<Row>().groupBy(['cat'], 'cats');

// groupBy: the group level, at the root and nested.
{
    expectError(createPipeline<Row>().groupBy(['cat'], union));
    expectError(createPipeline<Row>().groupBy(['cat'], widened));
    expectError(grouped().in('items').groupBy(['item'], union));
    expectError(grouped().in('items').groupBy(['item'], widened));
}

// Aggregates and defined properties.
{
    expectError(grouped().sum('items', 'v', union));
    expectError(grouped().sum('items', 'v', widened));
    expectError(grouped().count('items', union));
    expectError(grouped().count('items', widened));
    expectError(grouped().min('items', 'v', union));
    expectError(grouped().max('items', 'v', widened));
    expectError(grouped().average('items', 'v', union));
    expectError(grouped().pickByMin('items', 'v', union));
    expectError(grouped().pickByMax('items', 'v', widened));
    expectError(grouped().commutativeAggregate('items', union, (acc: number | undefined) => acc ?? 0, (acc: number) => acc));
    expectError(createPipeline<Row>().defineProperty(union, () => 1));
    expectError(createPipeline<Row>().defineProperty(widened, () => 1));
}

// flatten's output.
{
    const nested = () => grouped().in('items').groupBy(['item'], 'items');
    expectError(nested().flatten('items', 'items', union));
    expectError(nested().flatten('items', 'items', widened));
}

// enrich: the property and the source.
{
    const secondary = createPipeline<{ cat: string; label: string }, 'labels'>('labels')
        .groupBy(['cat'], 'byCat');
    expectError(createPipeline<Row>().enrich('labels', secondary, ['cat'], union));
    expectError(createPipeline<Row>().enrich(union, secondary, ['cat'], 'info'));
    expectError(createPipeline<Row>().enrich(widened, secondary, ['cat'], 'info'));
}

// replaceToDelta: each output name.
{
    type Timeline = { entities: KeyedArray<{ entityId: string; events: KeyedArray<{ time: number; amount: number }> }> };
    const timeline = () => createPipeline<Timeline>();
    expectError(timeline().replaceToDelta('entities', 'events', ['time'], ['amount'], [widened]));
    expectError(timeline().replaceToDelta('entities', 'events', ['time'], ['amount'], [union]));
    expectError(timeline().replaceToDelta('entities', 'events', ['time'], ['amount'], [] as string[]));
}

// createPipeline: the root scope.
{
    expectError(createPipeline<Row, 'a' | 'b'>(union));
    expectError(createPipeline<Row, string>(widened));
}

// Literals are accepted everywhere.
{
    grouped().sum('items', 'v', 'total').in('items').groupBy(['item'], 'byItem');
    createPipeline<Row>().defineProperty('doubled', r => r.v * 2);
    createPipeline<Row, 'rows'>('rows');
}
