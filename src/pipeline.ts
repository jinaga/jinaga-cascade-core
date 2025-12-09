export interface Pipeline<T> {
    add(key: string, immutableProps: T): void;
    remove(key: string, immutableProps: T): void;
}

export interface TypeDescriptor {
    arrays: ArrayDescriptor[];
    objects?: ObjectDescriptor[];
    mutableProperties?: string[];  // Names of properties that can change
}

export interface ArrayDescriptor {
    name: string;
    type: TypeDescriptor;
}

export interface ObjectDescriptor {
    name: string;
    type: TypeDescriptor;
}

/**
 * Get the mutable properties of items within an array at the specified path.
 * Navigates through the TypeDescriptor following the segment path and returns
 * the mutableProperties of the final array's item type.
 *
 * @param descriptor - The root TypeDescriptor to start navigation from
 * @param segmentPath - Array of segment names to navigate (e.g., ['orders'] or ['categories', 'products'])
 * @returns Array of mutable property names, or empty array if path is invalid
 */
export function getMutablePropertiesOfArrayItems(
    descriptor: TypeDescriptor,
    segmentPath: string[]
): string[] {
    let current = descriptor;
    for (const segment of segmentPath) {
        const arrayDesc = current.arrays.find(a => a.name === segment);
        if (!arrayDesc) return [];
        current = arrayDesc.type;
    }
    return current.mutableProperties || [];
}

export type ImmutableProps = {
    [key: string]: any;
};

export type AddedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;

export type RemovedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;

export type ModifiedHandler = (keyPath: string[], key: string, oldValue: any, newValue: any) => void;

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
    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void;
}

