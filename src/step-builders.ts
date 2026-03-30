import type {
    AddedHandler,
    ImmutableProps,
    PipelineInput,
    PipelineSources,
    RemovedHandler,
    ScalarDescriptor,
    Step,
    StepBuilder,
    TypeDescriptor
} from './pipeline.js';
import { type AddOperator, type SubtractOperator, CommutativeAggregateStep } from './steps/commutative-aggregate.js';
import { DefinePropertyStep } from './steps/define-property.js';
import { DropPropertyStep } from './steps/drop-property.js';
import { FilterStep } from './steps/filter.js';
import { GroupByStep } from './steps/group-by.js';
import { MinMaxAggregateStep } from './steps/min-max-aggregate.js';
import { AverageAggregateStep } from './steps/average-aggregate.js';
import { PickByMinMaxStep } from './steps/pick-by-min-max.js';
import { EnrichStep } from './steps/enrich.js';
import { CumulativeSumStep } from './steps/cumulative-sum.js';
import { ReplaceToDeltaStep } from './steps/replace-to-delta.js';
import { FlattenStep } from './steps/flatten.js';

type EmptySources = Record<never, never>;

type EnrichDiagnostic = {
    code:
        | 'enrich_key_arity_mismatch'
        | 'enrich_invalid_primary_key_property'
        | 'enrich_secondary_collection_key_missing';
    message: string;
};

class DescriptorStep implements Step {
    constructor(private descriptor: TypeDescriptor) {}

    getTypeDescriptor(): TypeDescriptor {
        return this.descriptor;
    }

    onAdded(_pathSegments: string[], _handler: AddedHandler): void {}

    onRemoved(_pathSegments: string[], _handler: RemovedHandler): void {}

    onModified(
        _pathSegments: string[],
        _propertyName: string,
        _handler: (keyPath: string[], key: string, oldValue: unknown, newValue: unknown) => void
    ): void {}
}

abstract class UpstreamBuilder implements StepBuilder {
    constructor(readonly upstream: StepBuilder) {}

    protected descriptorInput(): Step {
        return new DescriptorStep(this.upstream.getTypeDescriptor());
    }

    getTypeDescriptor(): TypeDescriptor {
        return this.buildStep(this.descriptorInput()).getTypeDescriptor();
    }

    abstract buildStep(input: Step): Step;
}

export class InputStep<T, TSources extends Record<string, unknown> = EmptySources>
    implements PipelineInput<T, TSources>, Step {
    private addedHandlers: AddedHandler[] = [];
    private removedHandlers: RemovedHandler[] = [];

    readonly sources: PipelineSources<TSources>;

    constructor(
        private rootCollectionName: string,
        private sourceScalars: ScalarDescriptor[] = []
    ) {
        this.sources = {} as PipelineSources<TSources>;
    }

    getTypeDescriptor(): TypeDescriptor {
        return {
            rootCollectionName: this.rootCollectionName,
            arrays: [],
            collectionKey: [],
            scalars: this.sourceScalars,
            objects: [],
            mutableProperties: []
        };
    }

    add(key: string, immutableProps: T): void {
        this.addedHandlers.forEach(handler => handler([], key, immutableProps as ImmutableProps));
    }

    remove(key: string, immutableProps: T): void {
        this.removedHandlers.forEach(handler => handler([], key, immutableProps as ImmutableProps));
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (pathSegments.length === 0) {
            this.addedHandlers.push(handler);
        }
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (pathSegments.length === 0) {
            this.removedHandlers.push(handler);
        }
    }

    onModified(
        _pathSegments: string[],
        _propertyName: string,
        _handler: (keyPath: string[], key: string, oldValue: unknown, newValue: unknown) => void
    ): void {
        // No modifications at the input step.
    }

    setSources<TNewSources extends Record<string, unknown>>(sources: PipelineSources<TNewSources>): void {
        (this as unknown as { sources: PipelineSources<TNewSources> }).sources = sources;
    }
}

export class InputBuilder<TStart> implements StepBuilder {
    readonly upstream = undefined;

    constructor(
        private rootCollectionName: string,
        private sourceScalars: ScalarDescriptor[] = []
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        return {
            rootCollectionName: this.rootCollectionName,
            arrays: [],
            collectionKey: [],
            scalars: this.sourceScalars,
            objects: [],
            mutableProperties: []
        };
    }

    buildStep(_input: Step): Step {
        return new InputStep<TStart>(this.rootCollectionName, this.sourceScalars);
    }
}

export class DefinePropertyBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private propertyName: string,
        private compute: (item: unknown) => unknown,
        private scopeSegments: string[],
        private mutableProperties: string[]
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new DefinePropertyStep(
            input,
            this.propertyName,
            this.compute,
            this.scopeSegments,
            this.mutableProperties
        );
    }
}

export class DropPropertyBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private propertyName: string,
        private scopeSegments: string[]
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new DropPropertyStep<Record<string, unknown>, string>(
            input,
            this.propertyName,
            this.scopeSegments
        );
    }
}

export class GroupByBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private groupingProperties: string[],
        private parentArrayName: string,
        private childArrayName: string,
        private scopeSegments: string[]
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new GroupByStep<Record<string, unknown>, string, string, string>(
            input,
            this.groupingProperties,
            this.parentArrayName,
            this.childArrayName,
            this.scopeSegments
        );
    }
}

