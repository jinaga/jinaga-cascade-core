import { encode as base64Encode } from '@stablelib/base64';
import { hash as sha512Hash } from '@stablelib/sha512';
import { encode as utf8Encode } from '@stablelib/utf8';

export function canonicalizeGroupingProperties(obj: {}, groupingProperties: string[]): string {
    const sortedProps = [...groupingProperties].sort();
    const keyObject: Record<string, any> = {};
    for (const prop of sortedProps) {
        if (prop in obj) {
            keyObject[prop] = (obj as Record<string, any>)[prop];
        }
    }
    return JSON.stringify(keyObject);
}

function computeHash(str: string): string {
    const utf8Bytes = utf8Encode(str);
    const hashBytes = sha512Hash(utf8Bytes);
    return base64Encode(hashBytes);
}

export function computeGroupKey(obj: {}, groupingProperties: string[]): string {
    const canonical = canonicalizeGroupingProperties(obj, groupingProperties);
    return computeHash(canonical);
}

