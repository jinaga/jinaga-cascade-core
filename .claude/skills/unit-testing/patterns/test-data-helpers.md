# Test Data Helper Patterns

Comprehensive guide to creating test data factory functions for TypeScript tests.

## Factory Function Pattern

**CRITICAL**: Create factory functions that return properly typed objects with sensible defaults and allow partial overrides.

**Type safety**: Import domain types from the same modules as production. Never invent property names; use the same names as the type so the compiler catches mismatches. Assert only on properties that exist on the public type — not on internal or extended types. See [type-safe-test-data.md](type-safe-test-data.md) for full guidance.

### ✅ CORRECT - Factory Function with Defaults

```typescript
function givenUser(overrides?: Partial<User>): User {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    createdAt: new Date(),
    isActive: true,
    ...overrides
  };
}
```

**Benefits:**
- Type-safe with proper TypeScript types
- Sensible defaults for all properties
- Easy to override specific properties
- Uses faker for realistic random data
- Prevents hardcoded test data collisions

### ❌ WRONG - Hardcoded Test Data

```typescript
// Don't do this
const user = {
  id: '123',
  name: 'Test User',
  email: 'test@example.com'
};
```

**Problems:**
- Hardcoded values create maintenance burden
- Can cause collisions in parallel tests
- Not realistic test data
- Hard to distinguish test cases

### ❌ WRONG - Invented or Outdated Property Names

```typescript
// Don't use property names that don't exist on the real type (e.g. oldName instead of currentName)
const step = { type: 'group-by', groupByFields: ['x'] };   // real type might use selectedProperties
const entity = { id: 'p1', refId: 'r1', internalData: [] }; // public type might not have internalData
```

Always import the domain type and use it (or `Partial<ThatType>`) so the compiler catches mismatches. Assert only on properties that exist on the public type.

## Required vs. Optional Parameters

### Rule: Dependencies Required, Properties Optional

- **Required parameters**: Objects that must exist for the entity to be valid (no default value)
- **Optional overrides**: Properties that can have sensible defaults (via `Partial<T>`)

### Example Pattern

```typescript
interface Show {
  id: string;
  act: Act;
  venue: Venue;
  ticketCount: number;
  startTime: Date;
}

function givenShow(
  act: Act,                              // Required - no default
  venue: Venue,                          // Required - no default
  overrides?: Partial<Pick<Show, 'ticketCount' | 'startTime' | 'id'>>  // Optional - has defaults
): Show {
  return {
    id: faker.string.uuid(),
    act,
    venue,
    ticketCount: 500,
    startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
    ...overrides
  };
}
```

### Why This Pattern?

**Compile-Time Safety:**
```typescript
// This won't compile - forces you to provide required dependencies
const show = givenShow(); // ERROR: Missing required parameters

// This compiles - explicit dependencies
const venue = givenVenue();
const act = givenAct();
const show = givenShow(act, venue); // CORRECT
```

**Visual Clarity:**
```typescript
// Immediately clear what entities are needed
const show = givenShow(act, venue, { ticketCount: 1000 });

// vs. unclear where dependencies come from
const show = givenShow(); // Where do act and venue come from?
```

## Complete Example

```typescript
import { faker } from '@faker-js/faker';

interface Venue {
  id: string;
  name: string;
  seatingCapacity: number;
  description: string;
}

interface Act {
  id: string;
  name: string;
}

interface Show {
  id: string;
  act: Act;
  venue: Venue;
  ticketCount: number;
  startTime: Date;
}

// Root entities can have all defaults
function givenVenue(overrides?: Partial<Venue>): Venue {
  return {
    id: faker.string.uuid(),
    name: faker.company.name() + ' Venue',
    seatingCapacity: 1000,
    description: faker.lorem.sentence(),
    ...overrides
  };
}

function givenAct(overrides?: Partial<Act>): Act {
  return {
    id: faker.string.uuid(),
    name: faker.company.name() + ' Act',
    ...overrides
  };
}

// Child entities require parent objects
function givenShow(
  act: Act,                          // Required parent
  venue: Venue,                      // Required parent
  overrides?: Partial<Pick<Show, 'ticketCount' | 'startTime' | 'id'>>  // Optional properties
): Show {
  return {
    id: faker.string.uuid(),
    act,                             // Required object, not just ID
    venue,                           // Required object, not just ID
    ticketCount: 500,
    startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...overrides
  };
}

// Usage in tests
describe('ShowService', () => {
  it('should create a show with valid data', () => {
    // Given: Create parent entities first
    const venue = givenVenue({ seatingCapacity: 1000 });
    const act = givenAct();
    
    // Then create child with required objects
    const show = givenShow(act, venue, { ticketCount: 500 });
    
    expect(show.act).toBe(act);
    expect(show.venue).toBe(venue);
    expect(show.ticketCount).toBe(500);
  });
});
```

## Benefits Summary

1. **Visual Distinction**: Overridden properties vs. defaults are visually distinct
2. **Simplicity**: No separate builder classes needed; factories are simple functions
3. **Flexibility**: Override only what matters for each test
4. **Explicit Dependencies**: Clear object relationships in test code
5. **Compile-Time Safety**: Missing required dependencies cause compilation errors
6. **Type Safety**: TypeScript ensures correct property types
7. **Clearer Intent**: Reading test code immediately shows what objects are needed
8. **Prevents Bugs**: Can't accidentally create invalid entities

