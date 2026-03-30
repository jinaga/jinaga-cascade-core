import type {
    AddedHandler,
    ModifiedHandler,
    RemovedHandler,
    Step,
    StepBuilder,
    TypeDescriptor
} from './pipeline.js';

export class DescriptorStep implements Step {
    constructor(private descriptor: TypeDescriptor) {}

    getTypeDescriptor(): TypeDescriptor {
        return this.descriptor;
    }

    onAdded(_pathSegments: string[], _handler: AddedHandler): void {}

    onRemoved(_pathSegments: string[], _handler: RemovedHandler): void {}

    onModified(
        _pathSegments: string[],
        _propertyName: string,
        _handler: ModifiedHandler
    ): void {}
}

export function getBuilderTypeDescriptor(
    upstream: StepBuilder,
    buildStep: (input: Step) => Step
): TypeDescriptor {
    return buildStep(new DescriptorStep(upstream.getTypeDescriptor())).getTypeDescriptor();
}
