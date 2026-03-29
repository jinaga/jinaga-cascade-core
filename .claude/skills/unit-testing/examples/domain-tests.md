# Domain Logic Testing Examples

Examples of testing TypeScript domain objects, types, and pure functions.

## Testing Domain Objects

Focus on testing business rules and invariants in domain objects.

```typescript
import { describe, it, expect } from 'vitest';
import { Venue } from './venue';
import { givenVenue } from './test-helpers';

describe('Venue', () => {
  it('should deactivate venue', () => {
    // Given: An active venue
    const venue = givenVenue({ isActive: true });
    
    // When: Deactivating the venue
    venue.deactivate();
    
    // Then: Venue is inactive
    expect(venue.isActive).toBe(false);
  });
  
  it('should throw error when adding act to inactive venue', () => {
    // Given: An inactive venue
    const venue = givenVenue({ isActive: false });
    
    // When: Attempting to add an act
    const addAct = () => venue.addAct({
      name: 'Concert A',
      date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      price: 50.00
    });
    
    // Then: Exception is thrown
    expect(addAct).toThrow('Cannot add act to inactive venue');
  });
  
  it('should calculate available seats', () => {
    // Given: A venue with capacity and sold tickets
    const venue = givenVenue({ seatingCapacity: 1000 });
    venue.sellTickets(300);
    
    // When: Getting available seats
    const available = venue.getAvailableSeats();
    
    // Then: Returns correct count
    expect(available).toBe(700);
  });
});
```

## Testing Value Objects and Types

Value objects should be tested for equality, immutability, and validation.

```typescript
import { describe, it, expect } from 'vitest';
import { Address } from './address';

describe('Address', () => {
  it('should be equal when values are the same', () => {
    // Given: Two addresses with same values
    const address1 = new Address({
      street: '123 Main St',
      city: 'City',
      state: 'State',
      zipCode: '12345',
      country: 'USA'
    });
    const address2 = new Address({
      street: '123 Main St',
      city: 'City',
      state: 'State',
      zipCode: '12345',
      country: 'USA'
    });
    
    // When/Then: They should be equal
    expect(address1.equals(address2)).toBe(true);
  });

  it('should not be equal when values differ', () => {
    // Given: Two addresses with different values
    const address1 = new Address({
      street: '123 Main St',
      city: 'City',
      state: 'State',
      zipCode: '12345',
      country: 'USA'
    });
    const address2 = new Address({
      street: '456 Oak Ave',
      city: 'City',
      state: 'State',
      zipCode: '12345',
      country: 'USA'
    });
    
    // When/Then: They should not be equal
    expect(address1.equals(address2)).toBe(false);
  });

  it('should validate zip code format', () => {
    // Given: Invalid zip code
    const createAddress = () => new Address({
      street: '123 Main St',
      city: 'City',
      state: 'State',
      zipCode: 'invalid',
      country: 'USA'
    });
    
    // When/Then: Throws validation error
    expect(createAddress).toThrow('Invalid zip code format');
  });

  it('should be immutable', () => {
    // Given: An address
    const address = new Address({
      street: '123 Main St',
      city: 'City',
      state: 'State',
      zipCode: '12345',
      country: 'USA'
    });
    
    const originalStreet = address.street;
    
    // When: Attempting to modify (if properties are readonly)
    // This would be a compile error if properly typed:
    // address.street = 'New Street'; // Error: Cannot assign to 'street' because it is a read-only property
    
    // Then: Original value is unchanged
    expect(address.street).toBe(originalStreet);
  });
});
```

## Testing Pure Functions

Pure functions are easy to test - same input always produces same output.