export class FlattenBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private parentPath: string[],
        private childPath: string[],
        private outputPath: string[]
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new FlattenStep(input, this.parentPath, this.childPath, this.outputPath);
    }
}

export class CommutativeAggregateBuilder<TAggregate> extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private config: {
            add: AddOperator<ImmutableProps, TAggregate>;
            subtract: SubtractOperator<ImmutableProps, TAggregate>;
        },
        private propertyToAggregate?: string
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new CommutativeAggregateStep(
            input,
            this.segmentPath,
            this.propertyName,
            this.config,
            this.propertyToAggregate
        );
    }
}

export class CumulativeSumBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private segmentPath: string[],
        private orderBy: string[],
        private properties: string[]
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new CumulativeSumStep(input, this.segmentPath, this.orderBy, this.properties);
    }
}

export class MinMaxAggregateBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private numericProperty: string,
        private comparator: (a: number, b: number) => number
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new MinMaxAggregateStep(
            input,
            this.segmentPath,
            this.propertyName,
            this.numericProperty,
            this.comparator
        );
    }
}

export class AverageAggregateBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private numericProperty: string
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new AverageAggregateStep(input, this.segmentPath, this.propertyName, this.numericProperty);
    }
}

export class PickByMinMaxBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private comparisonProperty: string,
        private comparator: (value1: number | string, value2: number | string) => number
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new PickByMinMaxStep(
            input,
            this.segmentPath,
            this.propertyName,
            this.comparisonProperty,
            this.comparator
        );
    }
}

export class FilterBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private predicate: (item: unknown) => boolean,
        private scopeSegments: string[],
        private mutableProperties: string[]
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new FilterStep(input, this.predicate, this.scopeSegments, this.mutableProperties);
    }
}

export class ReplaceToDeltaBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        private entitySegmentPath: string[],
        private eventArrayName: string,
        private orderBy: string[],
        private properties: string[],
        private outputProperties: string[]
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        return new ReplaceToDeltaStep(
            input,
            this.entitySegmentPath,
            this.eventArrayName,
            this.orderBy,
            this.properties,
            this.outputProperties
        );
    }
}

export class EnrichBuilder extends UpstreamBuilder {
    constructor(
        upstream: StepBuilder,
        readonly sourceName: string,
        readonly secondaryLastBuilder: StepBuilder,
        readonly scopeSegments: string[],
        readonly primaryKey: string[],
        readonly asProperty: string,
        readonly whenMissing: ImmutableProps | undefined
    ) {
        super(upstream);
    }

    buildStep(input: Step): Step {
        const secondaryDescriptorStep = new DescriptorStep(this.secondaryLastBuilder.getTypeDescriptor());
        return new EnrichStep(
            input,
            secondaryDescriptorStep,
            this.scopeSegments,
            this.primaryKey,
            this.asProperty,
            this.whenMissing
        );
    }
}

interface BuiltStepGraph {
    rootInput: PipelineInput<unknown, Record<string, unknown>>;
    lastStep: Step;
}

type RootPipelineStep = Step & PipelineInput<unknown, Record<string, unknown>>;

function isPipelineInput(step: Step): step is RootPipelineStep {
    return (
        typeof (step as unknown as PipelineInput<unknown, Record<string, unknown>>).add === 'function' &&
        typeof (step as unknown as PipelineInput<unknown, Record<string, unknown>>).remove === 'function' &&
        typeof (step as unknown as PipelineInput<unknown, Record<string, unknown>>).sources === 'object'
    );
}

export function buildStepGraph(
    lastBuilder: StepBuilder,
    emitDiagnostic?: (diagnostic: EnrichDiagnostic) => void
): BuiltStepGraph {
    const builderChain: StepBuilder[] = [];
    let currentBuilder: StepBuilder | undefined = lastBuilder;
    while (currentBuilder) {
        builderChain.push(currentBuilder);
        currentBuilder = currentBuilder.upstream;
    }
    builderChain.reverse();

    if (builderChain.length === 0) {
        throw new Error('Cannot build pipeline without at least one builder.');
    }

    const rootStep = builderChain[0].buildStep(undefined as unknown as Step);
    if (!isPipelineInput(rootStep)) {
        throw new Error('Root builder did not produce a PipelineInput-compatible step.');
    }

    let lastStep: Step = rootStep;
    const sources: Record<string, PipelineInput<unknown, Record<string, unknown>>> = {};

    for (let index = 1; index < builderChain.length; index += 1) {
        const builder = builderChain[index];
        if (builder instanceof EnrichBuilder) {
            const secondaryGraph = buildStepGraph(builder.secondaryLastBuilder, emitDiagnostic);
            sources[builder.sourceName] = secondaryGraph.rootInput;
            lastStep = new EnrichStep(
                lastStep,
                secondaryGraph.lastStep,
                builder.scopeSegments,
                builder.primaryKey,
                builder.asProperty,
                builder.whenMissing,
                emitDiagnostic
            );
            continue;
        }

        lastStep = builder.buildStep(lastStep);
    }

    if (rootStep instanceof InputStep) {
        rootStep.setSources(sources as PipelineSources<Record<string, unknown>>);
    }

    return {
        rootInput: rootStep,
        lastStep
    };
}
