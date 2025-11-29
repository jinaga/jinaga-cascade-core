export interface Pipeline<T> {
    add(key: string, immutableProps: T): void;
    remove(key: string, immutableProps: T): void;
}

export interface TypeDescriptor {
    arrays: ArrayDescriptor[];
}

export interface ArrayDescriptor {
    name: string;
    type: TypeDescriptor;
}

export type ImmutableProps = {
    [key: string]: any;
};

export type AddedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;

export type RemovedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;

export type ModifiedHandler = (keyPath: string[], key: string, name: string, value: any) => void;

export function getPathSegmentsFromDescriptor(descriptor: TypeDescriptor): string[][] {
    // Include the path to the root of the descriptor
    const paths: string[][] = [[]];
    // Recursively get paths from nested type descriptors
    for (const array of descriptor.arrays) {
        const allChildSegments = getPathSegmentsFromDescriptor(array.type);
        for (const childSegments of allChildSegments) {
            paths.push([array.name, ...childSegments]);
        }
    }
    return paths;
}

export interface Step {
    getTypeDescriptor(): TypeDescriptor;
    onAdded(pathSegments: string[], handler: AddedHandler): void;
    onRemoved(pathSegments: string[], handler: RemovedHandler): void;
    onModified(pathSegments: string[], handler: ModifiedHandler): void;
}