## Anti-Patterns to Avoid

### ❌ Separate Builder Classes

```typescript
// Avoid separate builder classes
class VenueBuilder {
  private name = 'Test Venue';
  
  withName(name: string): this {
    this.name = name;
    return this;
  }
  
  build(): Venue {
    return { name: this.name, /* ... */ };
  }
}

// Usage
const venue = new VenueBuilder()
  .withName('Madison Square Garden')
  .build();
```

**Why avoid?** Adds unnecessary complexity and doesn't provide the visual distinction that factory functions with default parameters offer.

### ❌ Setting Only IDs Instead of Objects

```typescript
// Don't do this
function givenShow(actId: string, venueId: string): Show {
  return {
    id: faker.string.uuid(),
    actId,      // Just an ID, not the full object
    venueId,    // Just an ID, not the full object
    ticketCount: 500
  };
}
```

**Why avoid?** Loses type safety, makes relationships unclear, harder to test with actual objects.

### ❌ All Optional Parameters for Child Entities

```typescript
// Don't do this
function givenShow(
  act?: Act,      // Should be required
  venue?: Venue   // Should be required
): Show {
  return {
    id: faker.string.uuid(),
    act: act ?? givenAct(),
    venue: venue ?? givenVenue()
  };
}
```

**Why avoid?** Hides dependencies, makes test code unclear, loses compile-time safety.

## Using Faker for Realistic Data

```typescript
import { faker } from '@faker-js/faker';

function givenUser(overrides?: Partial<User>): User {
  return {
    id: faker.string.uuid(),
    email: faker.internet.email(),
    name: faker.person.fullName(),
    age: faker.number.int({ min: 18, max: 100 }),
    createdAt: faker.date.past(),
    ...overrides
  };
}
```

**Benefits:**
- Realistic test data
- Reduces collisions in parallel tests
- Better coverage of edge cases
- More maintainable than hardcoded values

## Factory Functions for Arrays

```typescript
function givenUsers(count: number, overrides?: Partial<User>): User[] {
  return Array.from({ length: count }, () => givenUser(overrides));
}

// Usage
const users = givenUsers(5, { isActive: true });
```

## Nested Object Factories

```typescript
interface Order {
  id: string;
  customer: Customer;
  items: OrderItem[];
  total: number;
}

function givenOrder(
  customer: Customer,
  items: OrderItem[] = [],
  overrides?: Partial<Pick<Order, 'total' | 'id'>>
): Order {
  return {
    id: faker.string.uuid(),
    customer,
    items,
    total: items.reduce((sum, item) => sum + item.price, 0),
    ...overrides
  };
}
```

## Container/Repository Helper Classes

When a helper must also **insert data into a repository, store, or container** (not just create an object), express it as a **method of a class** that receives the container via the constructor. This keeps the insertion side effect explicit and co-located with the container it affects.

```typescript
// Pure factory function — creates an object only
function givenProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-1',
    name: 'Test Product',
    price: 10.00,
    category: 'general',
    ...overrides
  };
}

// Repository helper class — creates AND inserts
class GivenProducts {
  constructor(private readonly repository: ProductRepository) {}

  add(overrides: Partial<Product> = {}): Product {
    const product = givenProduct(overrides);
    this.repository.add(product);
    return product;
  }
}
```

**Usage in tests:**
```typescript
describe('ProductService', () => {
  it('should find products by category', () => {
    const repository = new InMemoryProductRepository();
    const given = new GivenProducts(repository);

    given.add({ category: 'electronics' });
    given.add({ category: 'clothing' });

    const results = repository.findByCategory('electronics');
    expect(results).toHaveLength(1);
  });
});
```

**Why a class, not a standalone function?**
- Makes the container dependency explicit — you can't call `given.add()` without first constructing `new GivenProducts(repository)`
- Avoids hidden global state from helpers that capture a container in closure
- Composable: create multiple `Given*` helpers that all share the same container instance

**Contrast with the builder anti-pattern**: This is NOT a fluent builder. It has no `build()` method and no chaining. It's a thin wrapper whose only job is to pair a factory function with an insert operation on a specific container.

## Consolidating Repetitive Setup

Repetitive `beforeEach` blocks that create the same data for every test are a signal to extract a `given*` helper. Tests should only configure the parameters that matter for their specific scenario.

**Before — repeated setup in beforeEach:**
```typescript
describe('OrderService', () => {
  let customer: Customer;
  let order: Order;

  beforeEach(() => {
    customer = { id: 'c1', name: 'Alice' };
    order = { id: 'o1', customer, total: 50 };
  });

  it('should apply discount for high-value orders', () => {
    order = { ...order, total: 200 }; // Has to re-override
    // ...
  });
});
```

**After — given* helpers, each test specifies only what matters:**
```typescript
describe('OrderService', () => {
  it('should apply discount for high-value orders', () => {
    const customer = givenCustomer();
    const order = givenOrder(customer, { total: 200 });
    // ...
  });

  it('should not apply discount for low-value orders', () => {
    const customer = givenCustomer();
    const order = givenOrder(customer, { total: 50 });
    // ...
  });
});
```