```typescript
import { describe, it, expect } from 'vitest';
import { calculateTotal, formatCurrency, validateEmail } from './utils';

describe('calculateTotal', () => {
  it('should sum all items', () => {
    // Given: Array of prices
    const items = [10, 20, 30];
    
    // When: Calculating total
    const result = calculateTotal(items);
    
    // Then: Returns sum
    expect(result).toBe(60);
  });

  it('should return 0 for empty array', () => {
    // Given: Empty array
    const items: number[] = [];
    
    // When: Calculating total
    const result = calculateTotal(items);
    
    // Then: Returns 0
    expect(result).toBe(0);
  });

  it('should handle negative values', () => {
    // Given: Items with negative values
    const items = [10, -5, 20];
    
    // When: Calculating total
    const result = calculateTotal(items);
    
    // Then: Returns correct sum
    expect(result).toBe(25);
  });
});

describe('formatCurrency', () => {
  it('should format number as currency', () => {
    // Given: Amount
    const amount = 1234.56;
    
    // When: Formatting
    const result = formatCurrency(amount);
    
    // Then: Returns formatted string
    expect(result).toBe('$1,234.56');
  });

  it('should handle zero', () => {
    // Given: Zero amount
    const amount = 0;
    
    // When: Formatting
    const result = formatCurrency(amount);
    
    // Then: Returns formatted zero
    expect(result).toBe('$0.00');
  });
});

describe('validateEmail', () => {
  it('should validate correct email format', () => {
    // Given: Valid email
    const email = 'user@example.com';
    
    // When: Validating
    const result = validateEmail(email);
    
    // Then: Returns true
    expect(result).toBe(true);
  });

  it('should reject invalid email format', () => {
    // Given: Invalid email
    const email = 'not-an-email';
    
    // When: Validating
    const result = validateEmail(email);
    
    // Then: Returns false
    expect(result).toBe(false);
  });

  it('should reject empty string', () => {
    // Given: Empty string
    const email = '';
    
    // When: Validating
    const result = validateEmail(email);
    
    // Then: Returns false
    expect(result).toBe(false);
  });
});
```

## Testing Type Guards

```typescript
import { describe, it, expect } from 'vitest';
import { isUser, isAdmin } from './typeGuards';

describe('isUser', () => {
  it('should return true for user object', () => {
    // Given: User object
    const obj = { id: '123', name: 'John', role: 'user' };
    
    // When: Checking type
    const result = isUser(obj);
    
    // Then: Returns true
    expect(result).toBe(true);
    if (result) {
      // TypeScript knows obj is User here
      expect(obj.role).toBe('user');
    }
  });

  it('should return false for non-user object', () => {
    // Given: Non-user object
    const obj = { id: '123', name: 'John' };
    
    // When: Checking type
    const result = isUser(obj);
    
    // Then: Returns false
    expect(result).toBe(false);
  });
});
```

## Testing Business Rules

```typescript
import { describe, it, expect } from 'vitest';
import { Order } from './order';

describe('Order', () => {
  it('should calculate total with tax', () => {
    // Given: Order with items
    const order = new Order({
      items: [
        { name: 'Item 1', price: 10, quantity: 2 },
        { name: 'Item 2', price: 5, quantity: 3 }
      ],
      taxRate: 0.1 // 10%
    });
    
    // When: Getting total
    const total = order.getTotal();
    
    // Then: Returns subtotal + tax
    // Subtotal: (10 * 2) + (5 * 3) = 35
    // Tax: 35 * 0.1 = 3.5
    // Total: 38.5
    expect(total).toBe(38.5);
  });

  it('should apply discount when eligible', () => {
    // Given: Order eligible for discount
    const order = new Order({
      items: [{ name: 'Item', price: 100, quantity: 1 }],
      discountCode: 'SAVE10'
    });
    
    // When: Getting total
    const total = order.getTotal();
    
    // Then: Discount is applied
    expect(total).toBe(90); // 100 - 10%
  });

  it('should not allow negative quantities', () => {
    // Given: Invalid quantity
    const createOrder = () => new Order({
      items: [{ name: 'Item', price: 10, quantity: -1 }]
    });
    
    // When/Then: Throws error
    expect(createOrder).toThrow('Quantity must be positive');
  });
});
```
